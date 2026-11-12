package browsertrust

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func makeCA(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "portless Local CA"},
		NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func mkfile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const profilesINI = `[General]
StartWithLastProfile=1
Version=2

[Profile0]
Name=default-release
IsRelative=1
Path=abc.default-release

[Profile1]
Name=work
IsRelative=1
Path=def.work
Default=1

[Profile2]
Name=gone
IsRelative=1
Path=ghi.gone

[Install4F96D1932A9F858E]
Default=abc.default-release
Locked=1
`

// fakeCertutil is an NSS database in memory: dir -> PEM.
type fakeCertutil struct {
	dbs   map[string][]byte
	calls []string
}

func (f *fakeCertutil) run(_ context.Context, argv ...string) ([]byte, error) {
	f.calls = append(f.calls, strings.Join(argv[1:], " "))
	arg := func(flag string) string {
		for i, a := range argv {
			if a == flag && i+1 < len(argv) {
				return a + "=" + argv[i+1]
			}
		}
		return ""
	}
	db := strings.TrimPrefix(arg("-d"), "-d=")
	switch argv[1] {
	case "-L":
		if pemData, ok := f.dbs[db]; ok {
			return pemData, nil
		}
		return []byte("certutil: Could not find cert: portless Local CA"), errors.New("exit status 255")
	case "-A":
		b, err := os.ReadFile(strings.TrimPrefix(arg("-i"), "-i="))
		if err != nil {
			return nil, err
		}
		f.dbs[db] = b
		return nil, nil
	case "-D":
		delete(f.dbs, db)
		return nil, nil
	case "-N":
		dir := strings.TrimPrefix(db, "sql:")
		return nil, os.WriteFile(filepath.Join(dir, "cert9.db"), nil, 0o600)
	}
	return nil, errors.New("unexpected call")
}

func linuxHome(t *testing.T) (string, string) {
	t.Helper()
	home := t.TempDir()
	ca := filepath.Join(home, ".portless", "ca.pem")
	mkfile(t, ca, string(makeCA(t)))
	ff := filepath.Join(home, ".mozilla", "firefox")
	mkfile(t, filepath.Join(ff, "profiles.ini"), profilesINI)
	mkfile(t, filepath.Join(ff, "abc.default-release", "cert9.db"), "")
	mkfile(t, filepath.Join(ff, "def.work", "cert9.db"), "")
	snap := filepath.Join(home, "snap", "firefox", "common", ".mozilla", "firefox")
	mkfile(t, filepath.Join(snap, "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=s1.default\n")
	mkfile(t, filepath.Join(snap, "s1.default", "cert9.db"), "")
	mkfile(t, filepath.Join(home, ".config", "google-chrome", "Local State"), "{}")
	mkfile(t, filepath.Join(home, ".pki", "nssdb", "cert9.db"), "")
	mkfile(t, filepath.Join(home, ".var", "app", "com.brave.Browser", "config", "x"), "")
	return home, ca
}

func find(r Report, id, variant string) *Browser {
	for i := range r.Browsers {
		if r.Browsers[i].ID == id && r.Browsers[i].Variant == variant {
			return &r.Browsers[i]
		}
	}
	return nil
}

func TestReadProfilesINI(t *testing.T) {
	home, _ := linuxHome(t)
	ps := ReadProfilesINI(filepath.Join(home, ".mozilla", "firefox"))
	if len(ps) != 2 {
		t.Fatalf("the missing profile folder is left out: %+v", ps)
	}
	if ps[0].Name != "default-release" || !ps[0].Default || ps[1].Default {
		t.Errorf("the install's default wins over Default=1: %+v", ps)
	}
	if ReadProfilesINI(filepath.Join(home, "nowhere")) != nil {
		t.Error("no profiles.ini")
	}
}

func TestDiscoverLinuxWithoutP11Kit(t *testing.T) {
	home, ca := linuxHome(t)
	fake := &fakeCertutil{dbs: map[string][]byte{}}
	// The work profile already has the CA; the snap one an older CA.
	fake.dbs["sql:"+filepath.Join(home, ".mozilla", "firefox", "def.work")], _ = os.ReadFile(ca)
	fake.dbs["sql:"+filepath.Join(home, "snap", "firefox", "common", ".mozilla", "firefox", "s1.default")] = makeCA(t)
	e := Env{GOOS: "linux", Home: home, Certutil: "/usr/bin/certutil", Run: fake.run, Distro: "ubuntu debian"}
	r := Discover(context.Background(), e, ca, true)

	ff := find(r, "firefox", "")
	if ff == nil || len(ff.Profiles) != 2 {
		t.Fatalf("firefox: %+v", r.Browsers)
	}
	if ff.Profiles[0].Status != Missing || ff.Profiles[1].Status != Trusted || !ff.Profiles[0].CanAdd {
		t.Errorf("firefox profiles: %+v", ff.Profiles)
	}
	if s := find(r, "firefox", "snap"); s == nil || s.Profiles[0].Status != Outdated {
		t.Errorf("snap firefox: %+v", s)
	}
	if c := find(r, "chrome", ""); c == nil || c.Profiles[0].Status != Missing || c.Profiles[0].Dir != filepath.Join(home, ".pki", "nssdb") {
		t.Errorf("chrome reads ~/.pki/nssdb: %+v", c)
	}
	if b := find(r, "brave", "flatpak"); b == nil || b.Profiles[0].Status != Missing {
		t.Errorf("flatpak brave: %+v", b)
	}
	if find(r, "edge", "") != nil {
		t.Error("edge is not installed")
	}
	if !r.NeedsAction() {
		t.Error("needs action")
	}
	for _, b := range r.Browsers {
		for _, p := range b.Profiles {
			if strings.Contains(p.ID, home) || p.ID == "" {
				t.Errorf("ids are opaque: %q", p.ID)
			}
		}
	}
}

func TestDiscoverLinuxWithP11Kit(t *testing.T) {
	home, ca := linuxHome(t)
	fake := &fakeCertutil{dbs: map[string][]byte{}}
	e := Env{GOOS: "linux", Home: home, Certutil: "/usr/bin/certutil", Run: fake.run, P11Kit: true}
	r := Discover(context.Background(), e, ca, true)
	if ff := find(r, "firefox", ""); ff.Profiles[0].Status != System {
		t.Errorf("distro firefox with p11-kit uses the system's trust: %+v", ff.Profiles[0])
	}
	if c := find(r, "chrome", ""); c.Profiles[0].Status != System {
		t.Errorf("chrome with p11-kit: %+v", c.Profiles[0])
	}
	if s := find(r, "firefox", "snap"); s.Profiles[0].Status != Missing {
		t.Errorf("a snap brings its own NSS: %+v", s.Profiles[0])
	}
	// Before `portless trust`, the system does not trust it either.
	r = Discover(context.Background(), e, ca, false)
	if c := find(r, "chrome", ""); c.Profiles[0].Status != Missing {
		t.Errorf("system not trusted yet: %+v", c.Profiles[0])
	}
}

func TestDiscoverWithoutCertutil(t *testing.T) {
	home, ca := linuxHome(t)
	e := Env{GOOS: "linux", Home: home, Distro: "fedora", Run: func(context.Context, ...string) ([]byte, error) {
		t.Error("certutil is not run when it is missing")
		return nil, nil
	}}
	r := Discover(context.Background(), e, ca, true)
	if r.CertutilHint != "sudo dnf install nss-tools" {
		t.Errorf("hint: %q", r.CertutilHint)
	}
	if ff := find(r, "firefox", ""); ff.Profiles[0].Status != Unknown || ff.Profiles[0].CanAdd {
		t.Errorf("firefox without certutil: %+v", ff.Profiles[0])
	}
}

func TestDiscoverNoCA(t *testing.T) {
	home, _ := linuxHome(t)
	r := Discover(context.Background(), Env{GOOS: "linux", Home: home}, filepath.Join(home, "none.pem"), false)
	if r.CAExists || find(r, "firefox", "").Profiles[0].Status != NoCA || r.NeedsAction() {
		t.Errorf("no CA yet: %+v", r)
	}
}

func TestDiscoverMacAndWindows(t *testing.T) {
	home := t.TempDir()
	ca := filepath.Join(home, "ca.pem")
	mkfile(t, ca, string(makeCA(t)))
	as := filepath.Join(home, "Library", "Application Support")
	mkfile(t, filepath.Join(as, "Firefox", "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/a.default\n\n[Profile1]\nName=strict\nIsRelative=1\nPath=Profiles/b.strict\n")
	mkfile(t, filepath.Join(as, "Firefox", "Profiles", "a.default", "prefs.js"), "")
	mkfile(t, filepath.Join(as, "Firefox", "Profiles", "b.strict", "prefs.js"), `user_pref("security.enterprise_roots.enabled", false);`+"\n")
	mkfile(t, filepath.Join(as, "Google", "Chrome", "Local State"), "{}")
	r := Discover(context.Background(), Env{GOOS: "darwin", Home: home}, ca, true)
	ff := find(r, "firefox", "")
	if ff.Profiles[0].Status != System || ff.Profiles[1].Status != Missing || !strings.Contains(ff.Profiles[1].Detail, "third-party root") {
		t.Errorf("firefox reads the keychain unless enterprise roots are off: %+v", ff.Profiles)
	}
	if c := find(r, "chrome", ""); c.Store != "system" || c.Profiles[0].Status != System || c.Profiles[0].CanAdd {
		t.Errorf("chrome on macOS: %+v", c)
	}

	appdata := filepath.Join(home, "AppData", "Roaming")
	mkfile(t, filepath.Join(home, "AppData", "Local", "Microsoft", "Edge", "User Data", "Local State"), "{}")
	r = Discover(context.Background(), Env{GOOS: "windows", Home: home, AppData: appdata}, ca, false)
	if e := find(r, "edge", ""); e == nil || e.Profiles[0].Status != Missing || e.Profiles[0].Dir != "" {
		t.Errorf("edge on windows follows the system store: %+v", r.Browsers)
	}
	if r.CertutilHint != "" {
		t.Error("no certutil hint on Windows")
	}
}

func TestAdd(t *testing.T) {
	home, ca := linuxHome(t)
	fake := &fakeCertutil{dbs: map[string][]byte{}}
	snapDir := filepath.Join(home, "snap", "firefox", "common", ".mozilla", "firefox", "s1.default")
	fake.dbs["sql:"+snapDir] = makeCA(t)
	e := Env{GOOS: "linux", Home: home, Certutil: "/usr/bin/certutil", Run: fake.run}
	r := Discover(context.Background(), e, ca, false)

	snap := find(r, "firefox", "snap").Profiles[0]
	var out bytes.Buffer
	p, err := Add(context.Background(), e, ca, false, "firefox-snap", snap.ID, &out)
	if err != nil || p.Status != Trusted {
		t.Fatalf("snap: %+v %v", p, err)
	}
	joined := strings.Join(fake.calls, "\n")
	if !strings.Contains(joined, "-D -d sql:"+snapDir+" -n portless Local CA") || !strings.Contains(joined, "-A -d sql:"+snapDir+" -n portless Local CA -t C,, -i "+ca) {
		t.Errorf("an outdated CA is replaced:\n%s", joined)
	}
	if !strings.Contains(out.String(), "certutil -A") {
		t.Errorf("the command is shown: %s", out.String())
	}

	// A Chrome-family database that does not exist yet is created first.
	_ = os.RemoveAll(filepath.Join(home, ".pki"))
	chrome := find(Discover(context.Background(), e, ca, false), "chrome", "").Profiles[0]
	fake.calls = nil
	if p, err := Add(context.Background(), e, ca, false, "chrome", chrome.ID, nil); err != nil || p.Status != Trusted {
		t.Fatalf("chrome: %+v %v", p, err)
	}
	created, added := -1, -1
	for i, c := range fake.calls {
		if strings.HasPrefix(c, "-N -d sql:") {
			created = i
		}
		if strings.HasPrefix(c, "-A -d sql:") {
			added = i
		}
	}
	if created < 0 || added < created {
		t.Errorf("creates the database, then adds the CA: %v", fake.calls)
	}

	if _, err := Add(context.Background(), e, ca, false, "firefox", "firefox:000000000000", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown profile: %v", err)
	}
	noCertutil := Env{GOOS: "linux", Home: home, Distro: "ubuntu"}
	ff := find(Discover(context.Background(), noCertutil, ca, false), "firefox", "").Profiles[0]
	if _, err := Add(context.Background(), noCertutil, ca, false, "firefox", ff.ID, nil); err == nil || !strings.Contains(err.Error(), "libnss3-tools") {
		t.Errorf("without certutil: %v", err)
	}
}

func TestDetectP11Kit(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "p11-kit-trust.so")
	mkfile(t, target, "")
	link := filepath.Join(dir, "libnssckbi.so")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks")
	}
	if !DetectP11Kit([]string{filepath.Join(dir, "missing.so"), link}) {
		t.Error("p11-kit link")
	}
	plain := filepath.Join(dir, "plain", "libnssckbi.so")
	mkfile(t, plain, "")
	if DetectP11Kit([]string{plain}) {
		t.Error("Mozilla's own module")
	}
}

func TestCertutilHint(t *testing.T) {
	for distro, want := range map[string]string{"fedora": "sudo dnf install nss-tools", "ubuntu debian": "sudo apt install libnss3-tools", "linuxmint ubuntu": "sudo apt install libnss3-tools", "arch": "sudo pacman -S nss"} {
		if got := CertutilHint("linux", distro); got != want {
			t.Errorf("%s: %s", distro, got)
		}
	}
	if CertutilHint("darwin", "") != "brew install nss" {
		t.Error("mac")
	}
}
