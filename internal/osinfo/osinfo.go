// Package osinfo reads listening TCP ports and process details on macOS,
// Linux and Windows (via gopsutil, without CGO).
package osinfo

import (
	"context"
	"net"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

// Listener is a listening TCP socket.
type Listener struct {
	Port    int
	Address string // as bound: 127.0.0.1, ::1, 0.0.0.0, ::
	PID     int    // 0 when the owner is not visible (another user)
}

// Loopback reports whether the socket only accepts local connections.
func (l Listener) Loopback() bool {
	ip := net.ParseIP(l.Address)
	return ip != nil && ip.IsLoopback()
}

// Proc is what Portplane needs to know about a process.
type Proc struct {
	PID     int
	PPID    int
	Cmdline []string
}

// Source provides OS facts. The real one is System; tests use fakes.
type Source interface {
	Listeners(ctx context.Context) ([]Listener, error)
	Proc(ctx context.Context, pid int) (Proc, bool)
	Cwd(ctx context.Context, pid int) string
}

// System reads the real OS.
type System struct{}

// Listeners returns every listening TCP socket, one per (port, pid).
func (System) Listeners(ctx context.Context) ([]Listener, error) {
	conns, err := gnet.ConnectionsWithContext(ctx, "tcp")
	if err != nil {
		return nil, err
	}
	type key struct {
		port int
		pid  int32
	}
	seen := map[key]int{}
	var out []Listener
	for _, c := range conns {
		if c.Status != "LISTEN" || c.Laddr.Port == 0 {
			continue
		}
		k := key{int(c.Laddr.Port), c.Pid}
		if i, ok := seen[k]; ok {
			// Prefer the IPv4 address for display.
			if strings.Contains(out[i].Address, ":") && !strings.Contains(c.Laddr.IP, ":") {
				out[i].Address = c.Laddr.IP
			}
			continue
		}
		seen[k] = len(out)
		out = append(out, Listener{Port: int(c.Laddr.Port), Address: c.Laddr.IP, PID: int(c.Pid)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out, nil
}

// Proc returns a process's parent and command line.
func (System) Proc(ctx context.Context, pid int) (Proc, bool) {
	p, err := process.NewProcessWithContext(ctx, int32(pid))
	if err != nil {
		return Proc{}, false
	}
	ppid, err := p.PpidWithContext(ctx)
	if err != nil {
		return Proc{}, false
	}
	cmd, _ := p.CmdlineSliceWithContext(ctx)
	if len(cmd) == 0 {
		if exe, err := p.ExeWithContext(ctx); err == nil {
			cmd = []string{exe}
		} else if name, err := p.NameWithContext(ctx); err == nil {
			cmd = []string{name}
		}
	}
	return Proc{PID: pid, PPID: int(ppid), Cmdline: cmd}, true
}

// Cwd returns a process's working directory, or "" when it cannot be read.
func (System) Cwd(ctx context.Context, pid int) string {
	p, err := process.NewProcessWithContext(ctx, int32(pid))
	if err != nil {
		return ""
	}
	cwd, err := p.CwdWithContext(ctx)
	if err != nil {
		return ""
	}
	return cwd
}

// Cache memoises process lookups for one snapshot.
type Cache struct {
	src   Source
	mu    sync.Mutex
	procs map[int]*Proc
	cwds  map[int]string
}

// NewCache wraps a source.
func NewCache(src Source) *Cache {
	return &Cache{src: src, procs: map[int]*Proc{}, cwds: map[int]string{}}
}

// Proc returns the process, or nil.
func (c *Cache) Proc(ctx context.Context, pid int) *Proc {
	if pid <= 0 {
		return nil
	}
	c.mu.Lock()
	p, ok := c.procs[pid]
	c.mu.Unlock()
	if ok {
		return p
	}
	if got, ok := c.src.Proc(ctx, pid); ok {
		p = &got
	}
	c.mu.Lock()
	c.procs[pid] = p
	c.mu.Unlock()
	return p
}

// Cwd returns the process's working directory.
func (c *Cache) Cwd(ctx context.Context, pid int) string {
	if pid <= 0 {
		return ""
	}
	c.mu.Lock()
	d, ok := c.cwds[pid]
	c.mu.Unlock()
	if ok {
		return d
	}
	d = c.src.Cwd(ctx, pid)
	c.mu.Lock()
	c.cwds[pid] = d
	c.mu.Unlock()
	return d
}

// Ancestors returns pid's chain of parents, nearest first, without pid itself.
func (c *Cache) Ancestors(ctx context.Context, pid int) []int {
	var out []int
	seen := map[int]bool{pid: true}
	for p := c.Proc(ctx, pid); p != nil && p.PPID > 1 && !seen[p.PPID]; p = c.Proc(ctx, p.PPID) {
		seen[p.PPID] = true
		out = append(out, p.PPID)
		if len(out) > 64 {
			break
		}
	}
	return out
}

var interpreters = map[string]bool{"node": true, "bun": true, "deno": true, "python": true, "python3": true, "ruby": true, "php": true, "java": true}

// DisplayName is a short name for a process: "vite", "next-server", "postgres".
// For interpreters it shows the script it runs ("node vite").
func DisplayName(cmd []string) string {
	if len(cmd) == 0 {
		return ""
	}
	first := cmd[0]
	if strings.Contains(first, " ") && !strings.Contains(first, "/") && !strings.Contains(first, `\`) {
		// Some programs rewrite their argv into one string.
		first = strings.Fields(first)[0]
	}
	base := strings.TrimSuffix(baseName(first), ".exe")
	if !interpreters[base] {
		return base
	}
	for _, a := range cmd[1:] {
		if strings.HasPrefix(a, "-") {
			if a == "-e" || a == "-c" {
				return base
			}
			continue
		}
		script := baseName(a)
		script = strings.TrimSuffix(script, filepath.Ext(script))
		if script == "cli" || script == "index" || script == "bin" {
			// node_modules/vite/bin/vite.js style paths: use the package name.
			parts := strings.Split(filepath.ToSlash(a), "/")
			for i := len(parts) - 2; i >= 0; i-- {
				if parts[i] != "bin" && parts[i] != "dist" && parts[i] != "" {
					script = parts[i]
					break
				}
			}
		}
		return base + " " + script
	}
	return base
}

func baseName(p string) string {
	p = strings.ReplaceAll(p, `\`, "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		p = p[i+1:]
	}
	return p
}
