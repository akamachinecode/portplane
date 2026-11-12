package dekit

import (
	"strings"
	"testing"
)

func problemsText(ps []Problem) string {
	var b strings.Builder
	for _, p := range ps {
		b.WriteString(p.Path + ": " + p.Message + "\n")
	}
	return b.String()
}

func TestValidateAcceptsRealConfigs(t *testing.T) {
	for _, src := range []string{
		monorepoYAML,
		"",
		"# only a comment\n",
		"tasks: {}\n",
		`kernel: npm
log: {level: debug, file: dekit.log}
defaults:
  cwd: apps
  env: {A: "1", B: null}
  autorestart: on-failure
  stop: {timeout: 30s}
load:
  - services/*.yaml
  - {file: ops/tasks.yaml, at: ops}
on_init: {command: up}
tasks:
  tools/:
    collapsed: true
  tools/lint:
    type: job
    cmd: npm run lint
    tags: [check]
  db:
    cmd: ["postgres", "-D", ".data/db"]
    ready: {log: "ready to accept connections", timeout: 30s}
    stop: SIGINT
  web:
    script: scripts/web.mjs
    ready: {tcp: 4000, interval: 500ms}
    log: {enabled: true, dir: logs, mode: append}
    scrollback_len: 5000
  notify:
    cmd: [./svc]
    ready: {sd_notify: true}
    stop: {keys: ["<C-c>"], timeout: 5s}
  sig:
    cmd: [./svc]
    stop: {signal: SIGTERM, group: false}
`,
	} {
		if ps := ValidateConfig([]byte(src)); len(ps) > 0 {
			t.Errorf("valid config refused:\n%s\n%s", problemsText(ps), src)
		}
	}
}

func TestValidateExplainsProblems(t *testing.T) {
	cases := []struct{ src, path, want string }{
		{"tasks:\n  a:\n    cmd: [x]\n    script: a.js\n", "tasks.a", "only one of cmd, script"},
		{"tasks:\n  a:\n    label: x\n", "tasks.a", "needs one of cmd, script"},
		{"tasks:\n  a:\n    type: job\n    cmd: [x]\n    ready: {log: ok}\n", "tasks.a", "can't have ready"},
		{"tasks:\n  a:\n    type: job\n    cmd: [x]\n    autorestart: always\n", "tasks.a.autorestart", "never, on-failure"},
		{"tasks:\n  a:\n    cmd: [x]\n    autostart: yes please\n", "tasks.a.autostart", "true or false"},
		{"tasks:\n  a:\n    cmd: [x]\n    ready: {tcp: 1, http: http://x}\n", "tasks.a.ready", "only one of tcp, http"},
		{"tasks:\n  a:\n    cmd: [x]\n    ready: {timeout: 5 seconds, log: x}\n", "tasks.a.ready.timeout", "duration"},
		{"tasks:\n  a:\n    cmd: [x]\n    stop: {signal: SIGTERM, keys: [a]}\n", "tasks.a.stop", "only one of signal, keys"},
		{"tasks:\n  a:\n    cmd: [x]\n    colour: red\n", "tasks.a.colour", `"colour" isn't a task setting`},
		{"tasks:\n  a:\n    cmd: [x]\n    tags: [autostart]\n", "tasks.a.tags", "dekit's own"},
		{"tasks:\n  a:\n    cmd: npm run dev && echo hi\n", "tasks.a.cmd", "shell syntax (&)"},
		{"taks:\n  a: {}\n", "taks", `"taks" isn't a dekit.yaml setting`},
		{"tasks:\n  a:\n    cmd: []\n", "tasks.a.cmd", "can't be empty"},
		{"tasks:\n  a:\n    cmd: [x]\n    ready: {http: localhost:3000}\n", "tasks.a.ready.http", "http://"},
		{"kernel: yarn\n", "kernel", "npm"},
	}
	for _, c := range cases {
		ps := ValidateConfig([]byte(c.src))
		found := false
		for _, p := range ps {
			if p.Path == c.path && strings.Contains(p.Message, c.want) {
				found = true
				if p.Line == 0 {
					t.Errorf("%q: no line for %+v", c.src, p)
				}
			}
		}
		if !found {
			t.Errorf("%q: want %s: %q, got:\n%s", c.src, c.path, c.want, problemsText(ps))
		}
	}
}

func TestValidateSyntaxAndJS(t *testing.T) {
	ps := ValidateConfig([]byte("tasks:\n  a: [\n"))
	if len(ps) != 1 || !strings.HasPrefix(ps[0].Message, "not valid YAML") || ps[0].Line == 0 {
		t.Fatalf("syntax: %+v", ps)
	}
	// !js stands for any value: only dekit can evaluate it.
	ok := "tasks:\n  a:\n    cmd: !js '[\"x\"]'\n    env: !js 'ctx.vars.env'\n    ready: !js 'ctx.vars.ready'\n"
	if ps := ValidateConfig([]byte(ok)); len(ps) > 0 {
		t.Fatalf("!js values are not checked: %s", problemsText(ps))
	}
}

func TestShellMetachar(t *testing.T) {
	for in, want := range map[string]string{
		"npm run dev":             "",
		"echo 'a | b'":            "",
		`echo "a | b"`:            "",
		`echo "$HOME"`:            "$",
		"a | b":                   "|",
		"a > out.txt":             ">",
		"node --inspect=9229 x#y": "",
		"run # comment":           "#",
	} {
		if got := ShellMetachar(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}
