package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/akamachinecode/portplane/internal/hub"
	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/settings"
)

type fakeAgent struct {
	acted []model.Target
	snap  model.MachineSnapshot
}

func (f *fakeAgent) Snapshot(context.Context) (model.MachineSnapshot, error) { return f.snap, nil }
func (f *fakeAgent) Watch(ctx context.Context) <-chan model.MachineSnapshot {
	c := make(chan model.MachineSnapshot, 1)
	c <- f.snap
	go func() { <-ctx.Done(); close(c) }()
	return c
}
func (f *fakeAgent) Act(_ context.Context, t model.Target, v model.Verb) error {
	if v == "explode" {
		return errors.New("boom")
	}
	f.acted = append(f.acted, t)
	return nil
}
func (f *fakeAgent) Up(context.Context, string) error { return nil }
func (f *fakeAgent) Excerpt(context.Context, string, string) (model.Excerpt, error) {
	return model.Excerpt{Lines: []string{"boom"}, Command: "dekit screen x"}, nil
}
func (f *fakeAgent) SetFolders(context.Context, []string) error  { return nil }
func (f *fakeAgent) Dial(context.Context, int) (net.Conn, error) { return nil, errors.New("no") }
func (f *fakeAgent) Close() error                                { return nil }

func newTestServer(t *testing.T) (*Server, *fakeAgent, http.Handler) {
	t.Helper()
	h := hub.New()
	fa := &fakeAgent{snap: model.MachineSnapshot{Machine: model.Machine{ID: "local", Local: true, Status: "online"}, Folders: []string{"/code"}}}
	h.Add("local", fa, model.Machine{ID: "local", Local: true})
	t.Cleanup(h.Close)
	folders := []string{"/a"}
	s := &Server{
		Hub:        h,
		UI:         fstest.MapFS{"index.html": {Data: []byte(`<meta name="portplane-token" content="__PORTPLANE_TOKEN__">`)}, "assets/app.js": {Data: []byte("x")}},
		Token:      "secret",
		Port:       4799,
		GetFolders: func() []string { return folders },
		SetFolders: func(_ context.Context, f []string) error { folders = f; return nil },
		OpenURL:    func(string) error { return nil },
		Reveal:     func(string) error { return nil },
		CanPick:    func() bool { return false },
	}
	return s, fa, s.Handler()
}

func do(h http.Handler, method, url, host, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.Host = host
	if token != "" {
		req.Header.Set("X-Portplane-Token", token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHostAllowlist(t *testing.T) {
	_, _, h := newTestServer(t)
	for host, want := range map[string]int{
		"127.0.0.1:4799":           200,
		"localhost:4799":           200,
		"portplane.localhost":      200,
		"portplane.localhost:443":  200,
		"127.0.0.1:9999":           403,
		"evil.example":             403, // DNS rebinding
		"evil.example:4799":        403,
		"other.localhost":          403,
		"portplane.localhost.evil": 403,
	} {
		if got := do(h, "GET", "/", host, "", "").Code; got != want {
			t.Errorf("host %q: %d, want %d", host, got, want)
		}
	}
}

func TestTokenRequired(t *testing.T) {
	_, _, h := newTestServer(t)
	if got := do(h, "GET", "/api/snapshot", "127.0.0.1:4799", "", "").Code; got != 401 {
		t.Fatalf("no token: %d", got)
	}
	if got := do(h, "GET", "/api/snapshot", "127.0.0.1:4799", "wrong", "").Code; got != 401 {
		t.Fatalf("wrong token: %d", got)
	}
	if got := do(h, "GET", "/api/snapshot", "127.0.0.1:4799", "secret", "").Code; got != 200 {
		t.Fatalf("right token: %d", got)
	}
}

func TestIndexGetsToken(t *testing.T) {
	_, _, h := newTestServer(t)
	rec := do(h, "GET", "/", "127.0.0.1:4799", "", "")
	if !strings.Contains(rec.Body.String(), `content="secret"`) {
		t.Fatalf("token not injected: %s", rec.Body.String())
	}
	if rec.Header().Get("Content-Security-Policy") == "" || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing headers")
	}
	// Unknown paths fall back to the app.
	if got := do(h, "GET", "/some/route", "127.0.0.1:4799", "", ""); !strings.Contains(got.Body.String(), "secret") {
		t.Fatal("SPA fallback")
	}
	if got := do(h, "GET", "/assets/app.js", "127.0.0.1:4799", "", ""); got.Body.String() != "x" {
		t.Fatal("asset")
	}
}

func TestActionsNeedJSONAndRoute(t *testing.T) {
	_, fa, h := newTestServer(t)
	// A cross-site form post cannot set JSON (and has no token).
	req := httptest.NewRequest("POST", "/api/actions", strings.NewReader(`target=x`))
	req.Host = "127.0.0.1:4799"
	req.Header.Set("X-Portplane-Token", "secret")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("form post: %d", rec.Code)
	}
	body := `{"target":{"machine":"local","runner":"/r","task":"web"},"verb":"start"}`
	if got := do(h, "POST", "/api/actions", "127.0.0.1:4799", "secret", body).Code; got != 202 {
		t.Fatalf("action: %d", got)
	}
	if len(fa.acted) != 1 || fa.acted[0].Task != "web" {
		t.Fatalf("acted %+v", fa.acted)
	}
	rec = do(h, "POST", "/api/actions", "127.0.0.1:4799", "secret", `{"target":{"machine":"nope"},"verb":"start"}`)
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "unknown machine") {
		t.Fatalf("unknown machine: %d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, "POST", "/api/actions", "127.0.0.1:4799", "secret", `{"target":{"machine":"local"},"verb":"explode"}`)
	var e struct{ Error string }
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	if rec.Code != 400 || e.Error != "boom" {
		t.Fatalf("agent errors reach the UI: %d %+v", rec.Code, e)
	}
	// Origin from another site is refused even with a token.
	req = httptest.NewRequest("POST", "/api/actions", strings.NewReader(body))
	req.Host = "127.0.0.1:4799"
	req.Header.Set("X-Portplane-Token", "secret")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("foreign origin: %d", rec.Code)
	}
}

func TestRevealOnlyKnownFolders(t *testing.T) {
	_, _, h := newTestServer(t)
	time.Sleep(50 * time.Millisecond) // let the hub take the agent's snapshot
	if got := do(h, "POST", "/api/reveal", "127.0.0.1:4799", "secret", `{"machine":"local","path":"/code"}`).Code; got != 204 {
		t.Fatalf("known folder: %d", got)
	}
	if got := do(h, "POST", "/api/reveal", "127.0.0.1:4799", "secret", `{"machine":"local","path":"/Applications/Calculator.app"}`).Code; got != 400 {
		t.Fatalf("unknown folder: %d", got)
	}
}

func TestPickFolderAcceptsTheUIRequest(t *testing.T) {
	s, _, _ := newTestServer(t)
	s.PickFolder = func(context.Context) (string, error) { return "/picked", nil }
	h := s.Handler()
	rec := do(h, "POST", "/api/folders/pick", "127.0.0.1:4799", "secret", `{}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "/picked") {
		t.Fatalf("pick: %d %s", rec.Code, rec.Body.String())
	}
}

func TestShowWindow(t *testing.T) {
	s, _, h := newTestServer(t)
	if got := do(h, "POST", "/api/window", "127.0.0.1:4799", "secret", `{}`).Code; got != 404 {
		t.Fatalf("no window: %d, want 404", got)
	}
	shown, activation := 0, ""
	s.ShowWindow = func(token string) { shown++; activation = token }
	h = s.Handler()
	if got := do(h, "POST", "/api/window", "127.0.0.1:4799", "", `{}`).Code; got != 401 || shown != 0 {
		t.Fatalf("no token: %d (shown %d), want 401", got, shown)
	}
	if got := do(h, "POST", "/api/window", "127.0.0.1:4799", "secret", `{}`).Code; got != 204 || shown != 1 || activation != "" {
		t.Fatalf("right token: %d (shown %d, activation %q), want 204", got, shown, activation)
	}
	// A second start on Wayland passes its activation token along.
	if got := do(h, "POST", "/api/window", "127.0.0.1:4799", "secret", `{"token":"abc_TIME123"}`).Code; got != 204 || shown != 2 || activation != "abc_TIME123" {
		t.Fatalf("activation token: %d (shown %d, activation %q), want 204", got, shown, activation)
	}
}

func TestSettings(t *testing.T) {
	_, _, h := newTestServer(t)
	rec := do(h, "PUT", "/api/settings", "127.0.0.1:4799", "secret", `{"folders":["/x","/y"]}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"/y"`) {
		t.Fatalf("put: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEventsStream(t *testing.T) {
	s, _, h := newTestServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	s.Port = atoi(port)
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events?token=secret", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	if !strings.HasPrefix(string(buf[:n]), "event: snapshot\ndata: {") {
		t.Fatalf("stream starts with %q", buf[:n])
	}
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func TestListenRefusesNonLoopback(t *testing.T) {
	if _, _, err := Listen(context.Background(), "0.0.0.0:0"); err == nil {
		t.Fatal("0.0.0.0 must be refused")
	}
	ln, port, err := Listen(context.Background(), "127.0.0.1:0")
	if err != nil || port == 0 {
		t.Fatal(err)
	}
	_ = ln.Close()
}

func TestJobsAndPreferences(t *testing.T) {
	store := settings.Open(filepath.Join(t.TempDir(), "settings.json"))
	m := jobs.NewManager()
	s := &Server{Hub: hub.New(), UI: fstest.MapFS{}, Token: "t", Port: 4799, Jobs: m, Extra: PreferencesHandlers(store)}
	h := s.Handler()
	do := func(method, path, body string) *httptest.ResponseRecorder {
		var r *http.Request
		if body == "" {
			r = httptest.NewRequest(method, path, nil)
		} else {
			r = httptest.NewRequest(method, path, strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
		}
		r.Host = "127.0.0.1:4799"
		r.Header.Set("X-Portplane-Token", "t")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	release := make(chan struct{})
	j := m.Start(jobs.Spec{Title: "demo"}, func(ctx context.Context, r *jobs.Run) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if w := do("GET", "/api/jobs", ""); w.Code != 200 || !strings.Contains(w.Body.String(), j.ID) {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	if w := do("GET", "/api/jobs/"+j.ID, ""); w.Code != 200 {
		t.Fatalf("get: %d", w.Code)
	}
	if w := do("POST", "/api/jobs/"+j.ID+"/cancel", "{}"); w.Code != 202 {
		t.Fatalf("cancel: %d", w.Code)
	}
	if w := do("GET", "/api/jobs/nope", ""); w.Code != 404 {
		t.Fatalf("unknown: %d", w.Code)
	}
	close(release)

	if w := do("GET", "/api/preferences", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"theme":"system"`) {
		t.Fatalf("prefs: %d %s", w.Code, w.Body)
	}
	if w := do("PUT", "/api/preferences", `{"theme":"neon"}`); w.Code != 400 {
		t.Fatalf("bad theme: %d", w.Code)
	}
	if w := do("PUT", "/api/preferences", `{"theme":"dark","density":"compact"}`); w.Code != 200 || !strings.Contains(w.Body.String(), `"updateCheck":"manual"`) {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	st, _ := store.Load()
	if st.Prefs().Theme != "dark" {
		t.Fatalf("not saved: %+v", st.Prefs())
	}
}
