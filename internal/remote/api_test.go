package remote

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/jobs"
	"github.com/akamachinecode/portplane/internal/model"
)

type resettable struct {
	ConnectorFunc
	mu     sync.Mutex
	resets int
}

func (r *resettable) Reset() {
	r.mu.Lock()
	r.resets++
	r.mu.Unlock()
}

// The machine API over the protocol: requests reach the agent's handler
// with the machine's id, jobs come back, and a dropped connection ends the
// jobs that were running.
func TestAPIAndJobsOverTheProtocol(t *testing.T) {
	agentJobs := jobs.NewManager()
	release := make(chan struct{})
	var hello Hello
	var mu sync.Mutex
	api := http.NewServeMux()
	api.HandleFunc("POST /api/things", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		j := agentJobs.Start(jobs.Spec{Title: "Slow", Steps: []string{"Wait"}}, func(ctx context.Context, run *jobs.Run) error {
			run.Step("Wait")
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"id":"`+j.ID+`","got":`+string(b)+`,"q":"`+r.URL.Query().Get("q")+`"}`)
	})
	fa := &fakeAgent{snap: model.MachineSnapshot{Machine: model.Machine{ID: "remote", Status: "online"}}}
	var current io.ReadWriteCloser
	conn := &resettable{}
	conn.ConnectorFunc = func(context.Context) (io.ReadWriteCloser, error) {
		client, server := connPair()
		mu.Lock()
		current = client
		mu.Unlock()
		go func() {
			_ = ServeWith(context.Background(), server, fa, ServeOptions{API: api, Jobs: agentJobs, OnHello: func(h Hello) {
				mu.Lock()
				hello = h
				mu.Unlock()
				agentJobs.SetMachine(h.Machine)
			}})
		}()
		return client, nil
	}
	a := NewAgent("box", "Box", nil, conn)
	defer func() { _ = a.Close() }()
	local := jobs.NewManager()
	a.MirrorJobs(local)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	snaps := a.Watch(ctx)
	waitSnapshot(t, snaps, "online")
	mu.Lock()
	if hello.Machine != "box" {
		t.Fatalf("hello carries the machine's id: %+v", hello)
	}
	mu.Unlock()

	res, err := a.API(ctx, APIRequest{Method: "POST", Path: "/api/things", Query: "q=1", Body: []byte(`{"a":1}`)})
	if err != nil || res.Status != http.StatusAccepted || res.Header["Content-Type"] != "application/json" || !strings.Contains(string(res.Body), `"got":{"a":1},"q":"1"`) {
		t.Fatalf("%+v %v", res, err)
	}
	if res, err := a.API(ctx, APIRequest{Method: "GET", Path: "/api/missing"}); err != nil || res.Status != http.StatusNotFound {
		t.Fatalf("not found: %+v %v", res, err)
	}
	if _, err := a.API(ctx, APIRequest{Method: "GET", Path: "/etc/passwd"}); err == nil {
		t.Fatal("only API paths are served")
	}
	if _, err := a.API(ctx, APIRequest{Method: "PATCH", Path: "/api/things"}); err == nil {
		t.Fatal("only the API's methods are served")
	}

	// The job shows up here, under the machine's name.
	var j jobs.Job
	deadline := time.Now().Add(5 * time.Second)
	for {
		list := local.List()
		if len(list) == 1 && list[0].State == jobs.Running {
			j = list[0]
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no mirrored job: %+v", list)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.HasPrefix(j.ID, "box:") || j.Machine != "box" {
		t.Fatalf("%+v", j)
	}

	// The connection drops: the job here ends, saying why.
	mu.Lock()
	_ = current.Close()
	mu.Unlock()
	waitSnapshot(t, snaps, "offline")
	if got, _ := local.Get(j.ID); got.State != jobs.Failed || !strings.Contains(got.Error, "connection to Box dropped") {
		t.Fatalf("abandoned: %+v", got)
	}
	close(release)
	waitSnapshot(t, snaps, "online")

	// Reinstalling resets the connector and reconnects.
	a.Reinstall()
	waitSnapshot(t, snaps, "online")
	conn.mu.Lock()
	resets := conn.resets
	conn.mu.Unlock()
	if resets != 1 {
		t.Fatalf("resets: %d", resets)
	}
}

// An agent from before the machine API answers "unknown method".
func TestAPIOlderAgent(t *testing.T) {
	fa := &fakeAgent{snap: model.MachineSnapshot{Machine: model.Machine{ID: "remote", Status: "online"}}}
	a := NewAgent("old", "old", nil, ConnectorFunc(func(context.Context) (io.ReadWriteCloser, error) {
		client, server := connPair()
		go func() { _ = Serve(context.Background(), server, fa) }()
		return client, nil
	}))
	defer func() { _ = a.Close() }()
	a.MirrorJobs(jobs.NewManager()) // watchJobs is unknown too, and harmless
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waitSnapshot(t, a.Watch(ctx), "online")
	if _, err := a.API(ctx, APIRequest{Method: "GET", Path: "/api/portless/routes"}); !errors.Is(err, ErrAgentTooOld) {
		t.Fatalf("%v", err)
	}
}
