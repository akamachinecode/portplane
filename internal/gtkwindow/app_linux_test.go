//go:build linux

package gtkwindow

import (
	"net/url"
	"path/filepath"
	"testing"
)

func TestStaysInWindow(t *testing.T) {
	home, _ := url.Parse("http://127.0.0.1:4799/")
	for raw, want := range map[string]bool{
		"http://127.0.0.1:4799/":            true,
		"http://127.0.0.1:4799/#/machines":  true,
		"HTTP://127.0.0.1:4799/x":           true,
		"about:blank":                       true,
		"http://127.0.0.1:4800/":            false, // another port: another app
		"https://127.0.0.1:4799/":           false,
		"https://web.localhost/":            false,
		"javascript:alert(1)":               false,
		"file:///etc/passwd":                false,
		"http://127.0.0.1:4799@evil.test/x": false,
	} {
		if got := staysInWindow(raw, home); got != want {
			t.Errorf("staysInWindow(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestState(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "window.json")
	if s := loadState(p); s != (state{}) {
		t.Fatalf("missing file: %+v", s)
	}
	want := state{Width: 1300, Height: 820, Maximized: true}
	if err := saveState(p, want); err != nil {
		t.Fatal(err)
	}
	if got := loadState(p); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
