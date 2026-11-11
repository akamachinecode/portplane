package remote

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Candidate is a machine the user could add.
type Candidate struct {
	Host   string `json:"host"`   // what to pass to ssh
	Name   string `json:"name"`   // display name
	Source string `json:"source"` // ssh-config or tailscale
	OS     string `json:"os,omitempty"`
	Online *bool  `json:"online,omitempty"`
}

// Candidates lists hosts from ~/.ssh/config and Tailscale peers.
func Candidates(ctx context.Context) []Candidate {
	var out []Candidate
	seen := map[string]bool{}
	home, _ := os.UserHomeDir()
	if home != "" {
		for _, h := range SSHConfigHosts(filepath.Join(home, ".ssh", "config")) {
			if !seen[h] {
				seen[h] = true
				out = append(out, Candidate{Host: h, Name: h, Source: "ssh-config"})
			}
		}
	}
	for _, c := range tailscalePeers(ctx) {
		if !seen[c.Host] {
			seen[c.Host] = true
			out = append(out, c)
		}
	}
	return out
}

// SSHConfigHosts returns the concrete Host aliases of an ssh config file
// and the files it includes (patterns with *, ? or ! are skipped).
func SSHConfigHosts(path string) []string {
	var hosts []string
	seen := map[string]bool{}
	var walk func(p string, depth int)
	walk = func(p string, depth int) {
		if depth > 5 {
			return
		}
		f, err := os.Open(p)
		if err != nil {
			return
		}
		defer func() { _ = f.Close() }()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, rest := splitDirective(line)
			switch strings.ToLower(key) {
			case "host":
				for _, h := range strings.Fields(rest) {
					if strings.ContainsAny(h, "*?!") || seen[h] {
						continue
					}
					seen[h] = true
					hosts = append(hosts, h)
				}
			case "include":
				for _, pat := range strings.Fields(rest) {
					if strings.HasPrefix(pat, "~/") {
						if home, err := os.UserHomeDir(); err == nil {
							pat = filepath.Join(home, pat[2:])
						}
					} else if !filepath.IsAbs(pat) {
						pat = filepath.Join(filepath.Dir(path), pat)
					}
					matches, _ := filepath.Glob(pat)
					sort.Strings(matches)
					for _, m := range matches {
						walk(m, depth+1)
					}
				}
			}
		}
	}
	walk(path, 0)
	return hosts
}

func splitDirective(line string) (string, string) {
	if i := strings.IndexAny(line, " \t="); i >= 0 {
		return line[:i], strings.TrimLeft(line[i:], " \t=")
	}
	return line, ""
}

func tailscalePeers(ctx context.Context) []Candidate {
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "status", "--json").Output()
	if err != nil {
		return nil
	}
	return parseTailscale(out)
}

func parseTailscale(b []byte) []Candidate {
	var st struct {
		Peer map[string]struct {
			HostName string `json:"HostName"`
			DNSName  string `json:"DNSName"`
			OS       string `json:"OS"`
			Online   bool   `json:"Online"`
		} `json:"Peer"`
	}
	if json.Unmarshal(b, &st) != nil {
		return nil
	}
	var out []Candidate
	for _, p := range st.Peer {
		host := strings.TrimSuffix(p.DNSName, ".")
		if host == "" {
			host = p.HostName
		}
		if host == "" || p.OS == "iOS" || p.OS == "android" {
			continue // phones have no localhost worth seeing
		}
		online := p.Online
		name := p.HostName
		if name == "" {
			name = host
		}
		out = append(out, Candidate{Host: host, Name: name, Source: "tailscale", OS: p.OS, Online: &online})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
