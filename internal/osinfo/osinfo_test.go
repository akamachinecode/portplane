package osinfo

import (
	"context"
	"net"
	"os"
	"reflect"
	"testing"
)

func TestDisplayName(t *testing.T) {
	cases := map[string][]string{
		"postgres":     {"/usr/lib/postgresql/bin/postgres", "-D", "x"},
		"node vite":    {"node", "/repo/node_modules/vite/bin/vite.js", "--port", "4000"},
		"node next":    {"node", "/repo/node_modules/next/dist/bin/next", "dev"},
		"node":         {"node", "-e", "require('http')"},
		"node server":  {`C:\Program Files\nodejs\node.exe`, `C:\app\server.js`},
		"next-server":  {"next-server"},
		"electron-app": {"electron-app --flag=x"},
		"python3 http": {"python3", "-m", "http.server"},
		"":             nil,
	}
	for want, cmd := range cases {
		if got := DisplayName(cmd); got != want {
			t.Errorf("DisplayName(%q) = %q, want %q", cmd, got, want)
		}
	}
}

type fakeSource struct {
	procs map[int]Proc
}

func (f fakeSource) Listeners(context.Context) ([]Listener, error) { return nil, nil }
func (f fakeSource) Proc(_ context.Context, pid int) (Proc, bool) {
	p, ok := f.procs[pid]
	return p, ok
}
func (f fakeSource) Cwd(context.Context, int) string { return "" }

func TestAncestors(t *testing.T) {
	c := NewCache(fakeSource{procs: map[int]Proc{
		30: {PID: 30, PPID: 20},
		20: {PID: 20, PPID: 10},
		10: {PID: 10, PPID: 1},
	}})
	if got := c.Ancestors(context.Background(), 30); !reflect.DeepEqual(got, []int{20, 10}) {
		t.Fatalf("got %v", got)
	}
}

// TestSystemFindsOwnListener checks the real collector on this OS: a socket
// this test opens must be reported with this process's PID and folder.
func TestSystemFindsOwnListener(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	port := ln.Addr().(*net.TCPAddr).Port
	ctx := context.Background()
	ls, err := System{}.Listeners(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var found *Listener
	for i := range ls {
		if ls[i].Port == port {
			found = &ls[i]
		}
	}
	if found == nil {
		t.Fatalf("port %d not reported", port)
	}
	if found.PID != os.Getpid() || !found.Loopback() {
		t.Fatalf("listener %+v, want pid %d", found, os.Getpid())
	}
	wd, _ := os.Getwd()
	if got := (System{}).Cwd(ctx, os.Getpid()); got != wd {
		t.Fatalf("cwd %q, want %q", got, wd)
	}
	p, ok := System{}.Proc(ctx, os.Getpid())
	if !ok || p.PPID == 0 || len(p.Cmdline) == 0 {
		t.Fatalf("proc %+v", p)
	}
}
