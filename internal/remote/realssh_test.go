package remote

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/portless"
)

// TestRealSSH drives a real ssh connection end to end. It runs only when
// PORTPLANE_E2E_SSH_CONFIG (an ssh config file), PORTPLANE_E2E_SSH_HOST and
// PORTPLANE_E2E_FOLDER (a folder with dekit tasks on the remote) are set.
func TestRealSSH(t *testing.T) {
	cfg, host, folder := os.Getenv("PORTPLANE_E2E_SSH_CONFIG"), os.Getenv("PORTPLANE_E2E_SSH_HOST"), os.Getenv("PORTPLANE_E2E_FOLDER")
	if cfg == "" || host == "" || folder == "" {
		t.Skip("set PORTPLANE_E2E_SSH_CONFIG, PORTPLANE_E2E_SSH_HOST and PORTPLANE_E2E_FOLDER")
	}
	bin := filepath.Join(t.TempDir(), "portplane")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/portplane")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	ssh := &SSH{Host: host, Args: []string{"-F", cfg}, Self: bin}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd, err := ssh.Install(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("agent command: %s", cmd)

	a := NewAgent("box", "box", []string{folder}, ssh)
	fwd := NewForwarder(portless.New())
	defer fwd.Close()
	w := fwd.Wrap(a, "box")
	defer func() { _ = w.Close() }()
	snaps := w.Watch(ctx)
	var s model.MachineSnapshot
	for s = range snaps {
		if s.Machine.Status == "online" && len(s.Apps) > 0 {
			break
		}
		if s.Machine.Status == "offline" {
			t.Fatalf("offline: %s", s.Machine.Error)
		}
	}
	t.Logf("remote tools: dekit %q portless %q, %d apps", s.Tools.Dekit, s.Tools.Portless, len(s.Apps))
	if s.Tools.Dekit == "" {
		t.Fatal("the remote agent did not find dekit (PATH)")
	}
	var web model.App
	for _, app := range s.Apps {
		if strings.HasSuffix(app.Task, "/web") {
			web = app
		}
	}
	if web.Task == "" {
		t.Fatalf("no web app in %+v", s.Apps)
	}
	if err := a.Act(ctx, model.Target{Machine: "box", Runner: web.Runner, Task: web.Task}, model.VerbStart); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = a.Act(context.Background(), model.Target{Machine: "box", Runner: web.Runner, Task: web.Task}, model.VerbStop)
	}()
	for s = range snaps {
		for _, app := range s.Apps {
			if app.Task == web.Task && app.RemoteURL != "" {
				web = app
			}
		}
		if web.RemoteURL != "" {
			break
		}
	}
	t.Logf("remote app %s on :%d, opened locally at %s", web.Task, web.Port, web.RemoteURL)
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}} //nolint:gosec // local CA
	resp, err := client.Get(web.RemoteURL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	t.Logf("GET %s -> %d %q", web.RemoteURL, resp.StatusCode, body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
