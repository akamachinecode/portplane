package portless

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Output of `portless service status` from portless 0.16 on Linux.
const statusFixture = "\x1b[1mportless service\x1b[22m\n" +
	"  Manager state: active\n" +
	"  Installed: yes\n" +
	"  Proxy on 443: responding\n" +
	"  HTTPS: yes\n" +
	"  TLDs: .localhost, .test\n" +
	"  LAN mode: no\n" +
	"  Wildcard: no\n" +
	"  Unprivileged: no\n" +
	"  State directory: /home/dev/.portless\n" +
	"  Service entry: /etc/systemd/system/portless.service\n"

func TestParseServiceStatus(t *testing.T) {
	st := ParseServiceStatus(statusFixture)
	if !st.Parsed || !st.Installed || st.ManagerState != "active" || !st.Responding || st.Port != 443 || !st.HTTPS {
		t.Fatalf("%+v", st)
	}
	if !reflect.DeepEqual(st.TLDs, []string{"localhost", "test"}) || st.StateDir != "/home/dev/.portless" || st.Entry != "/etc/systemd/system/portless.service" {
		t.Fatalf("%+v", st)
	}
	none := ParseServiceStatus("portless service\n  Manager state: not installed\n  Installed: no\n  Proxy on 443: not responding\n")
	if !none.Parsed || none.Installed || none.Responding {
		t.Fatalf("%+v", none)
	}
	if ParseServiceStatus("something else entirely").Parsed {
		t.Fatal("parsed nonsense")
	}
}

func TestServiceNode(t *testing.T) {
	unit := "[Service]\nType=simple\nExecStart=\"/opt/node/24.1.0/bin/node\" \"/usr/lib/node_modules/portless/dist/cli.js\" \"proxy\" \"start\"\n"
	if got := ServiceNode(unit); got != "/opt/node/24.1.0/bin/node" {
		t.Errorf("unit: %q", got)
	}
	plist := "<dict>\n  <key>Label</key>\n  <string>sh.portless.proxy</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/usr/local/bin/node</string>\n    <string>/x/cli.js</string>\n"
	if got := ServiceNode(plist); got != "/usr/local/bin/node" {
		t.Errorf("plist: %q", got)
	}
	if ServiceNode("nothing") != "" {
		t.Error("found a node in nothing")
	}
}

func TestProxyOptions(t *testing.T) {
	if got := strings.Join(DefaultProxyOptions().Args(), " "); got != "--port 443 --https" {
		t.Errorf("default: %s", got)
	}
	o := ProxyOptions{Port: 8443, HTTPS: true, TLDs: []string{".test", "localhost", "test"}, Wildcard: true}
	if got := strings.Join(o.Args(), " "); got != "--port 8443 --https --tld test --tld localhost --wildcard" {
		t.Errorf("tlds: %s", got)
	}
	lan := ProxyOptions{Port: 443, HTTPS: true, LAN: true, LANIP: "192.168.1.20", TLDs: []string{"test"}}
	if got := strings.Join(lan.Args(), " "); got != "--port 443 --https --lan --ip 192.168.1.20" {
		t.Errorf("lan: %s", got)
	}
	cert := ProxyOptions{Port: 443, HTTPS: true, CertPath: "/c.pem", KeyPath: "/k.pem"}
	if got := strings.Join(cert.Args(), " "); got != "--port 443 --cert /c.pem --key /k.pem" {
		t.Errorf("cert: %s", got)
	}
	if got := strings.Join(ProxyOptions{Port: 80}.Args(), " "); got != "--port 80 --no-tls" {
		t.Errorf("http: %s", got)
	}
	for _, bad := range []ProxyOptions{{Port: 0}, {Port: 443, TLDs: []string{"bad tld"}}, {Port: 443, HTTPS: true, CertPath: "/c"}, {Port: 443, LANIP: "1.2.3.4"}} {
		if bad.Validate() == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

func TestNeedsAdminToBind(t *testing.T) {
	start := func(n int) func() (int, error) { return func() (int, error) { return n, nil } }
	if !needsAdminToBind(443, "linux", start(1024)) {
		t.Error("443 on default Linux")
	}
	if needsAdminToBind(443, "linux", start(80)) {
		t.Error("443 when the kernel allows from 80")
	}
	if needsAdminToBind(1355, "linux", start(1024)) || needsAdminToBind(443, "darwin", nil) || needsAdminToBind(443, "windows", nil) {
		t.Error("needs admin where it does not")
	}
	if !needsAdminToBind(443, "linux", func() (int, error) { return 0, errors.New("no proc") }) {
		t.Error("unknown kernel setting should ask")
	}
}

func TestCA(t *testing.T) {
	dir := t.TempDir()
	c := &Client{StateDir: dir}
	if ca := c.CA(); ca.Exists || ca.Trusted {
		t.Fatalf("no ca.pem: %+v", ca)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "portless Local CA"}, NotBefore: time.Now(), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	raw := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(filepath.Join(dir, "ca.pem"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	ca := c.CA()
	if !ca.Exists || ca.Subject != "portless Local CA" || len(ca.Fingerprint) != 95 || ca.NotAfter.IsZero() {
		t.Fatalf("%+v", ca)
	}
	sum := sha256.Sum256(raw)
	if err := os.WriteFile(filepath.Join(dir, "ca.trusted"), []byte(hex.EncodeToString(sum[:])+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !c.CA().Trusted {
		t.Fatal("marker not read")
	}
}
