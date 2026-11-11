package main

import (
	"bytes"
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func TestVersion(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if !strings.HasPrefix(out.String(), "portplane ") {
		t.Fatalf("unexpected output %q", out.String())
	}
}

func TestVersionJSON(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version", "--json"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	var got struct{ Version, OS, Arch string }
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Version == "" || got.OS != runtime.GOOS || got.Arch != runtime.GOARCH {
		t.Fatalf("unexpected %+v", got)
	}
}

func TestUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"nope"}, &out, &errOut); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
}

func TestExpandPlaceholders(t *testing.T) {
	env := map[string]string{"PORT": "4321"}
	got, err := expandPlaceholders([]string{"sanity", "dev", "--port", "{PORT}", "--host", "{HOST}", "--url=http://{HOST}:{PORT}"}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"sanity", "dev", "--port", "4321", "--host", "127.0.0.1", "--url=http://127.0.0.1:4321"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("got %q", got)
	}
	if _, err := expandPlaceholders([]string{"{PORT}"}, func(string) string { return "" }); err == nil {
		t.Fatal("a missing PORT must be an error")
	}
}
