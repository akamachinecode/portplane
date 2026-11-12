package installer

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// ErrNoChecksum means a checksum file has no entry for a file.
var ErrNoChecksum = errors.New("no published checksum")

// MismatchError means a download is not the file that was published.
type MismatchError struct {
	File      string
	Want, Got string
}

func (e *MismatchError) Error() string {
	return fmt.Sprintf("%s does not match its published checksum (expected SHA-256 %s, got %s), so it was not installed", e.File, short(e.Want), short(e.Got))
}

func short(h string) string {
	if len(h) > 12 {
		return h[:8] + "…" + h[len(h)-4:]
	}
	return h
}

// ParseSums reads a SHA256SUMS or SHASUMS256.txt file: lines of
// "<hex>  <name>", with "*<name>" for binary mode. It returns name -> hex.
// Lines that are not of that form are ignored.
func ParseSums(text string) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) != 2 {
			continue
		}
		sum, name := strings.ToLower(fields[0]), strings.TrimPrefix(fields[1], "*")
		if len(sum) != 64 || !isHex(sum) || name == "" {
			continue
		}
		out[name] = sum
	}
	return out
}

func isHex(s string) bool {
	_, err := hex.DecodeString(s)
	return err == nil
}

// Expected returns the checksum of name, or ErrNoChecksum.
func Expected(sums map[string]string, name string) (string, error) {
	if s, ok := sums[name]; ok {
		return s, nil
	}
	return "", fmt.Errorf("%w for %s", ErrNoChecksum, name)
}

// FileSHA256 returns the hex SHA-256 of a file.
func FileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Verify checks a file against the hex SHA-256 want.
func Verify(path, want string) error {
	got, err := FileSHA256(path)
	if err != nil {
		return err
	}
	want = strings.ToLower(strings.TrimSpace(want))
	if want == "" {
		return fmt.Errorf("%w for %s", ErrNoChecksum, path)
	}
	if got != want {
		return &MismatchError{File: path, Want: want, Got: got}
	}
	return nil
}
