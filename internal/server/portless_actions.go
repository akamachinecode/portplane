package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/envpath"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
	"github.com/akamachinecode/portplane/internal/privileged"
)

// Actions that change portless's state. Each one is first described as a
// plan (what runs, with which arguments, and whether it asks for the
// password); the same plan, built again from the same choices, then runs as
// a job. A step that needs an administrator goes through the system's own
// password dialog (ADR-0020).

// PlanStep is one command of an action.
type PlanStep struct {
	Label string            `json:"label"`
	Argv  []string          `json:"argv,omitempty"` // empty: Portplane does it itself
	Env   map[string]string `json:"env,omitempty"`
	Admin bool              `json:"admin"`
	// Terminal is the same command to run by hand in a terminal.
	Terminal string `json:"terminal,omitempty"`
	// When says when a conditional step runs ("only if …").
	When string `json:"when,omitempty"`
}

// Plan is POST /api/portless/actions/{action}/plan.
type Plan struct {
	Action  string     `json:"action"`
	Title   string     `json:"title"`
	Summary string     `json:"summary"`
	Admin   bool       `json:"admin"`
	Steps   []PlanStep `json:"steps"`
	Notes   []string   `json:"notes,omitempty"`
	// Method is how the password is asked ("" when it can't be: the user
	// runs the Terminal commands by hand instead).
	Method string `json:"method"`
}

type portlessActionRequest struct {
	Options *portless.ProxyOptions `json:"options,omitempty"`
}

// step is a plan step and how to run it.
type step struct {
	PlanStep
	cmd privileged.Command // for Admin steps
	run func(ctx context.Context, r *jobs.Run) error
	// skip, when set, decides at run time to leave the step out.
	skip func(ctx context.Context) bool
}

type action struct {
	plan  Plan
	steps []step
	// after runs once every step succeeded (refresh caches, set a result).
	after func(ctx context.Context, r *jobs.Run)
}

func (p *portlessAPI) plan(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	a, err := p.action(r, r.PathValue("action"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, a.plan)
}

func (p *portlessAPI) run(w http.ResponseWriter, r *http.Request) {
	if !p.needPortless(w) {
		return
	}
	if p.d.Jobs == nil {
		writeError(w, http.StatusNotImplemented, errors.New("jobs are not available"))
		return
	}
	name := r.PathValue("action")
	a, err := p.action(r, name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	names := make([]string, len(a.steps))
	for i, s := range a.steps {
		names[i] = s.Label
	}
	job := p.d.Jobs.Start(jobs.Spec{Kind: "portless." + name, Title: a.plan.Title, Key: "portless", Steps: names, Privileged: a.plan.Admin}, func(ctx context.Context, run *jobs.Run) error {
		defer p.d.Refresh()
		for _, s := range a.steps {
			if s.skip != nil && s.skip(ctx) {
				run.Skip(s.Label)
				continue
			}
			run.Step(s.Label)
			if err := p.runStep(ctx, run, s); err != nil {
				return err
			}
		}
		if a.after != nil {
			a.after(ctx, run)
		}
		return nil
	})
	StartJob(w, job)
}

func (p *portlessAPI) runStep(ctx context.Context, r *jobs.Run, s step) error {
	switch {
	case s.run != nil:
		return s.run(ctx, r)
	case s.Admin:
		r.Logf("$ %s", s.Terminal)
		err := p.d.Elevate(ctx, s.cmd, r)
		switch {
		case errors.Is(err, privileged.ErrDenied):
			return errors.New("the password dialog was closed, so nothing changed")
		case errors.Is(err, privileged.ErrUnavailable):
			return fmt.Errorf("this computer can't show a password dialog here. Run this in a terminal instead:\n%s", s.Terminal)
		}
		return err
	default:
		r.Logf("$ %s", s.Terminal)
		return p.d.Exec(ctx, s.Argv, s.Env, r)
	}
}

// portlessStep runs portless itself, as administrator when admin.
func (p *portlessAPI) portlessStep(label, reason string, admin bool, args ...string) (step, error) {
	c := p.d.Client
	if admin {
		cmd, err := c.AdminCommand(reason, args...)
		if err != nil {
			return step{}, err
		}
		return p.adminStep(label, cmd), nil
	}
	argv := append([]string{c.Path()}, args...)
	s := step{PlanStep: PlanStep{Label: label, Argv: argv, Terminal: shellLine(argv)}}
	s.run = func(ctx context.Context, r *jobs.Run) error {
		r.Logf("$ %s", s.Terminal)
		_, err := c.RunTo(ctx, r, 3*time.Minute, args...)
		return err
	}
	return s, nil
}

func (p *portlessAPI) adminStep(label string, cmd privileged.Command) step {
	return step{
		PlanStep: PlanStep{Label: label, Argv: cmd.Argv, Env: cmd.Env, Admin: true, Terminal: privileged.Terminal(cmd, p.d.GOOS)},
		cmd:      cmd,
	}
}

func shellLine(argv []string) string {
	q := make([]string, len(argv))
	for i, a := range argv {
		q[i] = privileged.ShellQuote(a)
	}
	return strings.Join(q, " ")
}

func (p *portlessAPI) options(req portlessActionRequest, f proxyFacts) (portless.ProxyOptions, error) {
	o := f.options
	if req.Options != nil {
		o = *req.Options
	}
	o.TLDs = cleanTLDs(o.TLDs)
	if err := o.Validate(); err != nil {
		return o, err
	}
	return o, nil
}

func cleanTLDs(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(t)), ".")
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return []string{"localhost"}
	}
	return out
}

func describe(o portless.ProxyOptions) string {
	scheme := "HTTP"
	if o.HTTPS {
		scheme = "HTTPS"
	}
	parts := []string{fmt.Sprintf("port %d with %s", o.Port, scheme)}
	if o.LAN {
		parts = append(parts, "on your network as .local")
	} else if len(o.TLDs) > 0 && (len(o.TLDs) > 1 || o.TLDs[0] != "localhost") {
		parts = append(parts, "for ."+strings.Join(o.TLDs, ", ."))
	}
	return strings.Join(parts, ", ")
}

// action builds the plan and steps of one action from the request.
func (p *portlessAPI) action(r *http.Request, name string) (action, error) {
	var req portlessActionRequest
	if r.ContentLength != 0 {
		if err := decode(r, &req); err != nil {
			return action{}, err
		}
	}
	ctx := r.Context()
	c := p.d.Client
	f := p.facts(ctx)
	a := action{plan: Plan{Action: name, Method: p.d.Method()}}
	add := func(s step, err error) error {
		if err != nil {
			return err
		}
		a.steps = append(a.steps, s)
		return nil
	}
	restartSteps := func(o portless.ProxyOptions) error {
		if f.serviceInstalled() {
			cmd, err := c.ServiceInstallCommand(o)
			if err != nil {
				return err
			}
			a.steps = append(a.steps, p.adminStep("Restart the proxy service", cmd))
			return nil
		}
		if f.state.Responding || f.state.Running {
			if err := add(p.portlessStep("Stop the proxy", "Portplane needs your password to stop the portless proxy.", p.adminToStop(f), "proxy", "stop", "--port", strconv.Itoa(f.state.Port))); err != nil {
				return err
			}
		}
		return add(p.portlessStep("Start the proxy", "Portplane needs your password to start the portless proxy on port "+strconv.Itoa(o.Port)+".", o.NeedsAdmin(), portless.ProxyStartArgs(o)...))
	}

	switch name {
	case "proxy-start":
		o, err := p.options(req, f)
		if err != nil {
			return a, err
		}
		a.plan.Title = "Start the proxy"
		a.plan.Summary = "Starts the portless proxy on " + describe(o) + ". It runs until you stop it or restart the computer; the proxy service starts it with the computer instead."
		if err := add(p.portlessStep("Start the proxy", "Portplane needs your password to start the portless proxy on port "+strconv.Itoa(o.Port)+".", o.NeedsAdmin(), portless.ProxyStartArgs(o)...)); err != nil {
			return a, err
		}
	case "proxy-stop":
		a.plan.Title = "Stop the proxy"
		a.plan.Summary = "Stops the portless proxy. Your apps keep running, but their .localhost addresses stop loading until it starts again."
		if f.serviceInstalled() {
			a.plan.Notes = append(a.plan.Notes, "The proxy service starts it again the next time the computer starts.")
		}
		if err := add(p.portlessStep("Stop the proxy", "Portplane needs your password to stop the portless proxy.", p.adminToStop(f), "proxy", "stop", "--port", strconv.Itoa(f.state.Port))); err != nil {
			return a, err
		}
	case "proxy-restart":
		o, err := p.options(req, f)
		if err != nil {
			return a, err
		}
		a.plan.Title = "Restart the proxy"
		a.plan.Summary = "Stops the portless proxy and starts it again on " + describe(o) + "."
		if err := restartSteps(o); err != nil {
			return a, err
		}
	case "service-install":
		o, err := p.options(req, f)
		if err != nil {
			return a, err
		}
		cmd, err := c.ServiceInstallCommand(o)
		if err != nil {
			return a, err
		}
		if f.serviceInstalled() {
			a.plan.Title = "Reinstall the proxy service"
			a.plan.Summary = "Installs the proxy service again, on " + describe(o) + ", and restarts the proxy. portless keeps the proxy's options in its service, so changing them means reinstalling it."
		} else {
			a.plan.Title = "Install the proxy service"
			a.plan.Summary = "Installs a service that starts the portless proxy on " + describe(o) + " whenever the computer starts, so your .localhost addresses always work."
		}
		a.steps = append(a.steps, p.adminStep(a.plan.Title, cmd))
	case "service-uninstall":
		cmd, err := c.ServiceUninstallCommand()
		if err != nil {
			return a, err
		}
		a.plan.Title = "Remove the proxy service"
		a.plan.Summary = "Stops the proxy and removes its startup service. You can still start the proxy by hand from this page."
		a.steps = append(a.steps, p.adminStep("Remove the proxy service", cmd))
	case "trust":
		cmd, admin, err := c.TrustCommand()
		if err != nil {
			return a, err
		}
		a.plan.Title = "Trust the local certificate"
		a.plan.Summary = "Adds portless's local certificate authority to your system's trusted certificates, so browsers show the padlock for your .localhost addresses. portless creates it first if it doesn't exist."
		if p.d.GOOS == "darwin" {
			a.plan.Notes = append(a.plan.Notes, "macOS asks for your password to change the login keychain.")
		}
		if admin {
			a.steps = append(a.steps, p.adminStep("Trust the local certificate", cmd))
		} else if err := add(p.portlessStep("Trust the local certificate", "", false, portless.TrustArgs()...)); err != nil {
			return a, err
		}
	case "ca-regenerate":
		a.plan.Title = "Regenerate the local certificate"
		a.plan.Summary = "Replaces portless's local certificate authority with a new one and trusts it. Browsers and devices that trusted the old one by hand (a phone, another computer) must trust the new one again."
		backup := step{PlanStep: PlanStep{Label: "Move the current certificate aside"}}
		backup.run = func(_ context.Context, r *jobs.Run) error {
			dir, err := c.BackupCA(p.d.Now())
			if err != nil {
				return err
			}
			if dir != "" {
				r.Logf("Moved the old certificate and the certificates it signed to %s", dir)
			}
			return nil
		}
		a.steps = append(a.steps, backup)
		cmd, admin, err := c.TrustCommand()
		if err != nil {
			return a, err
		}
		if admin {
			a.steps = append(a.steps, p.adminStep("Create and trust a new certificate", cmd))
		} else if err := add(p.portlessStep("Create and trust a new certificate", "", false, portless.TrustArgs()...)); err != nil {
			return a, err
		}
		if f.state.Responding {
			if err := restartSteps(f.options); err != nil {
				return a, err
			}
		}
		a.plan.Notes = append(a.plan.Notes, "Nothing is deleted: the old files move to a ca-backup folder in "+c.StateDir+".")
	case "ca-fix-ownership":
		ca := c.CA()
		if !ca.SystemCopyNotRoot {
			return a, errors.New("the system's copy of the certificate already belongs to the administrator")
		}
		cmd, err := portless.FixOwnershipCommand(ca.SystemCopy)
		if err != nil {
			return a, err
		}
		a.plan.Title = "Give the trusted certificate back to the administrator"
		a.plan.Summary = "The copy of the certificate your system trusts belongs to your user, so any program you run could replace it with another one. This makes the administrator its owner again."
		a.steps = append(a.steps, p.adminStep("Fix the certificate's owner", cmd))
	case "hosts-sync", "hosts-clean":
		verb := strings.TrimPrefix(name, "hosts-")
		cmd, err := c.HostsCommand(verb)
		if err != nil {
			return a, err
		}
		if verb == "sync" {
			a.plan.Title = "Sync the hosts file"
			a.plan.Summary = "Writes every route's hostname into portless's block of " + portless.HostsPath() + ", so the system finds them for domains other than .localhost."
		} else {
			a.plan.Title = "Clean the hosts file"
			a.plan.Summary = "Removes portless's block from " + portless.HostsPath() + ". Nothing else in the file changes."
		}
		a.steps = append(a.steps, p.adminStep(a.plan.Title, cmd))
	case "prune", "prune-force":
		force := name == "prune-force"
		if force {
			a.plan.Title = "Force-stop orphaned servers"
			a.plan.Summary = "Removes routes whose portless process is gone and kills the dev servers still holding their ports at once (SIGKILL). Unsaved work in those servers is lost."
		} else {
			a.plan.Title = "Clean up stale addresses"
			a.plan.Summary = "Removes routes whose portless process is gone, and asks the dev servers still holding their ports to stop (SIGTERM)."
		}
		s, err := p.portlessStep(a.plan.Title, "", false, portless.PruneArgs(force)...)
		if err != nil {
			return a, err
		}
		args := portless.PruneArgs(force)
		s.run = func(ctx context.Context, r *jobs.Run) error {
			r.Logf("$ %s", s.Terminal)
			out, err := c.RunTo(ctx, r, time.Minute, args...)
			r.SetResult(portless.ParsePrune(out))
			return err
		}
		a.steps = append(a.steps, s)
	case "tailscale-operator":
		if err := p.tailscaleOperatorAction(&a); err != nil {
			return a, err
		}
	case "update":
		if err := p.updateAction(&a, f); err != nil {
			return a, err
		}
	case "uninstall":
		if err := p.uninstallAction(&a); err != nil {
			return a, err
		}
	default:
		return a, fmt.Errorf("unknown portless action %q", name)
	}
	for _, s := range a.steps {
		a.plan.Steps = append(a.plan.Steps, s.PlanStep)
		a.plan.Admin = a.plan.Admin || s.Admin
	}
	return a, nil
}

func (p *portlessAPI) toolStep(label string, t *portless.ToolCommand) step {
	if t.Admin {
		env := privileged.UserEnv()
		for k, v := range t.Env {
			env[k] = v
		}
		return p.adminStep(label, privileged.Command{Argv: t.Argv, Env: env, Reason: "Portplane needs your password to change portless, which is installed for every user."})
	}
	s := step{PlanStep: PlanStep{Label: label, Argv: t.Argv, Env: t.Env, Terminal: envLine(t.Env) + shellLine(t.Argv)}}
	return s
}

// envLine shows extra variables before a command; a PATH that only adds
// a folder in front shows as that folder and $PATH.
func envLine(env map[string]string) string {
	if len(env) == 0 {
		return ""
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	sep := string(os.PathListSeparator)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := env[k]
		if k == "PATH" && strings.HasSuffix(v, sep+os.Getenv("PATH")) {
			v = strings.TrimSuffix(v, os.Getenv("PATH")) + "$PATH"
		}
		parts = append(parts, privileged.ShellQuote(k+"="+v))
	}
	return "env " + strings.Join(parts, " ") + " "
}

func (p *portlessAPI) updateAction(a *action, f proxyFacts) error {
	c := p.d.Client
	in := portless.DetectInstall(c.Path(), p.d.Lookup)
	if in.Update == nil {
		return fmt.Errorf("can't tell how portless was installed (%s): update it the way you installed it", in.Bin)
	}
	a.plan.Title = "Update portless"
	a.plan.Summary = "Updates portless to its latest version with " + originLabel(in.Origin) + "."
	before, _ := c.Version(context.Background())
	a.steps = append(a.steps, p.toolStep("Update portless", in.Update))
	check := step{PlanStep: PlanStep{Label: "Check the new version"}}
	check.run = func(ctx context.Context, r *jobs.Run) error {
		envpath.Refresh()
		v, err := c.Version(ctx)
		if err != nil {
			return fmt.Errorf("portless doesn't run after the update: %w", err)
		}
		if v == before {
			r.Logf("portless %s is already the latest version.", v)
		} else {
			r.Logf("portless %s → %s", before, v)
		}
		r.SetResult(map[string]string{"before": before, "after": v})
		return nil
	}
	a.steps = append(a.steps, check)
	if f.serviceInstalled() {
		cmd, err := c.ServiceInstallCommand(f.options)
		if err == nil {
			s := p.adminStep("Reinstall the proxy service", cmd)
			s.When = "Only if the service still starts the old version (its Node.js or portless files are gone or moved)."
			s.skip = func(ctx context.Context) bool {
				st, err := c.ServiceStatus(ctx)
				if err != nil || !st.Installed {
					return true
				}
				prog, ok := portless.ReadServiceProgram(st.Entry)
				if !ok {
					return true
				}
				now := portless.DetectInstall(c.Path(), p.d.Lookup)
				return !prog.NodeMissing && !prog.ScriptMissing && (now.Script == "" || now.Script == prog.Script)
			}
			a.steps = append(a.steps, s)
		}
	}
	return nil
}

func (p *portlessAPI) uninstallAction(a *action) error {
	c := p.d.Client
	in := portless.DetectInstall(c.Path(), p.d.Lookup)
	a.plan.Title = "Uninstall portless"
	a.plan.Summary = "Cleans up everything portless set up on this computer, then removes the portless program. Your apps, dekit.yaml and portless.json files stay as they are; apps lose their .localhost addresses."
	a.plan.Notes = portless.CleanRemoves(c.StateDir, portless.HostsPath())
	cmd, err := c.AdminCommand("Portplane needs your password to remove portless's service, certificate and hosts entries.", "clean")
	if err != nil {
		return err
	}
	a.steps = append(a.steps, p.adminStep("Clean up portless", cmd))
	if in.Uninstall != nil {
		a.plan.Notes = append(a.plan.Notes, "Removes the portless program with "+originLabel(in.Origin)+".")
		a.steps = append(a.steps, p.toolStep("Remove the portless program", in.Uninstall))
	} else {
		a.plan.Notes = append(a.plan.Notes, "Portplane can't tell how portless was installed, so it leaves the program at "+in.Bin+"; remove it the way you installed it.")
	}
	a.after = func(_ context.Context, _ *jobs.Run) { envpath.Refresh() }
	return nil
}

func originLabel(origin string) string {
	switch origin {
	case portless.OriginHomebrew:
		return "Homebrew"
	case portless.OriginPortplane:
		return "Portplane's own copy of npm"
	case portless.OriginNPM:
		return "npm"
	case portless.OriginPNPM:
		return "pnpm"
	case portless.OriginBun:
		return "Bun"
	case portless.OriginVolta:
		return "Volta"
	}
	return "the tool that installed it"
}
