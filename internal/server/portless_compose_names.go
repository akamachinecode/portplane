package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/portless"
)

// Renaming a compose service's address (plan §5.4, M5.6): its name is the
// portless.name label in the project's compose file. Portplane changes the
// label behind a diff, starts the project again so portless registers the
// new address, and removes the old one.

// resolveRoute finds where the name of the route at hostname lives. Only
// compose routes are renamed by address; apps and aliases have their own
// way in.
func (p *portlessAPI) resolveRoute(ctx context.Context, hostname string) (*renameCtx, error) {
	routes, err := p.d.Client.RouteStates()
	if err != nil {
		return nil, err
	}
	var route *portless.RouteState
	for i := range routes {
		if routes[i].Hostname == hostname {
			route = &routes[i]
		}
	}
	if route == nil {
		return nil, fmt.Errorf("there's no route %s any more", hostname)
	}
	if route.Kind != portless.KindCompose {
		return nil, errors.New("only a compose service's address is renamed by its route; rename an app from its own page and an alias from Aliases")
	}
	rc := &renameCtx{proxy: p.d.Client.ProxyState(ctx)}
	rc.info = NameInfo{Source: portless.SourceCompose, Hostname: hostname, TLD: rc.proxy.MainTLD(), Taken: []string{}, Notes: []string{}, Route: hostname}
	for _, r := range routes {
		if r.Hostname != hostname {
			rc.info.Taken = append(rc.info.Taken, r.Hostname)
		}
	}
	sort.Strings(rc.info.Taken)
	p.composeName(ctx, rc, *route)
	rc.app.ID, rc.app.Label = "route:"+hostname, rc.info.Service
	return rc, nil
}

// composeName fills a rename of a compose route: the project, the service
// and its file, and whether Portplane can change the label.
func (p *portlessAPI) composeName(ctx context.Context, rc *renameCtx, r portless.RouteState) {
	info := &rc.info
	info.Source, info.Compose = portless.SourceCompose, r.Compose
	info.Name = portless.BaseName(r.Hostname, rc.proxy.TLDs)
	info.Editable = false
	projects, _ := p.d.Client.ComposeProjects()
	for i := range projects {
		if projects[i].Name == r.Compose {
			rc.compose = &projects[i]
		}
	}
	if rc.compose == nil {
		info.Reason = "portless no longer has this compose project's state. Change the service's portless.name label in its compose file."
		return
	}
	svc, ok := rc.compose.ServiceFor(r.Hostname, r.Port)
	if !ok {
		info.Reason = "Portplane can't tell which service of " + rc.compose.Name + " this address belongs to. Change its portless.name label in the compose file."
		return
	}
	rc.service = svc
	info.Service, info.Name = svc.Name, svc.Label
	info.Suffix = rc.compose.Label + "." + info.TLD
	listening := map[int]bool{}
	for _, l := range p.d.Listeners(ctx) {
		listening[l.Port] = true
	}
	for _, port := range rc.compose.Ports {
		if listening[port] {
			info.Running = true
		}
	}
	file, _ := p.composeFile(ctx, *rc.compose)
	if file == "" {
		info.Reason = "Portplane can't find " + rc.compose.Name + "'s compose file. Set the portless.name label of the " + svc.Name + " service there to change the name, or start the project from Domains → Compose with its file so Portplane knows it."
		return
	}
	info.File, info.Dir = file, filepath.Dir(file)
	src, err := os.ReadFile(file)
	if err != nil {
		info.Reason = "Portplane can't read " + file + "."
		return
	}
	if _, err := portless.SetComposeName(src, svc.Name, "portplane-check"); err != nil {
		if errors.Is(err, dekit.ErrNotEditable) {
			info.Reason = "The " + svc.Name + " service is written in a way Portplane won't rewrite (an anchor, a merge key or a flow mapping). Set its portless.name label in " + filepath.Base(file) + " in your editor."
		} else {
			info.Reason = err.Error()
		}
		return
	}
	info.Editable = true
	if svc.NameLabel == "" {
		info.Notes = append(info.Notes, "Portplane adds a portless.name label to the "+svc.Name+" service; the service itself keeps its name.")
	}
}

func (p *portlessAPI) planComposeRename(rc *renameCtx, raw string) (NamePreview, error) {
	info := rc.info
	name := strings.ToLower(strings.TrimSpace(raw))
	name = strings.TrimSuffix(name, "."+info.Suffix)
	pv := NamePreview{Name: name, Files: []FileEdit{}, Steps: []string{}, Warnings: []string{}}
	if !info.Editable {
		pv.Problem = info.Reason
		return pv, nil
	}
	if prob := portless.ComposeNameProblem(name); prob != "" {
		pv.Problem = prob
		return pv, nil
	}
	pv.Hostname = name + "." + info.Suffix
	pv.URL = rc.proxy.URL(pv.Hostname)
	if name == info.Name {
		pv.Problem = "That's the name it has now."
		return pv, nil
	}
	for _, s := range rc.compose.Services {
		if s.Name != rc.service.Name && s.Label == name {
			pv.Problem = "The " + s.Name + " service of this project already has that name."
			return pv, nil
		}
	}
	for _, t := range info.Taken {
		if t == pv.Hostname {
			pv.Problem = pv.Hostname + " is already used by another route."
			return pv, nil
		}
	}
	src, err := os.ReadFile(info.File)
	if err != nil {
		return pv, err
	}
	after, err := portless.SetComposeName(src, rc.service.Name, name)
	if err != nil {
		if errors.Is(err, dekit.ErrNotEditable) {
			pv.Problem = info.Reason
			if pv.Problem == "" {
				pv.Problem = dekit.ErrNotEditable.Error()
			}
			return pv, nil
		}
		return pv, err
	}
	pv.Files = append(pv.Files, FileEdit{Path: info.File, Before: string(src), After: string(after), Changed: true})
	pv.Steps = append(pv.Steps, "Write "+filepath.Base(info.File))
	if info.Running {
		pv.Steps = append(pv.Steps, "Start "+info.Compose+" again with the new name", "Remove the old address")
	} else {
		pv.Warnings = append(pv.Warnings, info.Compose+" isn't running: the new name applies the next time it starts.")
	}
	if len(rc.service.Hostnames(info.Compose, info.TLD)) > 1 {
		pv.Warnings = append(pv.Warnings, "The service routes several ports, so its <port>."+name+"."+info.Suffix+" addresses change too.")
	}
	pv.Digest = editsDigest(pv.Files)
	return pv, nil
}

// restartCompose starts the project again (portless registers the new
// names) and removes the old ones, which portless keeps while their port
// still answers.
func (p *portlessAPI) restartCompose(ctx context.Context, run *jobs.Run, rc *renameCtx) error {
	info, c := rc.info, p.d.Client
	run.Step("Start " + info.Compose + " again with the new name")
	args := portless.ComposeUpArgs(info.Compose, info.File)
	run.Logf("$ %s", shellLine(append([]string{c.Path()}, args...)))
	if _, err := c.ComposeRun(ctx, filepath.Dir(info.File), run, args...); err != nil {
		return err
	}
	run.Step("Remove the old address")
	for _, tld := range rc.proxy.TLDs {
		for _, h := range rc.service.Hostnames(info.Compose, tld) {
			if _, err := c.RemoveAliasOutput(ctx, h); err == nil {
				run.Logf("Removed %s", h)
			}
		}
	}
	return nil
}
