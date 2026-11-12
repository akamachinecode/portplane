package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/updates"
)

func TestFreeName(t *testing.T) {
	dir := t.TempDir()
	if got := freeName(dir, "report.zip"); got != filepath.Join(dir, "report.zip") {
		t.Fatal(got)
	}
	_ = os.WriteFile(filepath.Join(dir, "report.zip"), nil, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "report (2).zip"), nil, 0o600)
	if got := freeName(dir, "report.zip"); got != filepath.Join(dir, "report (3).zip") {
		t.Fatal(got)
	}
}

func TestPutTheme(t *testing.T) {
	p := &polish{}
	for body, want := range map[string]int{
		`{"theme":"dark"}`:   http.StatusNoContent,
		`{"theme":"system"}`: http.StatusNoContent,
		`{"theme":"sepia"}`:  http.StatusBadRequest,
		`{"color":"dark"}`:   http.StatusBadRequest,
	} {
		rec := httptest.NewRecorder()
		p.putTheme(rec, httptest.NewRequest(http.MethodPut, "/api/window/theme", strings.NewReader(body)))
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", body, rec.Code, want)
		}
	}
}

func TestTestNotificationWithoutService(t *testing.T) {
	p := &polish{}
	rec := httptest.NewRecorder()
	p.testNotification(rec, httptest.NewRequest(http.MethodPost, "/api/notifications/test", strings.NewReader("{}")))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "no notification service") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestUpdatesHandlers(t *testing.T) {
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/releases/latest"):
			http.Redirect(w, r, strings.TrimSuffix(r.URL.Path, "latest")+"tag/v9.0.0", http.StatusFound)
		default:
			_, _ = w.Write([]byte(`{"version":"9.0.0"}`))
		}
	}))
	defer src.Close()
	u := &updatesService{
		checker:   &updates.Checker{GitHub: src.URL, NPM: src.URL},
		store:     &updates.Store{Path: filepath.Join(t.TempDir(), "updates.json")},
		installed: func(context.Context) updates.Installed { return updates.Installed{Portplane: "0.4.0", Dekit: "0.10.3"} },
	}
	rec := httptest.NewRecorder()
	u.get(rec, httptest.NewRequest(http.MethodGet, "/api/updates", nil))
	if strings.TrimSpace(rec.Body.String()) != "null" {
		t.Fatalf("before any check: %s", rec.Body)
	}
	rec = httptest.NewRecorder()
	u.check(rec, httptest.NewRequest(http.MethodPost, "/api/updates/check", strings.NewReader("{}")))
	var r updates.Result
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil || len(r.Items) != 3 || !r.Items[0].Update || r.Items[2].Update {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	rec = httptest.NewRecorder()
	u.get(rec, httptest.NewRequest(http.MethodGet, "/api/updates", nil))
	if !strings.Contains(rec.Body.String(), `"latest":"9.0.0"`) {
		t.Fatalf("saved result: %s", rec.Body)
	}
	if updates.Due(u.store.Load(), time.Now()) {
		t.Fatal("a fresh check is not due again")
	}
}
