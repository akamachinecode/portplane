package dekit

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type fakeCall struct {
	args []string
	env  []string
}

func fakeCLI(stdout, stderr string, err error, calls *[]fakeCall) *CLI {
	return &CLI{Bin: "dekit", Exec: func(_ context.Context, env []string, _ string, args ...string) ([]byte, []byte, error) {
		*calls = append(*calls, fakeCall{args: args, env: env})
		return []byte(stdout), []byte(stderr), err
	}}
}

func TestListParsesStates(t *testing.T) {
	var calls []fakeCall
	c := fakeCLI(`{"tasks":[{"id":2,"path":"demo/web","kind":"service","state":"ready"},{"id":4,"path":"demo/broken","kind":"service","state":"exited","exit_code":3},{"id":5,"path":"demo/k","kind":"service","state":"backoff","signal":"SIGKILL","reason":"ready_timeout"}]}`, "", nil, &calls)
	tasks, err := c.List(context.Background(), "/p")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls[0].args, []string{"-C", "/p", "ls", "--json"}) {
		t.Fatalf("args %v", calls[0].args)
	}
	if len(tasks) != 3 || tasks[1].ExitCode == nil || *tasks[1].ExitCode != 3 || tasks[2].SignalName() != "SIGKILL" || tasks[2].Reason != "ready_timeout" {
		t.Fatalf("tasks %+v", tasks)
	}
}

func TestRunnerDown(t *testing.T) {
	var calls []fakeCall
	c := fakeCLI("", "Error: Runner is not running. Start it with `dekit up`.\n", errors.New("exit status 1"), &calls)
	if _, err := c.List(context.Background(), "/p"); !errors.Is(err, ErrRunnerDown) {
		t.Fatalf("want ErrRunnerDown, got %v", err)
	}
}

func TestActRejectsUnknownVerbs(t *testing.T) {
	var calls []fakeCall
	c := fakeCLI("", "", nil, &calls)
	if err := c.Act(context.Background(), "/p", "rm", "x"); err == nil {
		t.Fatal("rm must not be allowed")
	}
	if err := c.Act(context.Background(), "/p", "start", "shop/**"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls[0].args, []string{"-C", "/p", "start", "shop/**"}) {
		t.Fatalf("args %v", calls[0].args)
	}
	for _, kv := range calls[0].env {
		if strings.HasPrefix(kv, "CLAUDECODE=") {
			t.Fatal("agent variables must not reach the runner")
		}
	}
}

func TestCleanEnv(t *testing.T) {
	got := CleanEnv([]string{"PATH=/bin", "CLAUDECODE=1", "AI_AGENT=x", "HOME=/h", "cursor_trace_id=y"})
	if !reflect.DeepEqual(got, []string{"PATH=/bin", "HOME=/h"}) {
		t.Fatalf("got %v", got)
	}
}

func TestErrorsWithoutDekit(t *testing.T) {
	c := &CLI{}
	if _, err := c.List(context.Background(), "/p"); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("got %v", err)
	}
}
