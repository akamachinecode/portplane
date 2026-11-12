package updates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSources serves GitHub's /releases/latest redirects and the npm
// registry's /<pkg>/latest, and records what each request sent.
func fakeSources(t *testing.T) (*httptest.Server, func() []*http.Request) {
	t.Helper()
	var mu sync.Mutex
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Clone(context.Background()))
		mu.Unlock()
		switch r.URL.Path {
		case "/akamachinecode/portplane/releases/latest":
			http.Redirect(w, r, "/akamachinecode/portplane/releases/tag/v0.5.0", http.StatusFound)
		case "/akamachinecode/portplane/releases/download/v0.5.0/checksums.txt":
			http.Redirect(w, r, "/release-assets/checksums.txt", http.StatusFound)
		case "/pvolok/dekit/releases/latest":
			http.Redirect(w, r, "/pvolok/dekit/releases/tag/v0.10.3", http.StatusFound)
		case "/portless/latest":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"name":"portless","version":"0.17.1","description":"…"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() []*http.Request {
		mu.Lock()
		defer mu.Unlock()
		return seen
	}
}

func TestCheck(t *testing.T) {
	srv, seen := fakeSources(t)
	c := &Checker{GitHub: srv.URL, NPM: srv.URL, UserAgent: "portplane/0.4.0"}
	now := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	r := c.Check(context.Background(), Installed{Portplane: "v0.4.0", Dekit: "0.10.3", Portless: "0.16.0"}, now)
	if !r.CheckedAt.Equal(now) || len(r.Items) != 3 {
		t.Fatalf("%+v", r)
	}
	p, d, l := r.Items[0], r.Items[1], r.Items[2]
	if p.ID != "portplane" || p.Latest != "0.5.0" || !p.Update || p.Notes != srv.URL+"/akamachinecode/portplane/releases/tag/v0.5.0" || p.Error != "" {
		t.Fatalf("portplane %+v", p)
	}
	if d.ID != "dekit" || d.Latest != "0.10.3" || d.Update || d.Error != "" {
		t.Fatalf("dekit %+v", d)
	}
	if l.ID != "portless" || l.Latest != "0.17.1" || !l.Update || l.Notes != PortlessReleases {
		t.Fatalf("portless %+v", l)
	}
	// Only reads, with no cookies and no identifiers but the user agent.
	for _, req := range seen() {
		if req.Method != http.MethodGet || req.Header.Get("User-Agent") != "portplane/0.4.0" || req.Header.Get("Cookie") != "" || req.URL.RawQuery != "" {
			t.Fatalf("request %s %s %v", req.Method, req.URL, req.Header)
		}
	}
	// The redirects were read, not followed.
	for _, req := range seen() {
		if strings.Contains(req.URL.Path, "/releases/tag/") || strings.Contains(req.URL.Path, "/release-assets/") {
			t.Fatalf("followed the redirect to %s", req.URL)
		}
	}
}

// A release whose files are not uploaded yet is not an update.
func TestCheckWaitsForTheReleaseFiles(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/akamachinecode/portplane/releases/latest" {
			http.Redirect(w, r, "/akamachinecode/portplane/releases/tag/v0.6.0", http.StatusFound)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	r := (&Checker{GitHub: srv.URL, NPM: srv.URL}).Check(context.Background(), Installed{Portplane: "0.5.0"}, time.Now())
	if p := r.Items[0]; p.Update || !strings.Contains(p.Error, "still being published") {
		t.Fatalf("%+v", p)
	}
}

func TestCheckFailures(t *testing.T) {
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/akamachinecode/portplane/releases/latest":
			http.Redirect(w, r, "/akamachinecode/portplane/releases", http.StatusFound) // no release yet
		case "/portless/latest":
			_, _ = w.Write([]byte(`{"version":"latest-and-greatest"}`))
		default:
			http.Error(w, "rate limited", http.StatusTooManyRequests)
		}
	}))
	defer broken.Close()
	c := &Checker{GitHub: broken.URL, NPM: broken.URL}
	r := c.Check(context.Background(), Installed{Portplane: "dev"}, time.Now())
	for _, it := range r.Items {
		if it.Error == "" || it.Update || it.Latest != "" {
			t.Fatalf("%s: %+v", it.ID, it)
		}
	}
	if !strings.Contains(r.Items[0].Error, "no release yet") || !strings.Contains(r.Items[1].Error, "429") || !strings.Contains(r.Items[2].Error, "unexpected version") {
		t.Fatalf("%+v", r.Items)
	}

	// Offline: every tool says so on its own.
	addr := broken.URL
	broken.Close()
	r = (&Checker{GitHub: addr, NPM: addr}).Check(context.Background(), Installed{}, time.Now())
	for _, it := range r.Items {
		if !strings.Contains(it.Error, "couldn't connect") {
			t.Fatalf("%s: %q", it.ID, it.Error)
		}
	}
}

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		latest, installed string
		want              bool
	}{
		{"0.5.0", "0.4.9", true},
		{"0.5.0", "v0.5.0", false},
		{"0.10.0", "0.9.12", true},
		{"1.0.0", "1.0.0-rc.1", true},
		{"1.0.0-rc.2", "1.0.0-rc.1", true},
		{"1.0.0-rc.10", "1.0.0-rc.9", true},
		{"1.0.0-beta", "1.0.0-alpha", true},
		{"1.0.0-rc.1", "1.0.0", false},
		{"0.4.0", "0.5.0", false},
		{"0.5.0", "", false},
		{"0.5.0", "dev", false},
		{"0.5.0", "0.4.0-SNAPSHOT-abc", true},
		{"garbage", "0.1.0", false},
	} {
		if got := Newer(c.latest, c.installed); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.latest, c.installed, got, c.want)
		}
	}
}

func TestStoreAndDue(t *testing.T) {
	s := &Store{Path: filepath.Join(t.TempDir(), "portplane", "updates.json")}
	now := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	if s.Load() != nil || !Due(nil, now) {
		t.Fatal("empty store")
	}
	if err := s.Save(Result{CheckedAt: now, Items: []Item{{ID: "dekit", Latest: "0.10.3"}}}); err != nil {
		t.Fatal(err)
	}
	r := s.Load()
	if r == nil || r.Items[0].Latest != "0.10.3" {
		t.Fatalf("%+v", r)
	}
	if Due(r, now.Add(23*time.Hour)) || !Due(r, now.Add(24*time.Hour)) {
		t.Fatal("once a day")
	}
}
