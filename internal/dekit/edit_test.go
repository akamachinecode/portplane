package dekit

import (
	"errors"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const handWritten = `# My project's tasks.
defaults:
  env:
    NODE_ENV: development

tasks:
  # The database comes first.
  db:
    cmd: [docker, compose, up, db]   # flow style is kept
    ready: {tcp: 5432}

  web:
    label: Website
    cmd:
    - portless
    - shop
    - pnpm
    - dev
    deps: [db]
    env:
      PORT: "3000"  # quoted on purpose

  # Workers.
  worker:
    cmd: ["node", "worker.js"]

load:
- apps/*/tasks.yaml
`

func TestSetKeyTouchesOnlyTheTask(t *testing.T) {
	out, err := SetKey([]byte(handWritten), []string{"tasks", "web"}, "cmd", []string{"portless", "store", "pnpm", "dev"})
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if !strings.Contains(got, "- store") || strings.Contains(got, "- shop") {
		t.Fatalf("cmd not changed:\n%s", got)
	}
	// Everything outside the web block is byte for byte the same.
	before, after := blockAround(handWritten, "  web:", "  # Workers."), blockAround(got, "  web:", "  # Workers.")
	if before[0] != after[0] || before[2] != after[2] {
		t.Fatalf("outside the block changed:\n%s", got)
	}
	for _, keep := range []string{`PORT: "3000" # quoted on purpose`, "label: Website", "deps: [db]"} {
		if !strings.Contains(got, keep) {
			t.Errorf("lost %q:\n%s", keep, got)
		}
	}
	// It still parses to the same tasks.
	var v map[string]any
	if err := yaml.Unmarshal(out, &v); err != nil {
		t.Fatal(err)
	}
}

// blockAround splits s into what is before from, the block, and what is
// from to on.
func blockAround(s, from, to string) [3]string {
	i, j := strings.Index(s, from), strings.Index(s, to)
	return [3]string{s[:i], s[i:j], s[j:]}
}

func TestSetKeyAddsAndRemoves(t *testing.T) {
	out, err := SetKey([]byte(handWritten), []string{"tasks", "worker"}, "autostart", true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "    autostart: true\n") {
		t.Fatalf("not added:\n%s", out)
	}
	out, err = SetKey(out, []string{"tasks", "web"}, "label", nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "Website") {
		t.Fatalf("not removed:\n%s", out)
	}
}

func TestRefusesFlowJSAndAliases(t *testing.T) {
	// A flow mapping can be changed as a whole value, and keeps its style.
	out, err := SetKey([]byte(handWritten), []string{"tasks", "db", "ready"}, "tcp", 5433)
	if err != nil || !strings.Contains(string(out), "ready: {tcp: 5433}") {
		t.Errorf("flow value: %v\n%s", err, out)
	}
	// A key inside it can't be reached line by line.
	if _, err := EditBlock([]byte(handWritten), []string{"tasks", "db", "ready", "tcp"}, func(*yaml.Node) error { return nil }); !errors.Is(err, ErrNotEditable) {
		t.Errorf("inside a flow mapping: %v", err)
	}
	js := "tasks:\n  web:\n    cmd: !js ['a']\n"
	if _, err := SetKey([]byte(js), []string{"tasks", "web"}, "cmd", []string{"b"}); !errors.Is(err, ErrNotEditable) {
		t.Errorf("!js: %v", err)
	}
	alias := "base: &b\n  cmd: [a]\ntasks:\n  web: *b\n"
	if _, err := SetKey([]byte(alias), []string{"tasks", "web"}, "label", "x"); !errors.Is(err, ErrNotEditable) {
		t.Errorf("alias: %v", err)
	}
	if _, err := SetKey([]byte("{tasks: {}}"), []string{"tasks"}, "a", "b"); !errors.Is(err, ErrNotEditable) {
		t.Errorf("flow document: %v", err)
	}
}

func TestInsertDeleteRename(t *testing.T) {
	out, err := InsertEntry([]byte(handWritten), []string{"tasks"}, "api", map[string]any{"cmd": []string{"portless", "api.shop", "pnpm", "dev"}})
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if !strings.Contains(got, "  api:\n    cmd:\n") || strings.Index(got, "  api:") > strings.Index(got, "load:") {
		t.Fatalf("insert:\n%s", got)
	}
	if !strings.HasSuffix(got, "load:\n- apps/*/tasks.yaml\n") {
		t.Fatalf("load changed:\n%s", got)
	}
	out, err = DeleteEntry(out, []string{"tasks", "worker"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "worker") || strings.Contains(string(out), "# Workers.") {
		t.Fatalf("delete:\n%s", out)
	}
	out, err = RenameKey(out, []string{"tasks", "web"}, "site")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "  site:\n    label: Website") || strings.Contains(string(out), "  web:") {
		t.Fatalf("rename:\n%s", out)
	}
	if _, err := RenameKey(out, []string{"tasks", "site"}, "db"); err == nil {
		t.Fatal("renamed onto an existing key")
	}
	var v struct {
		Tasks map[string]any `yaml:"tasks"`
	}
	if err := yaml.Unmarshal(out, &v); err != nil || len(v.Tasks) != 3 {
		t.Fatalf("result does not parse to 3 tasks: %v %v\n%s", err, v.Tasks, out)
	}
}

func TestInsertIntoEmptyAndMissing(t *testing.T) {
	out, err := InsertEntry([]byte("tasks:\n"), []string{"tasks"}, "web", map[string]any{"cmd": []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "tasks:\n  web:\n    cmd:\n      - a\n" {
		t.Fatalf("empty tasks:\n%q", out)
	}
	out, err = InsertEntry([]byte("load:\n  - x.yaml\n"), []string{"tasks"}, "web", map[string]any{"cmd": []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Load  []string       `yaml:"load"`
		Tasks map[string]any `yaml:"tasks"`
	}
	if err := yaml.Unmarshal(out, &v); err != nil || len(v.Load) != 1 || v.Tasks["web"] == nil {
		t.Fatalf("missing tasks: %v\n%s", err, out)
	}
}

func TestEditLastTopLevelBlock(t *testing.T) {
	src := "tasks:\n  a:\n    cmd: [x]\nload:\n- one.yaml\n- two.yaml\n"
	out, err := EditBlock([]byte(src), []string{"load"}, func(v *yaml.Node) error {
		v.Content = v.Content[:1]
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "tasks:\n  a:\n    cmd: [x]\nload:\n  - one.yaml\n" {
		t.Fatalf("got\n%s", out)
	}
}
