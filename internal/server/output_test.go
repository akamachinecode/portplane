package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/akamachinecode/portplane/internal/model"
)

// Output answers for "web" and fails for anything else, or without a deadline.
func (f *fakeAgent) Output(ctx context.Context, runner, task string) (model.Output, error) {
	if _, ok := ctx.Deadline(); !ok {
		return model.Output{}, errors.New("no deadline")
	}
	if task != "web" {
		return model.Output{}, errors.New("unknown app " + task)
	}
	return model.Output{Screen: "\x1b[1mready\x1b[0m", Command: "dekit -C " + runner + " attach " + task}, nil
}

func TestOutputHandler(t *testing.T) {
	s, _, _ := newTestServer(t)
	s.Extra = OutputHandlers(s.Hub)
	h := s.Handler()
	get := func(query string) (int, map[string]any) {
		rec := do(h, "GET", "/api/output?"+query, "127.0.0.1:4799", "secret", "")
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: %v (%s)", query, err, rec.Body.String())
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control %q", query, cc)
		}
		return rec.Code, body
	}

	code, body := get("machine=local&runner=%2Fcode&task=web")
	if code != http.StatusOK || body["screen"] != "\x1b[1mready\x1b[0m" || body["command"] != "dekit -C /code attach web" {
		t.Fatalf("ok: %d %v", code, body)
	}
	if _, ok := body["truncated"]; ok {
		t.Errorf("false flags are left out: %v", body)
	}
	for query, want := range map[string]int{
		"machine=local&runner=%2Fcode&task=api":   http.StatusBadRequest, // the agent refuses it
		"machine=nope&runner=%2Fcode&task=web":    http.StatusNotFound,
		"machine=local&runner=&task=web":          http.StatusBadRequest,
		"machine=local&runner=%2Fcode":            http.StatusBadRequest,
		"machine=local&runner=%2Fcode&task=web%0": http.StatusBadRequest, // a malformed escape: no task
	} {
		if code, body := get(query); code != want || body["error"] == "" {
			t.Errorf("%s: %d %v, want %d with an error", query, code, body, want)
		}
	}

	// The token guards it like every other endpoint.
	if got := do(h, "GET", "/api/output?machine=local&runner=%2Fcode&task=web", "127.0.0.1:4799", "", "").Code; got != http.StatusUnauthorized {
		t.Fatalf("no token: %d", got)
	}
}
