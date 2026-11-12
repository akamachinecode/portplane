// Package remote connects Portplane to agents on other machines over SSH
// (ADR-0015): the same binary runs `portplane agent --stdio` there, and the
// two ends multiplex streams over the SSH session's stdin and stdout.
package remote

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"github.com/akamachinecode/portplane/internal/agent"
	"github.com/akamachinecode/portplane/internal/buildinfo"
	"github.com/akamachinecode/portplane/internal/model"
)

// Protocol is the wire version. Both ends must speak the same one.
const Protocol = 1

// message is one JSON line on the control stream.
type message struct {
	ID     uint64          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// Hello is the first exchange.
type Hello struct {
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Hostname string `json:"hostname"`

	// Machine is the id Portplane knows the agent's machine by (sent by
	// Portplane; older agents ignore it).
	Machine string `json:"machine,omitempty"`
}

type actParams struct {
	Target model.Target `json:"target"`
	Verb   model.Verb   `json:"verb"`
}

type taskParams struct {
	Runner string `json:"runner"`
	Task   string `json:"task,omitempty"`
}

type foldersParams struct {
	Folders []string `json:"folders"`
}

type intervalParams struct {
	Millis int64 `json:"ms"`
}

// dialHeader opens a data stream.
type dialHeader struct {
	Dial int `json:"dial"`
}

func yamuxConfig() *yamux.Config {
	c := yamux.DefaultConfig()
	c.LogOutput = io.Discard
	c.EnableKeepAlive = true
	c.KeepAliveInterval = 15 * time.Second
	c.ConnectionWriteTimeout = 20 * time.Second
	return c
}

// Stdio joins a process's stdin and stdout into one connection.
func Stdio(in io.ReadCloser, out io.WriteCloser) io.ReadWriteCloser {
	return stdio{Reader: in, Writer: out, closers: []io.Closer{in, out}}
}

type stdio struct {
	io.Reader
	io.Writer
	closers []io.Closer
}

func (s stdio) Close() error {
	var first error
	for _, c := range s.closers {
		if err := c.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// Serve runs the agent side on conn (stdin+stdout of `portplane agent
// --stdio`) until the session ends.
func Serve(ctx context.Context, conn io.ReadWriteCloser, a agent.Agent) error {
	return ServeWith(ctx, conn, a, ServeOptions{})
}

// ServeWith is Serve with the machine's API and jobs (ADR-0026).
func ServeWith(ctx context.Context, conn io.ReadWriteCloser, a agent.Agent, o ServeOptions) error {
	sess, err := yamux.Server(conn, yamuxConfig())
	if err != nil {
		return err
	}
	defer func() { _ = sess.Close() }()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = sess.Close()
	}()

	// The first stream is control; every later one is a dial.
	ctl, err := sess.Accept()
	if err != nil {
		return err
	}
	go func() {
		for {
			s, err := sess.Accept()
			if err != nil {
				return
			}
			go serveDial(ctx, s, a)
		}
	}()
	return serveControl(ctx, ctl, a, o)
}

func serveDial(ctx context.Context, s net.Conn, a agent.Agent) {
	defer func() { _ = s.Close() }()
	r := bufio.NewReader(s)
	line, err := r.ReadBytes('\n')
	if err != nil {
		return
	}
	var h dialHeader
	if json.Unmarshal(line, &h) != nil || h.Dial <= 0 {
		_, _ = io.WriteString(s, "error: bad dial header\n")
		return
	}
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	target, err := a.Dial(dctx, h.Dial)
	cancel()
	if err != nil {
		_, _ = io.WriteString(s, "error: "+err.Error()+"\n")
		return
	}
	defer func() { _ = target.Close() }()
	if _, err := io.WriteString(s, "ok\n"); err != nil {
		return
	}
	pipe(target, &bufferedConn{Conn: s, r: r})
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.r.Read(p) }

// pipe copies both ways until either side closes.
func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	_ = a.Close()
	_ = b.Close()
	<-done
}

func serveControl(ctx context.Context, ctl net.Conn, a agent.Agent, o ServeOptions) error {
	defer func() { _ = ctl.Close() }()
	var wmu sync.Mutex
	enc := json.NewEncoder(ctl)
	send := func(m message) error {
		wmu.Lock()
		defer wmu.Unlock()
		return enc.Encode(m)
	}
	var watchOnce, jobsOnce sync.Once
	watchJobs := func() {
		jobsOnce.Do(func() {
			go func() {
				for j := range o.Jobs.Subscribe(ctx) {
					b, _ := json.Marshal(j)
					if send(message{Method: "job", Params: b}) != nil {
						return
					}
				}
			}()
		})
	}
	dec := json.NewDecoder(bufio.NewReader(ctl))
	for {
		var m message
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) || ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func(m message) {
			if m.Method == "watchJobs" && o.Jobs != nil {
				watchJobs()
				_ = send(message{ID: m.ID, Result: json.RawMessage("{}")})
				return
			}
			res, err := dispatch(ctx, a, o, m, func() {
				watchOnce.Do(func() {
					go func() {
						for s := range a.Watch(ctx) {
							b, _ := json.Marshal(s)
							if send(message{Method: "snapshot", Params: b}) != nil {
								return
							}
						}
					}()
				})
			})
			reply := message{ID: m.ID}
			if err != nil {
				reply.Error = err.Error()
			} else {
				reply.Result, _ = json.Marshal(res)
			}
			_ = send(reply)
		}(m)
	}
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return home + p[1:]
		}
	}
	return p
}

func dispatch(ctx context.Context, a agent.Agent, o ServeOptions, m message, watch func()) (any, error) {
	switch m.Method {
	case "hello":
		var h Hello
		_ = json.Unmarshal(m.Params, &h)
		if h.Protocol != Protocol {
			return nil, fmt.Errorf("protocol %d not supported (agent speaks %d)", h.Protocol, Protocol)
		}
		if h.Machine != "" && o.OnHello != nil {
			o.OnHello(h)
		}
		host, _ := os.Hostname()
		return Hello{Protocol: Protocol, Version: buildinfo.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH, Hostname: host}, nil
	case "snapshot":
		return a.Snapshot(ctx)
	case "watch":
		watch()
		return struct{}{}, nil
	case "setFolders":
		var p foldersParams
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		// Apply the folders that exist and name the missing ones, so one
		// moved folder does not hide the rest of the machine.
		var ok, missing []string
		for _, f := range p.Folders {
			if fi, err := os.Stat(expandHome(f)); err == nil && fi.IsDir() {
				ok = append(ok, f)
			} else {
				missing = append(missing, f)
			}
		}
		if err := a.SetFolders(ctx, ok); err != nil {
			return nil, err
		}
		if len(missing) > 0 {
			return nil, fmt.Errorf("not found on this machine: %s", strings.Join(missing, ", "))
		}
		return struct{}{}, nil
	case "act":
		var p actParams
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		return struct{}{}, a.Act(ctx, p.Target, p.Verb)
	case "up":
		var p taskParams
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		return struct{}{}, a.Up(ctx, p.Runner)
	case "excerpt":
		var p taskParams
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		return a.Excerpt(ctx, p.Runner, p.Task)
	case "output":
		var p taskParams
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		return a.Output(ctx, p.Runner, p.Task)
	case "http":
		if o.API == nil {
			break // like an agent from before ADR-0026
		}
		var req APIRequest
		if err := json.Unmarshal(m.Params, &req); err != nil {
			return nil, err
		}
		return serveAPI(ctx, o.API, req)
	case "setInterval":
		var p intervalParams
		if err := json.Unmarshal(m.Params, &p); err != nil {
			return nil, err
		}
		if pacer, ok := a.(interface{ SetInterval(time.Duration) }); ok && p.Millis > 0 {
			pacer.SetInterval(time.Duration(p.Millis) * time.Millisecond)
		}
		return struct{}{}, nil
	}
	return nil, errors.New("unknown method " + strconv.Quote(m.Method))
}
