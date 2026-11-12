package installer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/buildinfo"
)

// OfficialHosts are the only hosts Portplane downloads from (ADR-0025):
// dekit's install scripts, the GitHub releases they and Portplane use, the
// host GitHub redirects release files to, Node.js's dist and npm's registry.
var OfficialHosts = []string{
	"dekit.run",
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"nodejs.org",
	"registry.npmjs.org",
}

// Official allows HTTPS URLs on the official hosts only.
func Official(u *url.URL) bool {
	if u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, h := range OfficialHosts {
		if host == h {
			return true
		}
	}
	return false
}

// ErrNotOfficial means a URL is not one of the official sources.
var ErrNotOfficial = errors.New("not an official download source")

// Downloader fetches files from the official sources, following redirects
// only to hosts it allows, with a size limit and no cookies.
type Downloader struct {
	// Allow says whether a URL may be fetched or redirected to; Official
	// when nil. Tests allow their httptest server.
	Allow func(*url.URL) bool
	// Client is http.DefaultTransport with a timeout when nil.
	Client *http.Client
	// MaxBytes caps one download; 200 MB when zero.
	MaxBytes int64
}

func (d *Downloader) allowed(u *url.URL) bool {
	if d != nil && d.Allow != nil {
		return d.Allow(u)
	}
	return Official(u)
}

func (d *Downloader) client() *http.Client {
	base := http.DefaultClient
	if d != nil && d.Client != nil {
		base = d.Client
	}
	c := *base
	c.Jar = nil
	if c.Timeout == 0 {
		c.Timeout = 15 * time.Minute
	}
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		if !d.allowed(req.URL) {
			return fmt.Errorf("%w: redirected to %s", ErrNotOfficial, req.URL.Host)
		}
		return nil
	}
	return &c
}

func (d *Downloader) limit() int64 {
	if d != nil && d.MaxBytes > 0 {
		return d.MaxBytes
	}
	return 200 << 20
}

// ProgressFunc reports bytes received so far and the total (-1 when unknown).
type ProgressFunc func(done, total int64)

// Fetch writes the body of rawURL to w and returns its size.
func (d *Downloader) Fetch(ctx context.Context, rawURL string, w io.Writer, progress ProgressFunc) (int64, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return 0, err
	}
	if !d.allowed(u) {
		return 0, fmt.Errorf("%w: %s", ErrNotOfficial, rawURL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "portplane/"+buildinfo.Get().Version)
	resp, err := d.client().Do(req)
	if err != nil {
		return 0, fmt.Errorf("could not download %s: %w", rawURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("could not download %s: the server answered %s", rawURL, resp.Status)
	}
	max := d.limit()
	if resp.ContentLength > max {
		return 0, fmt.Errorf("%s is larger than %d MB", rawURL, max>>20)
	}
	body := io.LimitReader(resp.Body, max+1)
	if progress != nil {
		body = &progressReader{r: body, total: resp.ContentLength, fn: progress}
	}
	n, err := io.Copy(w, body)
	if err != nil {
		return n, fmt.Errorf("could not download %s: %w", rawURL, err)
	}
	if n > max {
		return n, fmt.Errorf("%s is larger than %d MB", rawURL, max>>20)
	}
	return n, nil
}

// Text fetches a small text file, such as SHASUMS256.txt.
func (d *Downloader) Text(ctx context.Context, rawURL string) (string, error) {
	var b strings.Builder
	small := &Downloader{MaxBytes: 4 << 20}
	if d != nil {
		small.Allow, small.Client = d.Allow, d.Client
	}
	if _, err := small.Fetch(ctx, rawURL, &b, nil); err != nil {
		return "", err
	}
	return b.String(), nil
}

// File downloads rawURL into path, checks its SHA-256 against want (hex)
// while it streams, and removes the file when it does not match. An empty
// want is refused: every download Portplane keeps is checked.
func (d *Downloader) File(ctx context.Context, rawURL, path, want string, progress ProgressFunc) error {
	want = strings.ToLower(strings.TrimSpace(want))
	if want == "" {
		return fmt.Errorf("no checksum to check %s against", filepath.Base(path))
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = d.Fetch(ctx, rawURL, io.MultiWriter(f, h), progress)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		_ = os.Remove(path)
		return &MismatchError{File: filepath.Base(path), Want: want, Got: got}
	}
	return nil
}

type progressReader struct {
	r     io.Reader
	done  int64
	total int64
	fn    ProgressFunc
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.done += int64(n)
	p.fn(p.done, p.total)
	return n, err
}

// progressLogger logs a download every 10 percent, or every 10 MB when the
// size is unknown.
func progressLogger(logf func(string, ...any)) ProgressFunc {
	next := int64(0)
	return func(done, total int64) {
		if total > 0 {
			step := total / 10
			if step == 0 {
				step = total
			}
			if done >= next || done == total {
				logf("  %s of %s", mb(done), mb(total))
				next = (done/step + 1) * step
			}
			return
		}
		if done >= next {
			logf("  %s", mb(done))
			next = done + 10<<20
		}
	}
}

func mb(n int64) string {
	return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
}
