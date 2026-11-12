package server

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// DiagnosticFile is one file of the diagnostic report.
type DiagnosticFile struct {
	Name string
	Data []byte
}

// SavedReport says where the report went.
type SavedReport struct {
	Path string `json:"path"`
	// Dialog: the user chose the place in a save dialog. Otherwise the
	// report is in the downloads folder, shown in the file manager.
	Dialog   bool `json:"dialog"`
	Revealed bool `json:"revealed"`
}

// ErrSaveCancelled means the user closed the save dialog.
var ErrSaveCancelled = errors.New("cancelled")

// DiagnosticsDeps is what POST /api/diagnostics reads and where the report
// goes.
type DiagnosticsDeps struct {
	// Collect gathers the report's files: versions, portless doctor, the
	// service status, runners, the snapshot. They are redacted after.
	Collect func(ctx context.Context) []DiagnosticFile
	// Save stores the zip, through a save dialog when there is one.
	Save func(ctx context.Context, name string, data []byte) (SavedReport, error)
	// Redactor removes secrets before anything is written.
	Redactor Redactor
	Now      func() time.Time
}

// DiagnosticsHandlers serves POST /api/diagnostics: it builds the report
// and saves it (200 with SavedReport, 204 when the user cancels).
func DiagnosticsHandlers(d DiagnosticsDeps) map[string]http.HandlerFunc {
	if d.Now == nil {
		d.Now = time.Now
	}
	return map[string]http.HandlerFunc{
		"POST /api/diagnostics": func(w http.ResponseWriter, r *http.Request) {
			var body struct{}
			if err := decode(r, &body); err != nil {
				writeError(w, http.StatusBadRequest, err)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute) // includes the user choosing a place
			defer cancel()
			now := d.Now()
			red := d.Redactor
			if t := r.Header.Get("X-Portplane-Token"); t != "" { // never in a report, whatever the sources print
				red.Secrets = append(append([]string(nil), red.Secrets...), t)
			}
			data, err := BuildDiagnostics(d.Collect(ctx), red, now)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err)
				return
			}
			saved, err := d.Save(ctx, DiagnosticsName(now), data)
			switch {
			case errors.Is(err, ErrSaveCancelled):
				w.WriteHeader(http.StatusNoContent)
			case err != nil:
				writeError(w, http.StatusInternalServerError, errors.New("couldn't save the report: "+err.Error()))
			default:
				writeJSON(w, http.StatusOK, saved)
			}
		},
	}
}

// DiagnosticsName is the report's file name.
func DiagnosticsName(now time.Time) string {
	return "portplane-diagnostics-" + now.Format("2006-01-02-1504") + ".zip"
}

const diagnosticsReadme = `Portplane diagnostic report
===========================

Created %s. Attach this file to an issue at
https://github.com/akamachinecode/portplane/issues if someone asks for it.

What is inside:
  versions.json            Portplane, dekit, portless and the system
  snapshot.json            what Portplane shows: machines, projects, apps, ports
  dekit-runners.json       dekit runner list --json
  portless-doctor.txt      portless doctor
  portless-service.txt     portless service status
  jobs.json                recent installs and other long operations

Before writing it, Portplane replaced secrets with [redacted]: values of
environment variables, tokens, passwords, keys, the credentials in URLs,
and Portplane's own access token. Your home folder shows as ~. Read it
before you share it: a secret in an unusual form can slip through.
`

// BuildDiagnostics zips the files, each redacted, with a README first.
func BuildDiagnostics(files []DiagnosticFile, r Redactor, now time.Time) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		f, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: now})
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	}
	readme := strings.Replace(diagnosticsReadme, "%s", now.UTC().Format(time.RFC3339), 1)
	if err := add("README.txt", []byte(readme)); err != nil {
		return nil, err
	}
	sorted := append([]DiagnosticFile(nil), files...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	for _, f := range sorted {
		if err := add(f.Name, []byte(r.Redact(string(f.Data)))); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Redactor removes secrets from text.
type Redactor struct {
	// Secrets are exact values never to write, such as the API token.
	Secrets []string
	// Homes are the user's home folders ($HOME and the account's), each
	// replaced by "~".
	Homes []string
}

const redacted = "[redacted]"

var (
	// NAME=value with an upper-case name: an environment variable, in a
	// command, a unit file or a log line. Its value goes.
	envAssignRE = regexp.MustCompile(`\b([A-Z][A-Z0-9_]*[A-Z0-9])=("?)([^\s"']*)`)
	// key=value, key: value and "key": "value" where the key says secret.
	secretKeyRE = regexp.MustCompile(`(?i)([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|cookie|session)[A-Za-z0-9_.-]*)("?\s*[=:]\s*"?)([^\s"',;&]+)`)
	// Credentials in URLs: scheme://user:password@host.
	urlUserRE = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s:@"']+:[^/\s@"']+@`)
	bearerRE  = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`)
	// Well-known token shapes: GitHub, npm, Slack, AWS keys, JWTs.
	tokenRE      = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b`)
	privateKeyRE = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`)
)

// Redact returns s with secrets replaced by [redacted].
func (r Redactor) Redact(s string) string {
	for _, secret := range r.Secrets {
		if len(secret) >= 6 {
			s = strings.ReplaceAll(s, secret, redacted)
		}
	}
	s = privateKeyRE.ReplaceAllString(s, redacted)
	s = urlUserRE.ReplaceAllString(s, "${1}"+redacted+"@")
	s = bearerRE.ReplaceAllString(s, "${1} "+redacted)
	s = tokenRE.ReplaceAllString(s, redacted)
	s = envAssignRE.ReplaceAllString(s, "${1}=${2}"+redacted)
	s = secretKeyRE.ReplaceAllStringFunc(s, func(m string) string {
		parts := secretKeyRE.FindStringSubmatch(m)
		v := parts[3]
		if strings.HasPrefix(v, "[redacted") || strings.EqualFold(v, "bearer") || strings.EqualFold(v, "basic") {
			return m // already done, by the rules above
		}
		return parts[1] + parts[2] + redacted
	})
	for _, h := range r.Homes {
		if h = strings.TrimSuffix(h, "/"); len(h) > 1 {
			s = strings.ReplaceAll(s, h, "~")
		}
	}
	return s
}
