package remote

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/akamachinecode/portplane/internal/model"
)

// Output answers like a local agent: colour codes kept, a command to attach.
func (f *fakeAgent) Output(_ context.Context, runner, task string) (model.Output, error) {
	switch task {
	case "shop/missing":
		return model.Output{}, errors.New("unknown app " + task)
	case "shop/down":
		return model.Output{RunnerDown: true, Command: "dekit -C " + runner + " attach " + task}, nil
	}
	return model.Output{
		Screen:    "\x1b[32m  ➜  Local:\x1b[0m   http://localhost:4310/\n<script>alert(1)</script>",
		Truncated: true,
		Command:   "dekit -C " + runner + " attach " + task,
	}, nil
}

func TestOutputOverTheProtocol(t *testing.T) {
	fa := &fakeAgent{snap: model.MachineSnapshot{Machine: model.Machine{ID: "remote", Status: "online"}}}
	a := NewAgent("box", "Box", nil, ConnectorFunc(func(context.Context) (io.ReadWriteCloser, error) {
		client, server := connPair()
		go func() { _ = Serve(context.Background(), server, fa) }()
		return client, nil
	}))
	defer func() { _ = a.Close() }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Before the connection is up, the call says the machine is offline.
	if _, err := a.Output(ctx, "/home/dev/src", "shop/web"); !errors.Is(err, ErrOffline) {
		t.Fatalf("offline: %v", err)
	}
	waitSnapshot(t, a.Watch(ctx), "online")

	out, err := a.Output(ctx, "/home/dev/src", "shop/web")
	if err != nil {
		t.Fatal(err)
	}
	want := model.Output{
		Screen:    "\x1b[32m  ➜  Local:\x1b[0m   http://localhost:4310/\n<script>alert(1)</script>",
		Truncated: true,
		Command:   "dekit -C /home/dev/src attach shop/web",
	}
	if out != want {
		t.Fatalf("output %+v, want %+v", out, want)
	}
	if out, err := a.Output(ctx, "/home/dev/src", "shop/down"); err != nil || !out.RunnerDown {
		t.Fatalf("runner down: %+v, %v", out, err)
	}
	if _, err := a.Output(ctx, "/home/dev/src", "shop/missing"); err == nil || !strings.Contains(err.Error(), "unknown app shop/missing") {
		t.Fatalf("remote error: %v", err)
	}
}
