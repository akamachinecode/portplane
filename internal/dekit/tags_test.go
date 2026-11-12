package dekit

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoadConfigTags(t *testing.T) {
	root := t.TempDir()
	yaml := `tasks:
  api:
    cmd: [node, server.js]
    tags: [backend, db]
    autostart: true
  web:
    cmd: [vite]
    tags: !js "['x']"
  docs:
    cmd: [vite]
`
	if err := os.WriteFile(filepath.Join(root, ConfigFile), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Task("api").Tags; !reflect.DeepEqual(got, []string{"backend", "db"}) {
		t.Fatalf("api tags %v", got)
	}
	if got := cfg.Task("web").Tags; got != nil {
		t.Fatalf("!js tags must stay unknown: %v", got)
	}
	if got := cfg.Task("docs").Tags; got != nil {
		t.Fatalf("docs tags %v", got)
	}
}
