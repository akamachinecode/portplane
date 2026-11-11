// Package buildinfo reports the version of the running binary.
package buildinfo

import (
	"runtime"
	"runtime/debug"
)

// Set at link time by goreleaser: -X github.com/akamachinecode/portplane/internal/buildinfo.version=...
var (
	version = ""
	commit  = ""
	date    = ""
)

// Info describes a build.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
	Date    string `json:"date,omitempty"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// Get returns the build information, falling back to the module and VCS data
// that `go build` embeds when the link-time values are empty.
func Get() Info {
	info := Info{Version: version, Commit: commit, Date: date, OS: runtime.GOOS, Arch: runtime.GOARCH}
	if bi, ok := debug.ReadBuildInfo(); ok {
		if info.Version == "" && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
			info.Version = bi.Main.Version
		}
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				if info.Commit == "" {
					info.Commit = s.Value
				}
			case "vcs.time":
				if info.Date == "" {
					info.Date = s.Value
				}
			}
		}
	}
	if info.Version == "" {
		info.Version = "dev"
	}
	return info
}

// Version returns just the version string.
func Version() string { return Get().Version }
