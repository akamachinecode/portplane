package portless

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// portless's block in the hosts file (plan §5.7): `portless hosts sync`
// writes the route hostnames between "# portless-start" and
// "# portless-end", for names the system resolver would not send to
// 127.0.0.1 on its own (any domain but .localhost, and Safari).

const (
	hostsStart = "# portless-start"
	hostsEnd   = "# portless-end"
)

// HostsEntry is one line of the block.
type HostsEntry struct {
	Address string   `json:"address"`
	Names   []string `json:"names"`
}

// HostsState compares the block with the live routes.
type HostsState struct {
	Path     string       `json:"path"`
	Readable bool         `json:"readable"`
	Block    bool         `json:"block"` // the markers are there
	Entries  []HostsEntry `json:"entries"`
	// Missing are route hostnames the block lacks; Extra are names in the
	// block no route has any more.
	Missing []string `json:"missing"`
	Extra   []string `json:"extra"`
	InSync  bool     `json:"inSync"`
}

// HostsPath is the hosts file of this system.
func HostsPath() string {
	if runtime.GOOS == "windows" {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		return filepath.Join(root, "System32", "drivers", "etc", "hosts")
	}
	return "/etc/hosts"
}

// ParseHostsBlock reads portless's block from a hosts file, as portless's
// extractManagedBlock does: the lines between the first start marker and
// the first end marker after it.
func ParseHostsBlock(content string) (bool, []HostsEntry) {
	start := strings.Index(content, hostsStart)
	end := strings.Index(content, hostsEnd)
	if start < 0 || end < 0 || end <= start {
		return false, []HostsEntry{}
	}
	entries := []HostsEntry{}
	for _, line := range strings.Split(content[start+len(hostsStart):end], "\n") {
		line, _, _ = strings.Cut(line, "#")
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		entries = append(entries, HostsEntry{Address: fields[0], Names: fields[1:]})
	}
	return true, entries
}

// CompareHosts reads the hosts file at path and compares its block with the
// hostnames of the live routes.
func CompareHosts(path string, hostnames []string) HostsState {
	st := HostsState{Path: path, Entries: []HostsEntry{}, Missing: []string{}, Extra: []string{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return st
	}
	st.Readable = true
	st.Block, st.Entries = ParseHostsBlock(string(b))
	inBlock := map[string]bool{}
	for _, e := range st.Entries {
		for _, n := range e.Names {
			if e.Address == "127.0.0.1" {
				inBlock[n] = true
			}
		}
	}
	wanted := map[string]bool{}
	for _, h := range hostnames {
		wanted[h] = true
		if !inBlock[h] {
			st.Missing = append(st.Missing, h)
		}
	}
	for n := range inBlock {
		if !wanted[n] {
			st.Extra = append(st.Extra, n)
		}
	}
	sort.Strings(st.Missing)
	sort.Strings(st.Extra)
	st.InSync = len(st.Missing) == 0 && len(st.Extra) == 0
	return st
}
