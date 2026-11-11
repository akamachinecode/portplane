// Package webui embeds the built web UI (web/ builds into dist/).
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS returns the built UI, rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // the directory is embedded at compile time
	}
	return sub
}

// Built reports whether the UI was built before compiling the binary.
func Built() bool {
	_, err := fs.Stat(FS(), "index.html")
	return err == nil
}
