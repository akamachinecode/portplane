package portless

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

// What the installed service runs: Node, portless's script and the proxy
// options, read back from the systemd unit or the launchd plist portless
// wrote (portless 0.16 does the same in readInstalledServiceSnapshot). The
// options are what "Apply" starts from, and the program tells whether an
// upgrade left the service pointing at files that are gone.

// ServiceProgram is the service's command line.
type ServiceProgram struct {
	Node   string   `json:"node"`
	Script string   `json:"script"`
	Args   []string `json:"args"` // after the script: proxy start --port 443 …
	// NodeMissing and ScriptMissing: the file is gone, so the service
	// can't start until it is installed again.
	NodeMissing   bool `json:"nodeMissing"`
	ScriptMissing bool `json:"scriptMissing"`
}

// Options are the proxy options the service starts with, when its command
// is `… proxy start <flags>`.
func (p ServiceProgram) Options() (ProxyOptions, bool) {
	return OptionsFromArgs(p.Args)
}

var plistArgsRe = regexp.MustCompile(`(?s)<key>ProgramArguments</key>\s*<array>(.*?)</array>`)

// ParseServiceProgram reads the command from a systemd unit (ExecStart) or
// a launchd plist (ProgramArguments). ok is false for anything else.
func ParseServiceProgram(entry string) (ServiceProgram, bool) {
	var words []string
	for _, line := range strings.Split(entry, "\n") {
		if rest, found := strings.CutPrefix(strings.TrimSpace(line), "ExecStart="); found {
			words = quotedWords(rest)
			break
		}
	}
	if words == nil {
		if m := plistArgsRe.FindStringSubmatch(entry); m != nil {
			for _, s := range plistStringRe.FindAllStringSubmatch(m[1], -1) {
				words = append(words, xmlUnescape(s[1]))
			}
		}
	}
	if len(words) < 2 {
		return ServiceProgram{}, false
	}
	return ServiceProgram{Node: words[0], Script: words[1], Args: words[2:]}, true
}

// ReadServiceProgram reads the service entry at path and checks that its
// Node and script still exist.
func ReadServiceProgram(path string) (ServiceProgram, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return ServiceProgram{}, false
	}
	p, ok := ParseServiceProgram(string(b))
	if !ok {
		return p, false
	}
	_, err = os.Stat(p.Node)
	p.NodeMissing = err != nil
	_, err = os.Stat(p.Script)
	p.ScriptMissing = err != nil
	return p, true
}

// quotedWords splits a systemd ExecStart line as portless writes it: each
// word in double quotes, with \" and \\ escaped.
func quotedWords(s string) []string {
	var words []string
	var cur strings.Builder
	inQuote, inWord := false, false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case ch == '"':
			inQuote, inWord = !inQuote, true
		case ch == '\\' && i+1 < len(s) && (s[i+1] == '"' || s[i+1] == '\\'):
			cur.WriteByte(s[i+1])
			inWord = true
			i++
		case (ch == ' ' || ch == '\t') && !inQuote:
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteByte(ch)
			inWord = true
		}
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words
}

func xmlUnescape(s string) string {
	return strings.NewReplacer("&apos;", "'", "&quot;", `"`, "&gt;", ">", "&lt;", "<", "&amp;", "&").Replace(s)
}

// OptionsFromArgs reads proxy options from `proxy start` flags (with or
// without the leading "proxy start"). ok is false when a flag is unknown.
func OptionsFromArgs(args []string) (ProxyOptions, bool) {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "proxy" && args[i+1] == "start" {
			args = args[i+2:]
			break
		}
	}
	o := ProxyOptions{HTTPS: true}
	portSet, httpsSet := false, false
	var tlds []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		next := func() string {
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch a {
		case "-p", "--port":
			o.Port, _ = strconv.Atoi(next())
			portSet = true
		case "--https":
			o.HTTPS, httpsSet = true, true
		case "--no-tls":
			o.HTTPS, httpsSet = false, true
		case "--lan":
			o.LAN = true
		case "--ip":
			o.LAN, o.LANIP = true, next()
		case "--tld":
			tlds = append(tlds, splitTLDs(next())...)
		case "--wildcard":
			o.Wildcard = true
		case "--unprivileged":
			o.Unprivileged = true
		case "--cert":
			o.CertPath, o.HTTPS, httpsSet = next(), true, true
		case "--key":
			o.KeyPath, o.HTTPS, httpsSet = next(), true, true
		case "--foreground", "--skip-trust":
		case "--state-dir":
			next()
		default:
			return o, false
		}
	}
	if o.Unprivileged && !httpsSet {
		o.HTTPS = false
	}
	if !portSet {
		o.Port = 80
		if o.HTTPS {
			o.Port = DefaultPort
		}
	}
	o.TLDs = tlds
	if len(o.TLDs) == 0 {
		o.TLDs = []string{"localhost"}
	}
	if o.LAN {
		o.TLDs = []string{"local"}
	}
	return o, true
}
