// Package browsertrust finds the browsers on this computer and whether each
// one trusts portless's local CA, and adds the CA to a browser's own
// certificate database on request (ADR-0020: it writes into the user's
// profile and needs no password).
//
// What uses what (see docs/troubleshooting.md):
//
//   - Chrome, Chromium, Brave and Edge on macOS and Windows use the
//     system's store, which `portless trust` fills.
//   - Firefox on macOS and Windows also reads the roots added to the
//     system's store, through security.enterprise_roots.enabled (on by
//     default since Firefox 120); a profile that turned it off needs the CA
//     in its own database.
//   - On Linux every browser keeps an NSS database: Firefox one per
//     profile, the Chrome family one shared in ~/.pki/nssdb. Where NSS
//     loads the system's trust through p11-kit (Fedora, Arch, openSUSE),
//     browsers installed from the distribution see the CA `portless trust`
//     added. Snap and Flatpak browsers, Firefox's own builds and Debian and
//     Ubuntu's NSS do not: the CA goes into their database with certutil.
package browsertrust

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Nickname is the name the CA gets in an NSS database.
const Nickname = "portless Local CA"

// Status of a profile.
const (
	Trusted  = "trusted"  // the CA is in the browser's own database
	System   = "system"   // the browser uses the system's store, which trusts the CA
	Missing  = "missing"  // the browser does not trust the CA: add it
	Outdated = "outdated" // the database has an older portless CA: replace it
	Unknown  = "unknown"  // certutil is missing, so the database cannot be read
	NoCA     = "no-ca"    // there is no CA yet (the proxy creates it)
)

// Profile is one certificate database of a browser.
type Profile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Dir is the NSS database folder (empty for the system store).
	Dir     string `json:"dir,omitempty"`
	Default bool   `json:"default,omitempty"`
	Status  string `json:"status"`
	Detail  string `json:"detail,omitempty"`
	// CanAdd says Portplane can add the CA here (certutil and an NSS
	// database).
	CanAdd bool `json:"canAdd"`
}

// Browser is one installed browser.
type Browser struct {
	ID string `json:"id"` // firefox, chrome, chromium, brave, edge
	// Variant is "", "snap" or "flatpak".
	Variant  string    `json:"variant,omitempty"`
	Name     string    `json:"name"`
	Store    string    `json:"store"` // nss or system
	Profiles []Profile `json:"profiles"`
}

// Report is every browser found and what is needed.
type Report struct {
	CA       string    `json:"ca,omitempty"` // ca.pem's path
	CAExists bool      `json:"caExists"`
	Browsers []Browser `json:"browsers"`
	// Certutil is the path of NSS's certutil, empty when it is missing,
	// and CertutilHint how to install it.
	Certutil     string `json:"certutil,omitempty"`
	CertutilHint string `json:"certutilHint,omitempty"`
	// SystemTrusted is the system store's trust, as portless reports it.
	SystemTrusted bool `json:"systemTrusted"`
	// P11Kit means NSS reads the system's trust through p11-kit here.
	P11Kit bool `json:"p11kit"`
}

// NeedsAction reports whether some browser does not trust the CA yet.
func (r Report) NeedsAction() bool {
	for _, b := range r.Browsers {
		for _, p := range b.Profiles {
			if p.Status == Missing || p.Status == Outdated || p.Status == Unknown {
				return true
			}
		}
	}
	return false
}

// Runner runs a program and returns its combined output.
type Runner func(ctx context.Context, argv ...string) ([]byte, error)

func runProcess(ctx context.Context, argv ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.WaitDelay = time.Second
	return cmd.CombinedOutput()
}

// Env is where to look, so tests can use a fixture home.
type Env struct {
	GOOS string
	Home string
	// AppData is %APPDATA% on Windows.
	AppData string
	// Certutil is NSS's certutil, "" when it is not installed.
	Certutil string
	// P11Kit reports that NSS's builtin trust module is p11-kit's
	// (DetectP11Kit).
	P11Kit bool
	// Distro is the Linux distribution's ID (fedora, ubuntu…), for the
	// certutil hint.
	Distro string
	Run    Runner
}

// LocalEnv describes this computer.
func LocalEnv(goos string) Env {
	home, _ := os.UserHomeDir()
	e := Env{GOOS: goos, Home: home, AppData: os.Getenv("APPDATA"), Run: runProcess}
	if goos == "linux" || goos == "darwin" {
		// Windows' certutil.exe is another program with the same name.
		if p, err := exec.LookPath("certutil"); err == nil {
			e.Certutil = p
		}
	}
	if goos == "linux" {
		e.P11Kit = DetectP11Kit(nssModuleCandidates)
		e.Distro = distroID("/etc/os-release")
	}
	return e
}

var nssModuleCandidates = []string{
	"/usr/lib64/libnssckbi.so", "/usr/lib/libnssckbi.so",
	"/usr/lib/x86_64-linux-gnu/libnssckbi.so", "/usr/lib/aarch64-linux-gnu/libnssckbi.so",
	"/usr/lib/x86_64-linux-gnu/nss/libnssckbi.so", "/usr/lib/aarch64-linux-gnu/nss/libnssckbi.so",
}

// DetectP11Kit reports whether NSS's root module is p11-kit's trust module,
// as on Fedora, Arch and openSUSE: then NSS sees the system's anchors.
func DetectP11Kit(candidates []string) bool {
	for _, c := range candidates {
		real, err := filepath.EvalSymlinks(c)
		if err != nil {
			continue
		}
		if strings.Contains(filepath.Base(real), "p11-kit") {
			return true
		}
	}
	return false
}

func distroID(osRelease string) string {
	b, err := os.ReadFile(osRelease)
	if err != nil {
		return ""
	}
	id, like := "", ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			id = v
		case "ID_LIKE":
			like = v
		}
	}
	return strings.TrimSpace(id + " " + like)
}

// CertutilHint says how to get certutil.
func CertutilHint(goos, distro string) string {
	if goos == "darwin" {
		return "brew install nss"
	}
	switch {
	case containsWord(distro, "fedora", "rhel", "centos"):
		return "sudo dnf install nss-tools"
	case containsWord(distro, "debian", "ubuntu"):
		return "sudo apt install libnss3-tools"
	case containsWord(distro, "arch"):
		return "sudo pacman -S nss"
	case containsWord(distro, "suse", "opensuse"):
		return "sudo zypper install mozilla-nss-tools"
	}
	return "Install NSS's tools (nss-tools on Fedora, libnss3-tools on Debian and Ubuntu)"
}

func containsWord(s string, words ...string) bool {
	for _, f := range strings.Fields(s) {
		for _, w := range words {
			if strings.HasPrefix(f, w) {
				return true
			}
		}
	}
	return false
}

// candidate is a browser location to look at.
type candidate struct {
	id, variant, name string
	// firefox: folders with profiles.ini; chromium family: config dirs
	// that prove the browser is used, and the NSS database it reads.
	firefoxRoots []string
	configDirs   []string
	nssdb        string
	// native: installed from the distribution (p11-kit applies).
	native bool
}

func (e Env) candidates() []candidate {
	h := func(p ...string) string { return filepath.Join(append([]string{e.Home}, p...)...) }
	switch e.GOOS {
	case "darwin":
		as := h("Library", "Application Support")
		return []candidate{
			{id: "firefox", name: "Firefox", firefoxRoots: []string{filepath.Join(as, "Firefox")}},
			{id: "chrome", name: "Chrome", configDirs: []string{filepath.Join(as, "Google", "Chrome")}},
			{id: "chromium", name: "Chromium", configDirs: []string{filepath.Join(as, "Chromium")}},
			{id: "brave", name: "Brave", configDirs: []string{filepath.Join(as, "BraveSoftware", "Brave-Browser")}},
			{id: "edge", name: "Edge", configDirs: []string{filepath.Join(as, "Microsoft Edge")}},
		}
	case "windows":
		local := filepath.Join(filepath.Dir(e.AppData), "Local")
		if e.AppData == "" {
			local = h("AppData", "Local")
		}
		roaming := e.AppData
		if roaming == "" {
			roaming = h("AppData", "Roaming")
		}
		return []candidate{
			{id: "firefox", name: "Firefox", firefoxRoots: []string{filepath.Join(roaming, "Mozilla", "Firefox")}},
			{id: "chrome", name: "Chrome", configDirs: []string{filepath.Join(local, "Google", "Chrome", "User Data")}},
			{id: "chromium", name: "Chromium", configDirs: []string{filepath.Join(local, "Chromium", "User Data")}},
			{id: "brave", name: "Brave", configDirs: []string{filepath.Join(local, "BraveSoftware", "Brave-Browser", "User Data")}},
			{id: "edge", name: "Edge", configDirs: []string{filepath.Join(local, "Microsoft", "Edge", "User Data")}},
		}
	default:
		nss := h(".pki", "nssdb")
		return []candidate{
			{id: "firefox", name: "Firefox", native: true, firefoxRoots: []string{h(".mozilla", "firefox"), h(".config", "mozilla", "firefox")}},
			{id: "firefox", variant: "snap", name: "Firefox (Snap)", firefoxRoots: []string{h("snap", "firefox", "common", ".mozilla", "firefox")}},
			{id: "firefox", variant: "flatpak", name: "Firefox (Flatpak)", firefoxRoots: []string{h(".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"), h(".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox")}},
			{id: "chrome", name: "Chrome", native: true, configDirs: []string{h(".config", "google-chrome")}, nssdb: nss},
			{id: "chromium", name: "Chromium", native: true, configDirs: []string{h(".config", "chromium")}, nssdb: nss},
			{id: "brave", name: "Brave", native: true, configDirs: []string{h(".config", "BraveSoftware", "Brave-Browser")}, nssdb: nss},
			{id: "edge", name: "Edge", native: true, configDirs: []string{h(".config", "microsoft-edge")}, nssdb: nss},
			{id: "chromium", variant: "snap", name: "Chromium (Snap)", configDirs: []string{h("snap", "chromium")}, nssdb: h("snap", "chromium", "current", ".pki", "nssdb")},
			{id: "chrome", variant: "flatpak", name: "Chrome (Flatpak)", configDirs: []string{h(".var", "app", "com.google.Chrome")}, nssdb: h(".var", "app", "com.google.Chrome", ".pki", "nssdb")},
			{id: "chromium", variant: "flatpak", name: "Chromium (Flatpak)", configDirs: []string{h(".var", "app", "org.chromium.Chromium")}, nssdb: h(".var", "app", "org.chromium.Chromium", ".pki", "nssdb")},
			{id: "brave", variant: "flatpak", name: "Brave (Flatpak)", configDirs: []string{h(".var", "app", "com.brave.Browser")}, nssdb: h(".var", "app", "com.brave.Browser", ".pki", "nssdb")},
			{id: "edge", variant: "flatpak", name: "Edge (Flatpak)", configDirs: []string{h(".var", "app", "com.microsoft.Edge")}, nssdb: h(".var", "app", "com.microsoft.Edge", ".pki", "nssdb")},
		}
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// FirefoxProfile is one entry of profiles.ini.
type FirefoxProfile struct {
	Name    string
	Dir     string
	Default bool
}

// ReadProfilesINI lists the profiles in a Firefox folder (with its
// profiles.ini), absolute paths resolved, those whose folder exists.
func ReadProfilesINI(root string) []FirefoxProfile {
	b, err := os.ReadFile(filepath.Join(root, "profiles.ini"))
	if err != nil {
		return nil
	}
	var out []FirefoxProfile
	installDefaults := map[string]bool{}
	var cur *FirefoxProfile
	relative := true
	section := ""
	flush := func() {
		if cur != nil && cur.Dir != "" {
			if relative && !filepath.IsAbs(cur.Dir) {
				cur.Dir = filepath.Join(root, filepath.FromSlash(cur.Dir))
			}
			if exists(cur.Dir) {
				out = append(out, *cur)
			}
		}
		cur, relative = nil, true
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			section = strings.Trim(line, "[]")
			if strings.HasPrefix(section, "Profile") {
				cur = &FirefoxProfile{}
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch {
		case strings.HasPrefix(section, "Install") && k == "Default":
			installDefaults[v] = true
		case cur == nil:
		case k == "Name":
			cur.Name = v
		case k == "Path":
			cur.Dir = v
		case k == "IsRelative":
			relative = v != "0"
		case k == "Default":
			cur.Default = v == "1"
		}
	}
	flush()
	// The profile an installation opens wins over the legacy Default=1.
	if len(installDefaults) > 0 {
		for i := range out {
			rel, _ := filepath.Rel(root, out[i].Dir)
			out[i].Default = installDefaults[filepath.ToSlash(rel)] || installDefaults[out[i].Dir]
		}
	}
	return out
}

// enterpriseRoots reads security.enterprise_roots.enabled from a profile's
// prefs.js and user.js; def when it is not set.
func enterpriseRoots(dir string, def bool) bool {
	val := def
	for _, f := range []string{"prefs.js", "user.js"} { // user.js wins
		b, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if !strings.Contains(line, `"security.enterprise_roots.enabled"`) {
				continue
			}
			switch {
			case strings.Contains(line, "true"):
				val = true
			case strings.Contains(line, "false"):
				val = false
			}
		}
	}
	return val
}

// Discover lists the browsers and their certificate databases, and
// whether each trusts the CA in caPEM's file. systemTrusted is the system
// store's trust, as portless reports it.
func Discover(ctx context.Context, e Env, caPath string, systemTrusted bool) Report {
	r := Report{CA: caPath, SystemTrusted: systemTrusted, Certutil: e.Certutil, P11Kit: e.P11Kit, Browsers: []Browser{}}
	ca, caErr := readCA(caPath)
	r.CAExists = caErr == nil
	if e.Certutil == "" && e.GOOS != "windows" {
		r.CertutilHint = CertutilHint(e.GOOS, e.Distro)
	}
	if e.Run == nil {
		e.Run = runProcess
	}
	for _, c := range e.candidates() {
		var b Browser
		if len(c.firefoxRoots) > 0 {
			b = e.firefox(ctx, c, ca, r)
		} else {
			b = e.chromium(ctx, c, ca, r)
		}
		if len(b.Profiles) > 0 {
			r.Browsers = append(r.Browsers, b)
		}
	}
	return r
}

func (e Env) firefox(ctx context.Context, c candidate, ca []byte, r Report) Browser {
	b := Browser{ID: c.id, Variant: c.variant, Name: c.name, Store: "nss", Profiles: []Profile{}}
	seen := map[string]bool{}
	for _, root := range c.firefoxRoots {
		for _, fp := range ReadProfilesINI(root) {
			if seen[fp.Dir] {
				continue
			}
			seen[fp.Dir] = true
			p := Profile{ID: profileID(c, fp.Dir, e.Home), Name: fp.Name, Dir: fp.Dir, Default: fp.Default}
			viaSystem := false
			switch {
			case e.GOOS == "darwin" || e.GOOS == "windows":
				// Since Firefox 120 it reads the roots added to the OS store.
				viaSystem = enterpriseRoots(fp.Dir, true)
			case c.native && e.P11Kit:
				viaSystem = true
			}
			e.judge(ctx, &p, ca, r, viaSystem)
			if (e.GOOS == "darwin" || e.GOOS == "windows") && !viaSystem && (p.Status == Unknown || p.Status == Missing) {
				p.Status = Missing
				p.Detail = "This profile ignores your system's certificates. In Firefox, open Settings, Privacy & Security, Certificates, and turn on \"Allow Firefox to automatically trust third-party root certificates you install\"."
			}
			b.Profiles = append(b.Profiles, p)
		}
	}
	sort.SliceStable(b.Profiles, func(i, j int) bool { return b.Profiles[i].Default && !b.Profiles[j].Default })
	return b
}

func (e Env) chromium(ctx context.Context, c candidate, ca []byte, r Report) Browser {
	b := Browser{ID: c.id, Variant: c.variant, Name: c.name, Profiles: []Profile{}}
	found := false
	for _, d := range c.configDirs {
		if exists(d) {
			found = true
		}
	}
	if !found {
		return b
	}
	if e.GOOS == "darwin" || e.GOOS == "windows" {
		b.Store = "system"
		p := Profile{ID: profileID(c, "system", e.Home), Name: "All profiles"}
		switch {
		case !r.CAExists:
			p.Status = NoCA
		case r.SystemTrusted:
			p.Status, p.Detail = System, "Uses your system's certificates, which trust the CA."
		default:
			p.Status, p.Detail = Missing, "Uses your system's certificates: trust the CA there."
		}
		b.Profiles = append(b.Profiles, p)
		return b
	}
	b.Store = "nss"
	p := Profile{ID: profileID(c, c.nssdb, e.Home), Name: "All profiles", Dir: c.nssdb, Default: true}
	e.judge(ctx, &p, ca, r, c.native && e.P11Kit)
	b.Profiles = append(b.Profiles, p)
	return b
}

// judge sets a profile's status: its own database first, then whether
// the browser sees the system's store.
func (e Env) judge(ctx context.Context, p *Profile, ca []byte, r Report, viaSystem bool) {
	if !r.CAExists {
		p.Status, p.Detail = NoCA, "The certificate is created when the proxy starts."
		return
	}
	nss := p.Dir != ""
	p.CanAdd = nss && e.Certutil != ""
	if nss && e.Certutil != "" && exists(filepath.Join(p.Dir, "cert9.db")) {
		switch inDatabase(ctx, e, p.Dir, ca) {
		case Trusted:
			p.Status, p.Detail = Trusted, "The CA is in this browser's own certificates."
			return
		case Outdated:
			p.Status, p.Detail = Outdated, "This browser has an older portless CA: replace it."
			return
		}
	}
	switch {
	case viaSystem && r.SystemTrusted:
		p.Status, p.Detail = System, "Uses your system's certificates, which trust the CA."
	case viaSystem:
		p.Status, p.Detail = Missing, "Uses your system's certificates, which don't trust the CA yet."
	case nss && e.Certutil == "":
		p.Status, p.Detail = Unknown, "Portplane needs certutil to check and add the CA here."
	default:
		p.Status, p.Detail = Missing, "This browser keeps its own certificates and doesn't have the CA."
	}
}

// inDatabase looks the CA up by nickname and compares the certificate.
func inDatabase(ctx context.Context, e Env, dir string, ca []byte) string {
	out, err := e.Run(ctx, e.Certutil, "-L", "-d", "sql:"+dir, "-n", Nickname, "-a")
	if err != nil {
		return Missing
	}
	for rest := out; ; {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if bytes.Equal(block.Bytes, ca) {
			return Trusted
		}
	}
	return Outdated
}

func readCA(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("no CA")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, errors.New("ca.pem holds no certificate")
	}
	return block.Bytes, nil
}

// profileID is stable and does not reveal the path: browser, variant and
// a short hash of the database folder relative to home.
func profileID(c candidate, dir, home string) string {
	rel := dir
	if r, err := filepath.Rel(home, dir); err == nil {
		rel = filepath.ToSlash(r)
	}
	sum := sha256.Sum256([]byte(rel))
	id := c.id
	if c.variant != "" {
		id += "-" + c.variant
	}
	return id + ":" + hex.EncodeToString(sum[:6])
}

// ErrNotFound means no browser profile has that id.
var ErrNotFound = errors.New("no such browser profile")

// Add puts the CA in the profile's NSS database, replacing an older
// portless CA, and returns the profile as it then stands. The browser and
// profile come from Discover; a path never comes from the caller.
func Add(ctx context.Context, e Env, caPath string, systemTrusted bool, browser, profile string, out io.Writer) (Profile, error) {
	if out == nil {
		out = io.Discard
	}
	if e.Run == nil {
		e.Run = runProcess
	}
	r := Discover(ctx, e, caPath, systemTrusted)
	var target *Profile
	for _, b := range r.Browsers {
		if b.ID != browser && b.ID+"-"+b.Variant != browser {
			continue
		}
		for i := range b.Profiles {
			if b.Profiles[i].ID == profile {
				target = &b.Profiles[i]
			}
		}
	}
	if target == nil {
		return Profile{}, ErrNotFound
	}
	if !r.CAExists {
		return *target, errors.New("there is no portless CA yet: set up the proxy first")
	}
	if target.Dir == "" {
		return *target, errors.New("this browser uses the system's certificates: trust the CA in the system instead")
	}
	if e.Certutil == "" {
		return *target, fmt.Errorf("certutil is not installed: %s", CertutilHint(e.GOOS, e.Distro))
	}
	db := "sql:" + target.Dir
	if !exists(filepath.Join(target.Dir, "cert9.db")) {
		if err := os.MkdirAll(target.Dir, 0o700); err != nil {
			return *target, err
		}
		fmt.Fprintf(out, "$ certutil -N -d %s --empty-password\n", db)
		if b, err := e.Run(ctx, e.Certutil, "-N", "-d", db, "--empty-password"); err != nil {
			_, _ = out.Write(b)
			return *target, fmt.Errorf("certutil could not create the database: %s", firstLine(b, err))
		}
	}
	if target.Status == Outdated {
		fmt.Fprintf(out, "$ certutil -D -d %s -n %q\n", db, Nickname)
		if b, err := e.Run(ctx, e.Certutil, "-D", "-d", db, "-n", Nickname); err != nil {
			_, _ = out.Write(b)
			return *target, fmt.Errorf("certutil could not remove the older CA: %s", firstLine(b, err))
		}
	}
	fmt.Fprintf(out, "$ certutil -A -d %s -n %q -t C,, -i %s\n", db, Nickname, caPath)
	if b, err := e.Run(ctx, e.Certutil, "-A", "-d", db, "-n", Nickname, "-t", "C,,", "-i", caPath); err != nil {
		_, _ = out.Write(b)
		return *target, fmt.Errorf("certutil could not add the CA: %s", firstLine(b, err))
	}
	after := Discover(ctx, e, caPath, systemTrusted)
	for _, b := range after.Browsers {
		for _, p := range b.Profiles {
			if p.ID == profile {
				return p, nil
			}
		}
	}
	return *target, nil
}

func firstLine(b []byte, err error) string {
	s := strings.TrimSpace(string(b))
	if s == "" {
		return err.Error()
	}
	line, _, _ := strings.Cut(s, "\n")
	return line
}
