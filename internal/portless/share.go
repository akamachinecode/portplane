package portless

import (
	"errors"
	"fmt"
	"strings"
	"unicode"

	"go.yaml.in/yaml/v3"

	"github.com/akamachinecode/portplane/internal/dekit"
)

// Sharing an app (plan §5.8): portless 0.16 shares what it starts when its
// command carries --tailscale (Tailscale Serve, the tailnet), --funnel
// (Tailscale Funnel, the internet), --ngrok or --cloudflare (a Cloudflare
// quick tunnel). The flag goes after the app's name (`portless web
// --tailscale pnpm dev`) or after `run`; portless records the URL it got
// in routes.json (tailscaleUrl, ngrokUrl, cloudflareUrl). Portplane turns a
// share on or off by editing the flag in the task's command, the same way
// a rename edits the name (ADR-0022).

// Share kinds.
const (
	ShareTailscale  = "tailscale"
	ShareFunnel     = "funnel"
	ShareNgrok      = "ngrok"
	ShareCloudflare = "cloudflare"
)

// ShareKinds are every way portless shares an app, in the order the UI
// lists them.
var ShareKinds = []string{ShareTailscale, ShareFunnel, ShareNgrok, ShareCloudflare}

// ValidShareKind reports whether kind is one of ShareKinds.
func ValidShareKind(kind string) bool {
	for _, k := range ShareKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// SharePublic reports whether a share makes the app reachable from the
// internet (everything but the tailnet).
func SharePublic(kind string) bool { return kind != ShareTailscale }

// ShareFlag is the portless flag for a kind.
func ShareFlag(kind string) string { return "--" + kind }

// ShareLabel names a kind for people.
func ShareLabel(kind string) string {
	switch kind {
	case ShareTailscale:
		return "Tailscale"
	case ShareFunnel:
		return "Tailscale Funnel"
	case ShareNgrok:
		return "ngrok"
	case ShareCloudflare:
		return "Cloudflare Tunnel"
	}
	return kind
}

// ShareEnv is the environment variable that turns a kind on for every
// portless command that sees it (PORTLESS_TAILSCALE=1 and so on).
func ShareEnv(kind string) string { return "PORTLESS_" + strings.ToUpper(kind) }

// ShareEnvKinds lists the kinds a task's environment turns on, as portless
// reads them (1, true, yes or on).
func ShareEnvKinds(env map[string]string) []string {
	var out []string
	for _, k := range ShareKinds {
		switch strings.ToLower(strings.TrimSpace(env[ShareEnv(k)])) {
		case "1", "true", "yes", "on":
			out = append(out, k)
		}
	}
	return out
}

// flagSpan finds where portless's own flags go in argv: right after the
// app's name, or after `run` (and its --name and --app-port values). start
// is where a new flag goes and end the first word of the wrapped command.
func flagSpan(argv []string) (start, end int, ok bool) {
	i := indexOfPortless(argv)
	if i < 0 || i+1 >= len(argv) {
		return 0, 0, false
	}
	first := argv[i+1]
	switch {
	case first == "run":
	case strings.HasPrefix(first, "-") || subcommands[first]:
		return 0, 0, false
	}
	start = i + 2
	j := start
	for j < len(argv) && strings.HasPrefix(argv[j], "-") && argv[j] != "--" {
		if (argv[j] == "--app-port" || (first == "run" && argv[j] == "--name")) && j+1 < len(argv) {
			j += 2
			continue
		}
		if first != "run" && !strings.HasPrefix(argv[j], "--") {
			break // a short flag after the name belongs to the command
		}
		j++
	}
	return start, j, true
}

// ShareFlags lists the share kinds argv turns on, in ShareKinds order.
// --funnel counts as Funnel only (portless shares on the tailnet too, but
// as Funnel).
func ShareFlags(argv []string) []string {
	words, _ := unwrapCmd(argv)
	start, end, ok := flagSpan(words)
	if !ok {
		return nil
	}
	on := map[string]bool{}
	for _, a := range words[start:end] {
		if k, ok := strings.CutPrefix(a, "--"); ok && ValidShareKind(k) {
			on[k] = true
		}
	}
	var out []string
	for _, k := range ShareKinds {
		if on[k] {
			out = append(out, k)
		}
	}
	return out
}

// SetShareArgs returns argv with kind turned on or off. Tailscale and
// Funnel replace each other: an app is shared on the tailnet or publicly
// through Funnel, not both.
func SetShareArgs(argv []string, kind string, on bool) ([]string, error) {
	if !ValidShareKind(kind) {
		return nil, fmt.Errorf("unknown share %q", kind)
	}
	start, end, ok := flagSpan(argv)
	if !ok {
		return nil, errors.New("this command doesn't run through portless <name> or portless run")
	}
	drop := map[string]bool{ShareFlag(kind): true}
	if on && kind == ShareTailscale {
		drop[ShareFlag(ShareFunnel)] = true
	}
	if on && kind == ShareFunnel {
		drop[ShareFlag(ShareTailscale)] = true
	}
	out := append([]string{}, argv[:start]...)
	if on {
		out = append(out, ShareFlag(kind))
	}
	for _, a := range argv[start:end] {
		if !drop[a] {
			out = append(out, a)
		}
	}
	return append(out, argv[end:]...), nil
}

// SetShareInCmd returns the dekit file src with kind turned on or off in
// the cmd of the task at key (under tasks:). Only the flags change; a cmd
// written as one string is edited when it has no quotes before the
// wrapped command. Anything else gives dekit.ErrNotEditable.
func SetShareInCmd(src []byte, key string, argv []string, kind string, on bool) ([]byte, error) {
	words, wrapped := unwrapCmd(argv)
	if _, err := SetShareArgs(words, kind, on); err != nil {
		return nil, err
	}
	return dekit.EditBlock(src, []string{"tasks", key}, func(task *yaml.Node) error {
		cmd := taskCmd(task)
		if cmd == nil {
			return dekit.ErrNotEditable
		}
		switch cmd.Kind {
		case yaml.SequenceNode:
			if !wrapped {
				return setShareInSeq(cmd, kind, on)
			}
			// cmd /c "portless web pnpm run dev" on Windows: the command
			// is one item.
			for _, item := range cmd.Content {
				if item.Kind == yaml.ScalarNode && ParseCommand(strings.Fields(item.Value)) != nil {
					v, err := setShareInString(item.Value, kind, on)
					if err != nil {
						return err
					}
					item.Value = v
					return nil
				}
			}
			return dekit.ErrNotEditable
		case yaml.ScalarNode:
			v, err := setShareInString(cmd.Value, kind, on)
			if err != nil {
				return err
			}
			cmd.Value = v
			return nil
		}
		return dekit.ErrNotEditable
	})
}

// taskCmd is the cmd node of a task mapping, or nil when it can't be edited.
func taskCmd(task *yaml.Node) *yaml.Node {
	if task.Kind != yaml.MappingNode {
		return nil
	}
	for j := 0; j+1 < len(task.Content); j += 2 {
		if task.Content[j].Value == "cmd" {
			if c := task.Content[j+1]; c.Tag != "!js" {
				return c
			}
			return nil
		}
	}
	return nil
}

func setShareInSeq(cmd *yaml.Node, kind string, on bool) error {
	words := make([]string, len(cmd.Content))
	for i, item := range cmd.Content {
		if item.Kind != yaml.ScalarNode {
			return dekit.ErrNotEditable
		}
		words[i] = item.Value
	}
	start, end, ok := flagSpan(words)
	if !ok {
		return dekit.ErrNotEditable
	}
	next, err := SetShareArgs(words, kind, on)
	if err != nil {
		return err
	}
	style := cmd.Content[start-1].Style
	var flags []*yaml.Node
	for _, w := range next[start : len(next)-(len(words)-end)] {
		var n *yaml.Node
		for _, old := range cmd.Content[start:end] {
			if old.Value == w {
				n = old // keep the item, comments and all
				break
			}
		}
		if n == nil {
			n = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: w, Style: style}
		}
		flags = append(flags, n)
	}
	content := append([]*yaml.Node{}, cmd.Content[:start]...)
	content = append(content, flags...)
	cmd.Content = append(content, cmd.Content[end:]...)
	return nil
}

// setShareInString edits the flags of a command written as one string,
// changing only the words that change.
func setShareInString(s, kind string, on bool) (string, error) {
	var spans [][2]int
	in := -1
	for i, r := range s {
		if unicode.IsSpace(r) {
			if in >= 0 {
				spans = append(spans, [2]int{in, i})
				in = -1
			}
		} else if in < 0 {
			in = i
		}
	}
	if in >= 0 {
		spans = append(spans, [2]int{in, len(s)})
	}
	words := make([]string, len(spans))
	for i, sp := range spans {
		words[i] = s[sp[0]:sp[1]]
	}
	start, end, ok := flagSpan(words)
	if !ok {
		return "", dekit.ErrNotEditable
	}
	for _, w := range words[:end] {
		if strings.ContainsAny(w, `"'\`) {
			return "", dekit.ErrNotEditable
		}
	}
	next, err := SetShareArgs(words, kind, on)
	if err != nil {
		return "", err
	}
	// Rebuild the flag area only; the rest of the string stays as written.
	head := s[:spans[start-1][1]]
	tail := ""
	if end < len(spans) {
		tail = s[spans[end][0]:]
	}
	flags := next[start : len(next)-(len(words)-end)]
	var b strings.Builder
	b.WriteString(head)
	for _, f := range flags {
		b.WriteString(" ")
		b.WriteString(f)
	}
	if tail != "" {
		b.WriteString(" ")
		b.WriteString(tail)
	}
	return b.String(), nil
}

// ShareURL is the URL routes.json records for a kind on this route, or "".
func (e RouteEntry) ShareURL(kind string) string {
	switch kind {
	case ShareTailscale:
		if !e.TailscaleFunnel {
			return e.TailscaleURL
		}
	case ShareFunnel:
		if e.TailscaleFunnel {
			return e.TailscaleURL
		}
	case ShareNgrok:
		return e.NgrokURL
	case ShareCloudflare:
		return e.CloudflareURL
	}
	return ""
}
