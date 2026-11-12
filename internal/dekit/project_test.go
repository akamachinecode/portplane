package dekit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadProject(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"dekit.yaml":            "kernel: npm\nvars:\n  port: 4000\nload:\n  - .portplane/tasks.yaml\n  - {file: ops/tasks.yaml, at: ops}\ntasks:\n  web:\n    cmd: [pnpm, run, dev]\n    env: !js 'ctx.vars'\n  flow: {cmd: [x]}\n",
		".portplane/tasks.yaml": "tasks:\n  api:\n    cwd: ../apps/api\n    cmd: [pnpm, run, dev]\n",
		"ops/tasks.yaml":        "tasks:\n  db:\n    cmd: [postgres]\n",
	})
	pc, err := ReadProject(root, "")
	if err != nil {
		t.Fatal(err)
	}
	roles := []string{}
	for _, f := range pc.Files {
		roles = append(roles, f.Rel+":"+f.Role)
		if !f.Exists || f.Digest == "" || !f.Editable {
			t.Errorf("file %+v", f)
		}
	}
	if !reflect.DeepEqual(roles, []string{"dekit.yaml:main", ".portplane/tasks.yaml:portplane", "ops/tasks.yaml:fragment"}) {
		t.Fatalf("files %v", roles)
	}
	paths := map[string]TaskEntry{}
	for _, e := range pc.Tasks {
		paths[e.Path] = e
	}
	if paths["ops/db"].Key != "db" || paths["ops/db"].File != filepath.Join(root, "ops", "tasks.yaml") {
		t.Fatalf("mounted task %+v", paths["ops/db"])
	}
	if !paths["web"].Editable || paths["flow"].Editable || paths["flow"].Problem == "" {
		t.Fatalf("editable: %+v %+v", paths["web"], paths["flow"])
	}
	b, _ := json.Marshal(paths["web"].Values)
	if string(b) != `{"cmd":["pnpm","run","dev"],"env":{"$js":"ctx.vars"}}` {
		t.Fatalf("values %s", b)
	}
	if len(pc.Load) != 2 || pc.Load[1].At != "ops" {
		t.Fatalf("load %+v", pc.Load)
	}
	sb, _ := json.Marshal(pc.Settings)
	if string(sb) != `{"kernel":"npm","vars":{"port":4000}}` || pc.Text["vars"] != "vars:\n  port: 4000\n" {
		t.Fatalf("settings %s %q", sb, pc.Text["vars"])
	}
}

func TestReadProjectWithoutFragment(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{"dekit.yaml": "tasks: {web: {cmd: [x]}}\n"})
	pc, err := ReadProject(root, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(pc.Files) != 2 || pc.Files[1].Role != "portplane" || pc.Files[1].Exists || !pc.Files[1].Editable {
		t.Fatalf("the fragment is listed, to be created: %+v", pc.Files)
	}
	if len(pc.Tasks) != 1 || pc.Tasks[0].Editable || !strings.Contains(pc.Tasks[0].Problem, "flow style") {
		t.Fatalf("tasks in a flow mapping are read-only: %+v", pc.Tasks)
	}
	writeFiles(t, root, map[string]string{"dekit.yaml": "{tasks: {web: {cmd: [x]}}}\n"})
	pc, _ = ReadProject(root, "")
	if pc.Files[0].Editable || !strings.Contains(pc.Files[0].Problem, "flow style") {
		t.Fatalf("a flow-style file is edited as text only: %+v", pc.Files[0])
	}
}
