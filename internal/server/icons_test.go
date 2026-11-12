package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/akamachinecode/portplane/internal/desktop"
)

func iconMux(d IconDeps) *http.ServeMux {
	mux := http.NewServeMux()
	for pattern, h := range IconHandlers(d) {
		mux.HandleFunc(pattern, h)
	}
	return mux
}

func TestIconRoutesFindAnIconAndRefuseOtherFiles(t *testing.T) {
	repo := t.TempDir()
	svg := filepath.Join(repo, "public", "favicon.svg")
	secret := filepath.Join(repo, ".env")
	for path, data := range map[string]string{svg: `<svg xmlns="http://www.w3.org/2000/svg"/>`, secret: "TOKEN=x"} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mux := iconMux(IconDeps{})

	get := func(path string, q url.Values) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path+"?"+q.Encode(), nil))
		return rec
	}
	rec := get("/api/icons/find", url.Values{"dir": {repo}, "root": {repo}})
	body := decodeBody[iconBody](t, rec)
	if rec.Code != 200 || body.Icon == nil || body.Icon.Path != svg {
		t.Fatalf("find: %d %+v", rec.Code, body.Icon)
	}
	if rec := get("/api/icons/find", url.Values{"dir": {"relative"}}); rec.Code != http.StatusBadRequest {
		t.Fatalf("a relative dir: %d", rec.Code)
	}
	if rec := get("/api/icons/file", url.Values{"path": {secret}}); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("a file that is not an image was served: %d", rec.Code)
	}
	if !IsMachineArea("icons/find") {
		t.Fatal("icons/ must travel to remote machines")
	}
}

func TestIconPickWithoutADesktop(t *testing.T) {
	rec := httptest.NewRecorder()
	iconMux(IconDeps{}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/icons/pick", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("no picker: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	iconMux(IconDeps{Pick: func(context.Context) (string, error) { return "", desktop.ErrCancelled }}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/icons/pick", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("cancelled: %d", rec.Code)
	}
}
