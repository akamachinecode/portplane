package dekit

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Fixtures in testdata/0.10.3 were captured from dekit 0.10.3's own JSON
// output, with paths replaced by generic ones.
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "0.10.3", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseRunnerListFixture(t *testing.T) {
	recs, err := ParseRunnerList(fixture(t, "runner-list.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 {
		t.Fatalf("records %+v", recs)
	}
	run, stale := recs[0], recs[1]
	if !run.Running || run.Kind != "project" || run.Root != "/home/dev/code/my-monorepo" || run.PID == 0 || run.Version != "0.10.3" || run.Binary == "" || run.StartedAt == 0 {
		t.Fatalf("running record %+v", run)
	}
	if stale.Running || stale.Root != "/home/dev/code" {
		t.Fatalf("stale record %+v", stale)
	}
}

func TestParseRunnerStatusFixtures(t *testing.T) {
	cases := map[string]string{"runner-status-running.json": "running", "runner-status-stale.json": "stale", "runner-status-absent.json": "absent"}
	for name, want := range cases {
		st, err := ParseRunnerStatus(fixture(t, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if st.Status != want {
			t.Errorf("%s: status %q", name, st.Status)
		}
		if want != "absent" && (st.PID == 0 || st.Version != "0.10.3" || st.StartedAt == 0 || st.Kind != "project") {
			t.Errorf("%s: %+v", name, st)
		}
		if st.SelectedBinary == "" {
			t.Errorf("%s: no selected binary", name)
		}
	}
}

func TestParseWhyFixtures(t *testing.T) {
	w, err := ParseWhy(fixture(t, "why-starting.json"))
	if err != nil {
		t.Fatal(err)
	}
	if w.Path != "web" || w.State != "idle" || !w.Pinned || !w.Wanted || w.Supported || len(w.Deps) != 1 || w.Deps[0].Path != "api" || w.Deps[0].Satisfied {
		t.Fatalf("waiting for a dependency: %+v", w)
	}
	w, _ = ParseWhy(fixture(t, "why-backoff.json"))
	if w.State != "backoff" || w.Reason != "ready_timeout" || w.Attempts != 5 || string(w.Signal) != "15" {
		t.Fatalf("backoff: %+v", w)
	}
	w, _ = ParseWhy(fixture(t, "why-vetoed.json"))
	if !w.Vetoed || w.Wanted || !reflect.DeepEqual(w.RequiredBy, []string{"web"}) || w.Deps[0].ExitCode == nil {
		t.Fatalf("vetoed: %+v", w)
	}
	w, _ = ParseWhy(fixture(t, "why-exited.json"))
	if w.State != "exited" || w.ExitCode == nil || *w.ExitCode != 3 {
		t.Fatalf("exited: %+v", w)
	}
	w, _ = ParseWhy(fixture(t, "why-done.json"))
	if w.State != "done" || w.Deps == nil || len(w.Deps) != 0 {
		t.Fatalf("done: %+v", w)
	}
}

func TestParseReloadFixtures(t *testing.T) {
	r, err := ParseReload(fixture(t, "reload-nochange.json"))
	if err != nil || !r.Plan.Empty() || r.Applied {
		t.Fatalf("no change: %+v %v", r, err)
	}
	r, err = ParseReload(fixture(t, "reload-plan.json"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Applied || r.Plan.Empty() || r.Plan.Order == nil || !r.Plan.Order.Apply {
		t.Fatalf("plan: %+v", r)
	}
	kinds := map[string]string{}
	for _, c := range r.Plan.Changes {
		kinds[c.Path] = c.Kind
	}
	if !reflect.DeepEqual(kinds, map[string]string{"fail": "changed", "web": "changed", "worker": "added", "api": "removed", "slow": "removed"}) {
		t.Fatalf("kinds %v", kinds)
	}
	for _, c := range r.Plan.Changes {
		switch c.Path {
		case "api":
			if c.Apply || c.Reason != "running" {
				t.Errorf("a running task the config dropped is kept: %+v", c)
			}
		case "web":
			if len(c.Fields) != 3 || c.Fields[0].Key != "cmd" || !strings.Contains(string(c.Fields[0].Config), "sleep 700") || c.Fields[2].Key != "env.PORT" || string(c.Fields[2].Base) != "null" {
				t.Errorf("web fields %+v", c.Fields)
			}
		}
	}
	r, _ = ParseReload(fixture(t, "reload-yes.json"))
	if !r.Applied {
		t.Fatal("--yes applies")
	}
}

func TestParseKernelAndWaitFixtures(t *testing.T) {
	k, err := ParseKernelStatus(fixture(t, "kernel-status.json"))
	if err != nil || k.Active == nil || k.Default != nil || k.Selected == "" || k.RestartRequired {
		t.Fatalf("kernel %+v %v", k, err)
	}
	k, _ = ParseKernelStatus(fixture(t, "kernel-status-none.json"))
	if k.Active != nil {
		t.Fatalf("no runner: %+v", k)
	}
	w, err := ParseWait(fixture(t, "up-wait.json"))
	if err != nil || w.Wait != "failed" || len(w.Tasks) != 4 {
		t.Fatalf("up --wait %+v %v", w, err)
	}
	if w.Tasks[0].Wait != "failed" || w.Tasks[0].Why == nil || w.Tasks[0].ExitCode == nil || w.Tasks[2].Wait != "pending" {
		t.Fatalf("tasks %+v", w.Tasks)
	}
	w, _ = ParseWait(fixture(t, "wait.json"))
	if w.Wait != "met" || w.Tasks[0].State != "ready" {
		t.Fatalf("wait %+v", w)
	}
	var states []TaskState
	b := fixture(t, "ls-backoff.json")
	c := &CLI{Bin: "dekit", Exec: func(context.Context, []string, string, ...string) ([]byte, []byte, error) { return b, nil, nil }}
	states, err = c.List(context.Background(), "/p")
	if err != nil || states[2].State != "backoff" || states[2].SignalName() != "15" || states[2].Reason != "ready_timeout" {
		t.Fatalf("ls %+v %v", states, err)
	}
}

func TestParseHelpFieldsFixture(t *testing.T) {
	fields, err := ParseHelpFields(fixture(t, "help.json"))
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]HelpField{}
	for _, f := range fields {
		if f.Kind == "config" {
			byKey[f.Key] = f
		}
	}
	// Every task key the form edits has help in the installed version.
	for _, k := range []string{"label", "cmd", "script", "type", "cwd", "env", "add_path", "deps", "tags", "ready", "autostart", "autorestart", "stop", "log", "scrollback_len", "ready.tcp", "ready.interval", "stop.signal", "stop.group", "stop.keys", "stop.timeout"} {
		f, ok := byKey["tasks.*."+k]
		if !ok || f.Desc == "" || f.Topic == "" {
			t.Errorf("no help for %s", k)
		}
	}
	if byKey["tasks.*.autorestart"].Default != "never" || byKey["tasks.*.type"].Type != "service | job" {
		t.Errorf("types and defaults: %+v %+v", byKey["tasks.*.autorestart"], byKey["tasks.*.type"])
	}
}
