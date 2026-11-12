package portless

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ProxyState is how the proxy stands now (plan §5.1), from portless's state
// files (proxy.port, proxy.tls, proxy.tlds, proxy.lan, proxy.unprivileged,
// proxy.custom-cert, proxy.pid) and a request to the proxy itself.
type ProxyState struct {
	// Responding: a HEAD request got portless's own X-Portless: 1 header.
	Responding bool `json:"responding"`
	// Running: the process in proxy.pid is alive.
	Running      bool     `json:"running"`
	Port         int      `json:"port"`
	HTTPS        bool     `json:"https"`
	TLDs         []string `json:"tlds"`
	LAN          bool     `json:"lan"`
	LANIP        string   `json:"lanIp,omitempty"`
	Unprivileged bool     `json:"unprivileged"`
	CustomCert   bool     `json:"customCert"`
	PID          int      `json:"pid,omitempty"`
	// AsRoot: the proxy process belongs to the administrator (the service,
	// or a start with sudo), so stopping it needs the password.
	AsRoot bool `json:"asRoot"`
	// Configured: proxy.port exists, so the proxy has run with these settings.
	Configured bool `json:"configured"`
}

// ProxyState reads the proxy's state. It changes nothing.
func (c *Client) ProxyState(ctx context.Context) ProxyState {
	p := c.Proxy()
	st := ProxyState{Port: p.Port, HTTPS: p.HTTPS, Running: p.Running, TLDs: c.tlds()}
	if c.StateDir != "" {
		_, err := os.Stat(filepath.Join(c.StateDir, "proxy.port"))
		st.Configured = err == nil
		if b, err := os.ReadFile(filepath.Join(c.StateDir, "proxy.lan")); err == nil {
			st.LAN, st.LANIP = true, strings.TrimSpace(string(b))
		}
		st.Unprivileged = exists(filepath.Join(c.StateDir, "proxy.unprivileged"))
		st.CustomCert = exists(filepath.Join(c.StateDir, "proxy.custom-cert"))
		if b, err := os.ReadFile(filepath.Join(c.StateDir, "proxy.pid")); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
				st.PID = pid
				if st.Running {
					if uid, ok := processUID(pid); ok && uid == 0 {
						st.AsRoot = true
					}
				}
			}
		}
	}
	if st.LAN {
		st.TLDs = []string{"local"}
	}
	st.Responding = Probe(ctx, st.Port, st.HTTPS)
	return st
}

// tlds reads proxy.tlds (one per line, or a JSON list) or the older
// proxy.tld; localhost when neither exists.
func (c *Client) tlds() []string {
	if c.StateDir != "" {
		if b, err := os.ReadFile(filepath.Join(c.StateDir, "proxy.tlds")); err == nil {
			if out := splitTLDs(string(b)); len(out) > 0 {
				return out
			}
		}
		if b, err := os.ReadFile(filepath.Join(c.StateDir, "proxy.tld")); err == nil {
			if t := strings.TrimSpace(string(b)); t != "" {
				return []string{t}
			}
		}
	}
	return []string{"localhost"}
}

func splitTLDs(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(strings.TrimSuffix(s, "]"), "[")
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.FieldsFunc(s, func(r rune) bool { return r == '\n' || r == ',' || r == '\r' }) {
		t := strings.Trim(strings.TrimSpace(part), `"`)
		t = strings.TrimPrefix(strings.ToLower(t), ".")
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Probe asks 127.0.0.1:port whether a portless proxy answers, as portless
// does (a HEAD request and its X-Portless header). The certificate is not
// checked: this only reads a header from a local process, and an untrusted
// CA must not make a running proxy look stopped.
func Probe(ctx context.Context, port int, https bool) bool {
	if port <= 0 {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	scheme := "http"
	if https {
		scheme = "https"
	}
	tr := &http.Transport{
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // loopback probe of a header, see above
		Proxy:             nil,
		DisableKeepAlives: true,
		DialContext:       (&net.Dialer{Timeout: time.Second}).DialContext,
	}
	defer tr.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, scheme+"://127.0.0.1:"+strconv.Itoa(port)+"/", nil)
	if err != nil {
		return false
	}
	res, err := (&http.Client{Transport: tr, Timeout: 1500 * time.Millisecond}).Do(req)
	if err != nil {
		return false
	}
	_ = res.Body.Close()
	return res.Header.Get("X-Portless") == "1"
}

// URL is how URLs of this proxy look: https://<name>.localhost, with
// the port when it is not the scheme's default.
func (s ProxyState) URL(hostname string) string {
	return Proxy{Running: s.Running, Port: s.Port, HTTPS: s.HTTPS}.URL(hostname)
}

// MainTLD is the first top-level domain, the one new names get.
func (s ProxyState) MainTLD() string {
	if len(s.TLDs) == 0 {
		return "localhost"
	}
	return s.TLDs[0]
}
