//go:build windows

package notify

import (
	"encoding/base64"
	"testing"
)

func TestEncodedCommand(t *testing.T) {
	b, _ := base64.StdEncoding.DecodeString(encodedCommand("hi é"))
	if string(b) != "h\x00i\x00 \x00\xe9\x00" {
		t.Fatalf("%q", b)
	}
}

func TestToastEnv(t *testing.T) {
	env := toastEnv(Options{AppName: "Portplane", LaunchBase: "http://127.0.0.1:4799"}, Notification{Title: "web crashed", Body: "a\x00b", Route: "#/health"})
	want := []string{"PORTPLANE_TOAST_TITLE=Portplane: web crashed", "PORTPLANE_TOAST_BODY=ab", "PORTPLANE_TOAST_LAUNCH=http://127.0.0.1:4799/#/health"}
	for i := range want {
		if env[i] != want[i] {
			t.Fatalf("%q, want %q", env, want)
		}
	}
}
