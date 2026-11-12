package portless

import (
	"fmt"
	"strings"
)

// Names portless gives apps (plan §5.4), checked the way portless 0.16
// checks them (parseHostname): lowercase letters, digits, dashes and dots,
// labels of at most 63 characters, at most 253 in all, and no name that
// portless would read as one of its own commands.

// ReservedNames are portless's subcommands: `portless proxy …` starts the
// proxy, it never wraps an app called "proxy".
var ReservedNames = []string{"run", "get", "alias", "compose", "hosts", "list", "doctor", "trust", "clean", "prune", "proxy", "service", "mcp"}

// Limits from DNS, as portless enforces them.
const (
	MaxLabel    = 63
	MaxHostname = 253
)

// NameProblem says why name cannot be a portless name with the given
// top-level domain ("localhost" when empty), or "" when it can. The name
// may end in the domain already.
func NameProblem(name, tld string) string {
	if tld == "" {
		tld = "localhost"
	}
	name = strings.TrimSpace(name)
	base := strings.TrimSuffix(name, "."+tld)
	switch {
	case base == "":
		return "Type a name."
	case strings.HasPrefix(base, "-") || strings.HasPrefix(base, "."):
		return "Start the name with a letter or a digit."
	case strings.HasSuffix(base, "-") || strings.HasSuffix(base, "."):
		return "End the name with a letter or a digit."
	case strings.Contains(base, ".."):
		return "Two dots in a row aren't allowed."
	}
	for _, r := range base {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '.' {
			if r >= 'A' && r <= 'Z' {
				return "Use lowercase letters."
			}
			return fmt.Sprintf("%q isn't allowed: use letters, digits, dashes and dots.", string(r))
		}
	}
	for _, label := range strings.Split(base, ".") {
		if len(label) > MaxLabel {
			return fmt.Sprintf("%q is longer than %d characters, the limit for one part of a name.", label, MaxLabel)
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "Each part between dots must start and end with a letter or a digit."
		}
	}
	if len(base)+1+len(tld) > MaxHostname {
		return fmt.Sprintf("The address would be longer than %d characters.", MaxHostname)
	}
	for _, r := range ReservedNames {
		if base == r {
			return fmt.Sprintf("%q is one of portless's own commands; pick another name.", r)
		}
	}
	return ""
}

// Hostname is the hostname portless builds from a name and a top-level
// domain, such as "api.shop" and "localhost" → "api.shop.localhost".
func Hostname(name, tld string) string {
	if tld == "" {
		tld = "localhost"
	}
	name = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), "."+tld)
	if name == "" {
		return ""
	}
	return name + "." + tld
}

// BaseName is a hostname without its top-level domain, trying each of tlds
// (longest first, as portless does), or the hostname itself.
func BaseName(hostname string, tlds []string) string {
	best := ""
	for _, t := range append([]string{"localhost"}, tlds...) {
		if strings.HasSuffix(hostname, "."+t) && len(t) > len(best) {
			best = t
		}
	}
	if best == "" {
		return hostname
	}
	return strings.TrimSuffix(hostname, "."+best)
}
