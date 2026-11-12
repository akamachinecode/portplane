package remote

import (
	"context"
	"io"
	"reflect"
	"testing"

	"github.com/akamachinecode/portplane/internal/model"
)

// The task verbs added for the dekit center (kill, veto, force-restart,
// rm) travel to a remote agent like start and stop: the agent is the same
// binary and runs them on its own machine.
func TestNewVerbsOverTheProtocol(t *testing.T) {
	fa := &fakeAgent{snap: model.MachineSnapshot{Machine: model.Machine{ID: "remote", Status: "online"}}}
	conn := ConnectorFunc(func(ctx context.Context) (io.ReadWriteCloser, error) {
		client, server := connPair()
		go func() { _ = Serve(context.Background(), server, fa) }()
		return client, nil
	})
	a := NewAgent("box", "Box", []string{t.TempDir()}, conn)
	defer func() { _ = a.Close() }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waitSnapshot(t, a.Watch(ctx), "online")
	verbs := []model.Verb{model.VerbKill, model.VerbVeto, model.VerbForceRestart, model.VerbRemove}
	for _, v := range verbs {
		if err := a.Act(ctx, model.Target{Machine: "box", Runner: "/r", Task: "shop/web"}, v); err != nil {
			t.Fatalf("%s: %v", v, err)
		}
	}
	fa.mu.Lock()
	defer fa.mu.Unlock()
	if !reflect.DeepEqual(fa.acted, verbs) {
		t.Fatalf("the agent got %v", fa.acted)
	}
}
