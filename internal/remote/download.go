package remote

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/buildinfo"
)

// ReleaseBase is where release archives live.
const ReleaseBase = "https://github.com/akamachinecode/portplane/releases/download"

var releaseVersion = regexp.MustCompile(`^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)

// ReleaseBinary returns a cached portplane binary for goos/goarch of this
// exact release, downloading the archive and checking it against the
// release's checksums.txt. Development builds cannot do this.
func ReleaseBinary(ctx context.Context, goos, goarch string) (string, error) {
	version := strings.TrimPrefix(buildinfo.Version(), "v")
	if !releaseVersion.MatchString(version) || strings.Contains(version, "SNAPSHOT") {
		return "", fmt.Errorf("this is a development build (%s): install portplane on the remote machine, or use a release", buildinfo.Version())
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cache, "portplane", "agents", version, goos+"_"+goarch)
	bin := filepath.Join(dir, "portplane")
	if _, err := os.Stat(bin); err == nil {
		return bin, nil
	}
	archive := fmt.Sprintf("portplane_%s_%s_%s.tar.gz", version, goos, goarch)
	base := fmt.Sprintf("%s/v%s/", ReleaseBase, version)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	sums, err := fetch(ctx, base+"checksums.txt", 1<<20)
	if err != nil {
		return "", err
	}
	want := ""
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && f[1] == archive {
			want = f[0]
		}
	}
	if want == "" {
		return "", fmt.Errorf("release v%s has no %s", version, archive)
	}
	data, err := fetch(ctx, base+archive, 200<<20)
	if err != nil {
		return "", err
	}
	got := sha256.Sum256(data)
	if hex.EncodeToString(got[:]) != want {
		return "", fmt.Errorf("%s does not match the release checksum", archive)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := extract(data, bin); err != nil {
		return "", err
	}
	return bin, nil
}

func fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "portplane/"+buildinfo.Version())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func extract(tgz []byte, dst string) error {
	gz, err := gzip.NewReader(strings.NewReader(string(tgz)))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return errors.New("the archive has no portplane binary")
		}
		if err != nil {
			return err
		}
		if filepath.Base(h.Name) != "portplane" || h.Typeflag != tar.TypeReg {
			continue
		}
		tmp := dst + ".part"
		f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(f, io.LimitReader(tr, 200<<20)); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		return os.Rename(tmp, dst)
	}
}
