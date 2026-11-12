// Command portplane-window shows the Portplane UI in a native window on
// Linux. Portplane starts it; it is not meant to be run by hand (ADR-0018).
package main

import (
	"os"

	"github.com/akamachinecode/portplane/internal/gtkwindow"
)

func main() {
	os.Exit(gtkwindow.Main(os.Args[1:], os.Stderr))
}
