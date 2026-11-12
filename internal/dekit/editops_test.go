package dekit

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const monorepoYAML = `# Dev servers for my-monorepo.
vars:
  shared: {NODE_ENV: development}

tasks:
  # Installs once for every app.
  install:
    type: job
    cmd: [pnpm, install, --frozen-lockfile]

  web:
    label: Web # the storefront
    cwd: apps/web
    cmd: ["portless", "my-monorepo", "pnpm", "run", "dev"]
    deps: [install]
    env: !js '({...ctx.vars.shared, FOO: "bar"})'

  api:
    cwd: apps/api
    cmd: [pnpm, run, dev]
    ready: {log: "ready in"}
`

// changedLines returns the lines of b that are not in a, in order.
func changedLines(a, b string) []string {
	have := map[string]int{}
	for _, l := range strings.Split(a, "\n") {
		have[l]++
	}
	var out []string
	for _, l := range strings.Split(b, "\n") {
		if have[l] > 0 {
			have[l]--
			continue
		}
		out = append(out, l)
	}
	return out
}

func TestSetOnlyChangesTheEditedKey(t *testing.T) {
	out, err := ApplyOps([]byte(monorepoYAML), []EditOp{
		{Op: "set", Path: []string{"tasks", "api"}, Key: "cmd", Value: json.RawMessage(`["pnpm","run","start"]`)},
		{Op: "set", Path: []string{"tasks", "api"}, Key: "autorestart", Value: json.RawMessage(`"on-failure"`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if !strings.Contains(got, "    cmd: [pnpm, run, start]\n") || !strings.Contains(got, "    autorestart: on-failure\n") {
		t.Fatalf("api not updated:\n%s", got)
	}
	// Everything outside the api block is byte for byte the same.
	head, _, _ := strings.Cut(monorepoYAML, "  api:")
	if !strings.HasPrefix(got, head) {
		t.Fatalf("lines before the block changed:\n%s", got)
	}
	if ch := changedLines(monorepoYAML, got); len(ch) != 2 {
		t.Fatalf("expected two new lines, got %q", ch)
	}
}

func TestSetRefusesJS(t *testing.T) {
	_, err := ApplyOps([]byte(monorepoYAML), []EditOp{{Op: "set", Path: []string{"tasks", "web"}, Key: "env", Value: json.RawMessage(`{"A":"1"}`)}})
	if !errors.Is(err, ErrNotEditable) {
		t.Fatalf("a !js value is not rewritten: %v", err)
	}
	// Other keys of the same task can change, and the !js line stays.
	out, err := ApplyOps([]byte(monorepoYAML), []EditOp{{Op: "set", Path: []string{"tasks", "web"}, Key: "label", Value: json.RawMessage(`"Shop"`)}})
	if err == nil {
		if !strings.Contains(string(out), `env: !js '({...ctx.vars.shared, FOO: "bar"})'`) {
			t.Fatalf("the !js line changed:\n%s", out)
		}
	} else if !errors.Is(err, ErrNotEditable) {
		t.Fatal(err)
	}
}

func TestInsertDuplicateRenameMove(t *testing.T) {
	src := []byte(monorepoYAML)
	// Duplicate web as web-2 right after it.
	out, err := ApplyOps(src, []EditOp{{Op: "insert", Path: []string{"tasks"}, Key: "web-2", After: "web", Value: json.RawMessage(`{"cwd":"apps/web","cmd":["pnpm","run","dev"],"deps":["install"]}`)}})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Index(s, "  web:") > strings.Index(s, "  web-2:") || strings.Index(s, "  web-2:") > strings.Index(s, "  api:") {
		t.Fatalf("web-2 not after web:\n%s", s)
	}
	if !strings.Contains(s, "  web-2:\n    cwd: apps/web\n    cmd: [pnpm, run, dev]\n    deps: [install]\n") {
		t.Fatalf("web-2 block:\n%s", s)
	}
	// Move api before install, with nothing else changing.
	out, err = ApplyOps([]byte(monorepoYAML), []EditOp{{Op: "move", Path: []string{"tasks", "api"}, Before: "install"}})
	if err != nil {
		t.Fatal(err)
	}
	s = string(out)
	if strings.Index(s, "  api:") > strings.Index(s, "  # Installs once") || strings.Index(s, "  # Installs once") > strings.Index(s, "  install:") {
		t.Fatalf("api not moved before install and its comment:\n%s", s)
	}
	if len(changedLines(monorepoYAML, s)) != 0 || len(changedLines(s, monorepoYAML)) != 0 || len(s) != len(monorepoYAML) {
		t.Fatalf("a move only reorders lines:\n%s", s)
	}
	// Move install after api: its comment goes with it.
	out, err = ApplyOps([]byte(monorepoYAML), []EditOp{{Op: "move", Path: []string{"tasks", "install"}, After: "api"}})
	if err != nil {
		t.Fatal(err)
	}
	s = string(out)
	if !strings.HasSuffix(s, "    ready: {log: \"ready in\"}\n\n  # Installs once for every app.\n  install:\n    type: job\n    cmd: [pnpm, install, --frozen-lockfile]\n") || !strings.HasPrefix(s, "# Dev servers for my-monorepo.\nvars:\n  shared: {NODE_ENV: development}\n\ntasks:\n  web:\n") {
		t.Fatalf("install not at the end with its comment:\n%s", s)
	}
	// Rename keeps the value and the comment on the label.
	out, err = ApplyOps([]byte(monorepoYAML), []EditOp{{Op: "rename", Path: []string{"tasks", "web"}, To: "shop"}})
	if err != nil || !strings.Contains(string(out), "  shop:\n    label: Web # the storefront\n") {
		t.Fatalf("rename: %v\n%s", err, out)
	}
}

func TestReplaceEntryText(t *testing.T) {
	out, err := ReplaceEntryText([]byte(monorepoYAML), []string{"vars"}, "vars:\n  shared: {NODE_ENV: test}\n  port: 4000\n")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(out), "# Dev servers for my-monorepo.\nvars:\n  shared: {NODE_ENV: test}\n  port: 4000\n\ntasks:\n") {
		t.Fatalf("vars:\n%s", out)
	}
	if _, err := ReplaceEntryText([]byte(monorepoYAML), []string{"vars"}, "other: 1\n"); err == nil {
		t.Fatal("the text must keep the entry's key")
	}
	if _, err := ReplaceEntryText([]byte(monorepoYAML), []string{"vars"}, "vars: [\n"); err == nil {
		t.Fatal("invalid YAML is refused")
	}
	// !js text is written as typed.
	out, err = ReplaceEntryText([]byte(monorepoYAML), []string{"tasks", "web"}, "web:\n  cmd: !js '[\"a\"]'\n")
	if err != nil || !strings.Contains(string(out), "  web:\n    cmd: !js '[\"a\"]'\n\n  api:") {
		t.Fatalf("task text: %v\n%s", err, out)
	}
}

func TestAppendLoad(t *testing.T) {
	out, err := AppendLoad([]byte("tasks:\n  a:\n    cmd: [x]\n"), PortplaneFragment, "")
	if err != nil || string(out) != "tasks:\n  a:\n    cmd: [x]\nload:\n  - .portplane/tasks.yaml\n" {
		t.Fatalf("new load: %v %q", err, out)
	}
	src := "load:\n  - services/*.yaml\n  - {file: ops/x.yaml, at: ops}\ntasks: {}\n"
	out, err = AppendLoad([]byte(src), "more.yaml", "extra")
	if err != nil || string(out) != "load:\n  - services/*.yaml\n  - {file: ops/x.yaml, at: ops}\n  - {file: more.yaml, at: extra}\ntasks: {}\n" {
		t.Fatalf("append: %v %q", err, out)
	}
	if again, _ := AppendLoad(out, "more.yaml", ""); string(again) != string(out) {
		t.Fatal("a file already loaded is not added twice")
	}
	if _, err := AppendLoad([]byte("load: [a.yaml]\n"), "b.yaml", ""); !errors.Is(err, ErrNotEditable) {
		t.Fatalf("a flow list is left to the user: %v", err)
	}
}

func TestJSONNodeKeepsOrderAndJS(t *testing.T) {
	out, err := ApplyOps([]byte("tasks:\n  a:\n    cmd: [x]\n"), []EditOp{{Op: "set", Path: []string{"tasks", "a"}, Key: "env", Value: json.RawMessage(`{"ZED":"1","ALPHA":null,"PORT":"4000","LONG_VALUE_NUMBER_ONE":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","OTHER":"bbbbbbbbbbbbbbbbbbbbbbb"}`)}})
	if err != nil {
		t.Fatal(err)
	}
	want := "    env:\n      ZED: \"1\"\n      ALPHA: null\n      PORT: \"4000\"\n"
	if !strings.Contains(string(out), want) {
		t.Fatalf("env order and quoting:\n%s", out)
	}
	n, err := JSONNode(json.RawMessage(`{"$js":"ctx.vars.port"}`))
	if err != nil || n.Tag != "!js" || n.Value != "ctx.vars.port" {
		t.Fatalf("$js: %+v %v", n, err)
	}
	if _, err := JSONNode(json.RawMessage(`{"a":1} x`)); err == nil {
		t.Fatal("trailing data is refused")
	}
}

func TestDeleteAndUnset(t *testing.T) {
	out, err := ApplyOps([]byte(monorepoYAML), []EditOp{{Op: "delete", Path: []string{"tasks", "install"}}, {Op: "unset", Path: []string{"tasks", "api"}, Key: "ready"}})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, "install:\n") || strings.Contains(s, "Installs once") || strings.Contains(s, "ready:") {
		t.Fatalf("delete and unset:\n%s", s)
	}
	if !strings.Contains(s, "deps: [install]") {
		t.Fatal("other tasks are not touched")
	}
}
