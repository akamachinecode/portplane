package settings

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestPreferencesDefaultsAndValidate(t *testing.T) {
	var s Settings
	p := s.Prefs()
	if p.Theme != "system" || p.Density != "comfortable" || p.UpdateCheck != "manual" || p.AppsLayout != "cards" || p.Favorites == nil {
		t.Fatalf("defaults: %+v", p)
	}
	// Only failures notify until the user turns more on.
	if p.Notifications != (Notifications{Failures: true}) {
		t.Fatalf("defaults: %+v", p)
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	p.Theme = "neon"
	if err := p.Validate(); err == nil {
		t.Fatal("accepted theme neon")
	}
	p.Theme = "dark"
	p.AppsLayout = "grid"
	if err := p.Validate(); err == nil {
		t.Fatal("accepted layout grid")
	}
	partial := &Preferences{Theme: "dark"}
	s.Preferences = partial
	if got := s.Prefs(); got.Theme != "dark" || got.Density != "comfortable" || got.AppsLayout != "cards" || got.Onboarding.Done == nil {
		t.Fatalf("normalized: %+v", got)
	}
}

func TestWatchSeesOutsideChanges(t *testing.T) {
	st := Open(filepath.Join(t.TempDir(), "settings.json"))
	if err := st.Save(Settings{Folders: []string{"/a"}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan Settings, 1)
	go st.Watch(ctx, 10*time.Millisecond, func(s Settings) { got <- s })
	time.Sleep(30 * time.Millisecond)
	if err := Open(st.Path()).Save(Settings{Folders: []string{"/a", "/b"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-got:
		if len(s.Folders) != 2 {
			t.Fatalf("saw %v", s.Folders)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no change seen")
	}
}
