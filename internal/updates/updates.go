// Package updates checks whether Portplane, dekit and portless have newer
// versions (ADR-0025). A check only reads: it fetches the latest version
// from each tool's official source and compares it with the installed
// one. It runs when the user clicks "Check for updates", or at most once a
// day when the user turned automatic checks on. Updating is a separate
// action, through the way each tool was installed.
package updates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Official sources (ADR-0025).
const (
	GitHub           = "https://github.com"
	NPMRegistry      = "https://registry.npmjs.org"
	PortplaneRepo    = "akamachinecode/portplane"
	DekitRepo        = "pvolok/dekit"
	PortlessPackage  = "portless"
	PortlessReleases = "https://github.com/vercel-labs/portless/releases"
)

// Interval is how often an automatic check may run.
const Interval = 24 * time.Hour

// Item is one tool's answer.
type Item struct {
	ID        string `json:"id"` // portplane, dekit or portless
	Name      string `json:"name"`
	Installed string `json:"installed,omitempty"` // empty when not installed
	Latest    string `json:"latest,omitempty"`    // empty when the check failed
	// Update is true when Latest is newer than Installed.
	Update bool `json:"update"`
	// Notes is where to read what is new: the release page.
	Notes string `json:"notes,omitempty"`
	// Error says why the check failed, in words for the user.
	Error string `json:"error,omitempty"`
}

// Result is one check of every tool.
type Result struct {
	CheckedAt time.Time `json:"checkedAt"`
	Items     []Item    `json:"items"`
}

// Installed are the versions on this computer; "" when a tool is missing.
type Installed struct {
	Portplane, Dekit, Portless string
}

// Checker asks the official sources. The bases are replaceable in tests.
type Checker struct {
	Client    *http.Client
	UserAgent string // portplane/<version>
	GitHub    string // default GitHub
	NPM       string // default NPMRegistry
}

func (c *Checker) client() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// Check asks for every tool's latest version. Each tool fails on its own:
// an offline check returns errors, never a partial update.
func (c *Checker) Check(ctx context.Context, in Installed, now time.Time) Result {
	type job struct {
		i    int
		item Item
		get  func(context.Context) (version, notes string, err error)
	}
	items := []job{
		{0, Item{ID: "portplane", Name: "Portplane", Installed: in.Portplane}, func(ctx context.Context) (string, string, error) {
			return c.latestRelease(ctx, PortplaneRepo)
		}},
		{1, Item{ID: "dekit", Name: "dekit", Installed: in.Dekit}, func(ctx context.Context) (string, string, error) {
			return c.latestRelease(ctx, DekitRepo)
		}},
		{2, Item{ID: "portless", Name: "portless", Installed: in.Portless}, func(ctx context.Context) (string, string, error) {
			v, err := c.latestNPM(ctx, PortlessPackage)
			return v, PortlessReleases, err
		}},
	}
	out := make([]Item, len(items))
	var wg sync.WaitGroup
	for _, j := range items {
		wg.Add(1)
		go func() {
			defer wg.Done()
			item := j.item
			v, notes, err := j.get(ctx)
			if err != nil {
				item.Error = err.Error()
			} else {
				item.Latest, item.Notes = v, notes
				item.Update = Newer(v, item.Installed)
			}
			out[j.i] = item
		}()
	}
	wg.Wait()
	return Result{CheckedAt: now.UTC(), Items: out}
}

func (c *Checker) request(ctx context.Context, rawURL string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	ua := c.UserAgent
	if ua == "" {
		ua = "portplane"
	}
	req.Header.Set("User-Agent", ua)
	return req, nil
}

// latestRelease reads a GitHub repository's latest release from the
// redirect of /releases/latest, which needs neither the API nor a token.
func (c *Checker) latestRelease(ctx context.Context, repo string) (version, notes string, err error) {
	base := c.GitHub
	if base == "" {
		base = GitHub
	}
	req, err := c.request(ctx, base+"/"+repo+"/releases/latest")
	if err != nil {
		return "", "", err
	}
	cl := *c.client()
	cl.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := cl.Do(req)
	if err != nil {
		return "", "", offline(err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	if resp.StatusCode < 300 || resp.StatusCode >= 400 {
		return "", "", fmt.Errorf("GitHub answered %s for %s's latest release", resp.Status, repo)
	}
	loc, err := resp.Location()
	if err != nil {
		return "", "", fmt.Errorf("GitHub sent no address for %s's latest release", repo)
	}
	tag, ok := strings.CutPrefix(loc.Path, "/"+repo+"/releases/tag/")
	if !ok || tag == "" {
		return "", "", fmt.Errorf("%s has no release yet", repo)
	}
	tag, _ = url.PathUnescape(tag)
	if _, ok := parse(tag); !ok {
		return "", "", fmt.Errorf("%s's latest release has an unexpected name: %q", repo, tag)
	}
	return strings.TrimPrefix(tag, "v"), base + "/" + repo + "/releases/tag/" + url.PathEscape(tag), nil
}

// latestNPM reads a package's latest version from the npm registry.
func (c *Checker) latestNPM(ctx context.Context, pkg string) (string, error) {
	base := c.NPM
	if base == "" {
		base = NPMRegistry
	}
	req, err := c.request(ctx, base+"/"+path.Clean(pkg)+"/latest")
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.client().Do(req)
	if err != nil {
		return "", offline(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the npm registry answered %s for %s", resp.Status, pkg)
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("the npm registry sent something unexpected for %s: %w", pkg, err)
	}
	if _, ok := parse(body.Version); !ok {
		return "", fmt.Errorf("the npm registry sent an unexpected version for %s: %q", pkg, body.Version)
	}
	return body.Version, nil
}

func offline(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Timeout() {
		return errors.New("no answer in time: check your connection")
	}
	return fmt.Errorf("couldn't connect: %w", errors.Unwrap(err))
}

var versionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

type version struct {
	nums [3]int
	pre  string
}

func parse(s string) (version, bool) {
	m := versionRE.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return version{}, false
	}
	var v version
	for i := range 3 {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return version{}, false
		}
		v.nums[i] = n
	}
	v.pre = m[4]
	return v, true
}

// Newer reports whether latest is a newer version than installed. A
// missing or unreadable installed version (a development build) is never
// out of date.
func Newer(latest, installed string) bool {
	l, ok1 := parse(latest)
	i, ok2 := parse(installed)
	if !ok1 || !ok2 {
		return false
	}
	for k := range 3 {
		if l.nums[k] != i.nums[k] {
			return l.nums[k] > i.nums[k]
		}
	}
	// Same numbers: a release is newer than its pre-releases.
	return l.pre == "" && i.pre != "" || l.pre != "" && i.pre != "" && comparePre(l.pre, i.pre) > 0
}

// comparePre orders pre-release labels as semver does: dot-separated
// parts, numbers numerically and below words.
func comparePre(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for k := 0; k < len(as) && k < len(bs); k++ {
		an, aErr := strconv.Atoi(as[k])
		bn, bErr := strconv.Atoi(bs[k])
		switch {
		case aErr == nil && bErr == nil:
			if an != bn {
				if an > bn {
					return 1
				}
				return -1
			}
		case aErr == nil:
			return -1
		case bErr == nil:
			return 1
		default:
			if c := strings.Compare(as[k], bs[k]); c != 0 {
				return c
			}
		}
	}
	return len(as) - len(bs)
}

// Due reports whether an automatic check should run now: none ran, or the
// last one is a day old.
func Due(last *Result, now time.Time) bool {
	return last == nil || now.Sub(last.CheckedAt) >= Interval
}

// Store keeps the last result in Portplane's cache folder, so it survives
// a restart and the once-a-day rule holds across restarts.
type Store struct {
	Path string
	mu   sync.Mutex
}

// DefaultPath is <user cache dir>/portplane/updates.json.
func DefaultPath() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "portplane", "updates.json")
}

// Load returns the last result, or nil when there is none.
func (s *Store) Load() *Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.Path)
	if err != nil {
		return nil
	}
	var r Result
	if json.Unmarshal(b, &r) != nil || r.CheckedAt.IsZero() {
		return nil
	}
	return &r
}

// Save writes a result.
func (s *Store) Save(r Result) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	tmp := s.Path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path)
}
