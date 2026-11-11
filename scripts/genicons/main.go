// Command genicons writes the Portplane icons used by packaging:
// portplane.icns (macOS app), portplane.png (Linux) and portplane.ico (Windows).
package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"

	"github.com/akamachinecode/portplane/internal/icon"
)

func main() {
	out := flag.String("out", "build/icons", "output folder")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	files := map[string][]byte{
		"portplane.icns":   icon.ICNS(),
		"portplane.png":    icon.PNG(256, 2),
		"portplane.ico":    icon.ICO(icon.PNG(16, 2), icon.PNG(32, 2), icon.PNG(48, 2), icon.PNG(256, 2)),
		"tray-preview.png": icon.TemplatePNG(44, 1),
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(*out, name), b, 0o644); err != nil {
			log.Fatal(err)
		}
	}
}
