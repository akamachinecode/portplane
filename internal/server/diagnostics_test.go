package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRedact(t *testing.T) {
	r := Redactor{Secrets: []string{"0123456789abcdef"}, Homes: []string{"/home/dev", "/", ""}}
	for in, want := range map[string]string{
		"API_KEY=sk-live-abc node server.js":                                   "API_KEY=[redacted] node server.js",
		`Environment="PORTLESS_STATE_DIR=/home/dev/.x"`:                        `Environment="PORTLESS_STATE_DIR=[redacted]"`,
		"--token=abc123 --port 3000":                                           "--token=[redacted] --port 3000",
		`{"password": "hunter22", "port": 3000}`:                               `{"password": "[redacted]", "port": 3000}`,
		"db_password: s3cret":                                                  "db_password: [redacted]",
		"postgres://app:pa55@db.local:5432/x":                                  "postgres://[redacted]@db.local:5432/x",
		"Authorization: Bearer abcdefghijkl":                                   "Authorization: Bearer [redacted]",
		"using ghp_abcdefghijklmnopqrstuvwxyz0123":                             "using [redacted]",
		"key AKIAABCDEFGHIJKLMNOP here":                                        "key [redacted] here",
		"jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF":                         "jwt [redacted]",
		"x-portplane-token 0123456789abcdef":                                   "x-portplane-token [redacted]",
		"/home/dev/code/my-monorepo":                                           "~/code/my-monorepo",
		"https://my-monorepo.localhost":                                        "https://my-monorepo.localhost",
		"exit code 1 (signal SIGTERM)":                                         "exit code 1 (signal SIGTERM)",
		"-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----": "[redacted]",
	} {
		if got := r.Redact(in); got != want {
			t.Errorf("Redact(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func readZip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

func TestDiagnosticsHandler(t *testing.T) {
	now := time.Date(2026, 11, 12, 9, 30, 0, 0, time.UTC)
	var saved []byte
	var savedName string
	cancel := false
	h := DiagnosticsHandlers(DiagnosticsDeps{
		Collect: func(context.Context) []DiagnosticFile {
			return []DiagnosticFile{
				{Name: "snapshot.json", Data: []byte(`{"command":["env","SECRET_TOKEN=abc","node"],"dir":"/home/dev/code"}`)},
				{Name: "versions.json", Data: []byte(`{"portplane":"0.4.0"}`)},
				{Name: "doctor.txt", Data: []byte("token in the open: 9f8e7d6c5b4a")},
			}
		},
		Save: func(_ context.Context, name string, data []byte) (SavedReport, error) {
			if cancel {
				return SavedReport{}, ErrSaveCancelled
			}
			savedName, saved = name, data
			return SavedReport{Path: "/home/dev/Downloads/" + name, Revealed: true}, nil
		},
		Redactor: Redactor{Homes: []string{"/home/dev/"}},
		Now:      func() time.Time { return now },
	})["POST /api/diagnostics"]

	req := httptest.NewRequest(http.MethodPost, "/api/diagnostics", strings.NewReader("{}"))
	req.Header.Set("X-Portplane-Token", "9f8e7d6c5b4a")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var got SavedReport
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if savedName != "portplane-diagnostics-2026-11-12-0930.zip" || got.Path != "/home/dev/Downloads/"+savedName || !got.Revealed {
		t.Fatalf("saved %q, answered %+v", savedName, got)
	}
	files := readZip(t, saved)
	if !strings.Contains(files["README.txt"], "2026-11-12T09:30:00Z") || files["versions.json"] != `{"portplane":"0.4.0"}` {
		t.Fatalf("files %v", files)
	}
	if files["doctor.txt"] != "token in the open: [redacted]" {
		t.Fatalf("the API token reached the report: %q", files["doctor.txt"])
	}
	if s := files["snapshot.json"]; strings.Contains(s, "abc") || strings.Contains(s, "/home/dev") || !strings.Contains(s, "SECRET_TOKEN=[redacted]") {
		t.Fatalf("snapshot not redacted: %s", s)
	}

	cancel = true
	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/diagnostics", strings.NewReader("{}")))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("cancelled: %d", rec.Code)
	}
}

func TestDiagnosticsSaveError(t *testing.T) {
	h := DiagnosticsHandlers(DiagnosticsDeps{
		Collect: func(context.Context) []DiagnosticFile { return nil },
		Save: func(context.Context, string, []byte) (SavedReport, error) {
			return SavedReport{}, errors.New("disk full")
		},
	})["POST /api/diagnostics"]
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/diagnostics", strings.NewReader("{}")))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "couldn't save the report: disk full") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}
