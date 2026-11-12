package portless

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// `portless doctor` as a list of checks (plan §5.8, ADR-0023). portless
// prints text meant for people and has no --json; this parser follows the
// format of portless 0.16 (testdata/0.16). A line it does not understand
// stays in the raw text and gets no fix.

// Finding statuses, as portless prints them.
const (
	FindingOK   = "ok"
	FindingWarn = "warn"
	FindingFail = "fail"
	FindingInfo = "info"
)

// Fixes Portplane offers for a finding. Each one maps to an action the
// user confirms first (see the server's portless actions).
const (
	FixStartProxy       = "proxy-start"
	FixRestartProxy     = "proxy-restart"
	FixTrust            = "trust"
	FixPrune            = "prune"
	FixHostsSync        = "hosts-sync"
	FixReinstallService = "service-install"
)

// Finding is one line of the diagnosis.
type Finding struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
	// Check groups findings: node, state, proxy, pid, openssl, ca, routes,
	// ports, lan, dns, service; "other" for a line Portplane can't place.
	Check string `json:"check"`
	// Fix is the action that addresses it (Fix* constants), or "".
	Fix string `json:"fix,omitempty"`
	// Subject is the hostname or path the finding is about, when it names one.
	Subject string `json:"subject,omitempty"`
}

// Doctor is the parsed report.
type Doctor struct {
	Version     string    `json:"version,omitempty"`
	Node        string    `json:"node,omitempty"`
	Platform    string    `json:"platform,omitempty"`
	StateDir    string    `json:"stateDir,omitempty"`
	ProxyTarget string    `json:"proxyTarget,omitempty"`
	Mode        string    `json:"mode,omitempty"`
	Findings    []Finding `json:"findings"`
	Failures    int       `json:"failures"`
	Warnings    int       `json:"warnings"`
	// Parsed is false when the output did not look like portless doctor's;
	// Unparsed holds lines that were not understood. Raw is the whole text.
	Parsed   bool     `json:"parsed"`
	Unparsed []string `json:"unparsed,omitempty"`
	Raw      string   `json:"raw"`
}

var (
	findingRe = regexp.MustCompile(`^(ok|warn|fail|info) +(\S.*)$`)
	summaryRe = regexp.MustCompile(`^Summary: (\d+) failures?, (\d+) warnings?\.$`)
)

// rule places a finding message and names its fix.
type rule struct {
	re    *regexp.Regexp
	check string
	fix   string
}

var doctorRules = []rule{
	{regexp.MustCompile(`^Node\.js \S+ (satisfies portless requirements|is unsupported)\.$`), "node", ""},
	{regexp.MustCompile(`^(Could not discover portless state|State (path|directory)|Could not inspect state directory)`), "state", ""},
	{regexp.MustCompile(`^Proxy is responding on port \d+\.$`), "proxy", ""},
	{regexp.MustCompile(`^Port \d+ is in use, but it is not a portless proxy\.$`), "proxy", ""},
	{regexp.MustCompile(`^Proxy is not running on port \d+\.$`), "proxy", FixStartProxy},
	{regexp.MustCompile(`^Proxy PID file points to the responding proxy process`), "pid", ""},
	{regexp.MustCompile(`^(Proxy PID file (is stale|is invalid|points to PID)|Proxy is running but the PID file is missing)`), "pid", FixRestartProxy},
	{regexp.MustCompile(`^Could not read proxy PID file`), "pid", ""},
	{regexp.MustCompile(`^Proxy is configured with a custom TLS certificate\.$`), "openssl", ""},
	{regexp.MustCompile(`^(OpenSSL is|HTTPS is disabled, so OpenSSL)`), "openssl", ""},
	{regexp.MustCompile(`^Local CA exists but is not trusted`), "ca", FixTrust},
	{regexp.MustCompile(`^(Generated CA file is missing|Local CA has not been generated yet)`), "ca", FixTrust},
	{regexp.MustCompile(`^(Local CA is trusted|Generated local CA is not required|HTTPS is disabled for the current proxy state)`), "ca", ""},
	{regexp.MustCompile(`^Routes: .*stale routes?\.$`), "routes", FixPrune},
	{regexp.MustCompile(`^Stale route \S+ is owned by exited PID \d+\.$`), "routes", FixPrune},
	{regexp.MustCompile(`^\d+ additional stale routes hidden\.$`), "routes", FixPrune},
	{regexp.MustCompile(`^(Routes: |No routes are registered|Could not read routes|Corrupted routes file|Could not read routes file)`), "routes", ""},
	{regexp.MustCompile(`^Route \S+ (has invalid port|points to port)`), "ports", ""},
	{regexp.MustCompile(`^(mDNS publishing support|LAN mode is enabled|LAN IP is recorded)`), "lan", ""},
	{regexp.MustCompile(`^\d+ hostnames? did not resolve through the system resolver\.$`), "dns", FixHostsSync},
	{regexp.MustCompile(`^\S+ is (present in|missing from) hosts block\.$`), "dns", FixHostsSync},
	{regexp.MustCompile(`^Registered hostnames resolve`), "dns", ""},
}

var subjectRes = []*regexp.Regexp{
	regexp.MustCompile(`^(?:Stale route|Route) (\S+) `),
	regexp.MustCompile(`^(\S+) is (?:present in|missing from) hosts block`),
	regexp.MustCompile(`: (/\S+)$`),
}

// classify fills in a finding's check, fix and subject.
func classify(f *Finding) {
	f.Check = "other"
	for _, r := range doctorRules {
		if r.re.MatchString(f.Message) {
			f.Check = r.check
			if f.Status == FindingWarn || f.Status == FindingFail || (f.Status == FindingInfo && r.fix == FixTrust) {
				f.Fix = r.fix
			}
			break
		}
	}
	for _, re := range subjectRes {
		if m := re.FindStringSubmatch(f.Message); m != nil {
			f.Subject = m[1]
			break
		}
	}
}

// ParseDoctor reads the output of `portless doctor` (portless 0.16).
func ParseDoctor(text string) Doctor {
	d := Doctor{Raw: text, Findings: []Finding{}}
	clean := stripANSI(strings.ReplaceAll(text, "\r\n", "\n"))
	title, summary := false, false
	for _, line := range strings.Split(clean, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if trimmed == "portless doctor" {
			title = true
			continue
		}
		if m := summaryRe.FindStringSubmatch(trimmed); m != nil {
			d.Failures, _ = strconv.Atoi(m[1])
			d.Warnings, _ = strconv.Atoi(m[2])
			summary = true
			continue
		}
		// A hint is indented under its finding.
		if strings.HasPrefix(line, "      ") && len(d.Findings) > 0 && d.Findings[len(d.Findings)-1].Hint == "" {
			d.Findings[len(d.Findings)-1].Hint = trimmed
			continue
		}
		if m := findingRe.FindStringSubmatch(line); m != nil {
			f := Finding{Status: m[1], Message: strings.TrimSpace(m[2])}
			classify(&f)
			d.Findings = append(d.Findings, f)
			continue
		}
		if key, val, ok := strings.Cut(trimmed, ": "); ok && header(&d, key, val) {
			continue
		}
		d.Unparsed = append(d.Unparsed, trimmed)
	}
	if !summary {
		// An older or newer portless: count what was read.
		for _, f := range d.Findings {
			switch f.Status {
			case FindingFail:
				d.Failures++
			case FindingWarn:
				d.Warnings++
			}
		}
	}
	d.Parsed = title && len(d.Findings) > 0
	return d
}

func header(d *Doctor, key, val string) bool {
	switch key {
	case "Version":
		d.Version = val
	case "Node.js":
		d.Node = val
	case "Platform":
		d.Platform = val
	case "State dir":
		d.StateDir = val
	case "Proxy target":
		d.ProxyTarget = val
	case "Mode":
		d.Mode = val
	default:
		return false
	}
	return true
}

// Doctor runs `portless doctor`, which only reads state. It exits with an
// error when it finds failures; the report is returned all the same.
func (c *Client) Doctor(ctx context.Context) (Doctor, error) {
	out, err := c.runLong(ctx, "doctor")
	d := ParseDoctor(out)
	if err != nil && !d.Parsed {
		return d, err
	}
	return d, nil
}
