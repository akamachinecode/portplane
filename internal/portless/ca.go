package portless

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// CA describes the local certificate authority portless signs its
// certificates with.
type CA struct {
	Exists bool   `json:"exists"`
	Path   string `json:"path"`
	// Fingerprint is the SHA-256 of the certificate, as browsers show it.
	Fingerprint string    `json:"fingerprint,omitempty"`
	Subject     string    `json:"subject,omitempty"`
	NotAfter    time.Time `json:"notAfter,omitzero"`
	// Trusted means the system trust store has this CA, as far as portless
	// recorded it or (on Linux) the system copy matches.
	Trusted bool `json:"trusted"`
	// SystemCopy is where Linux keeps the trusted copy, and
	// SystemCopyNotRoot that it is not owned by root, so a process of this
	// user could replace it.
	SystemCopy        string `json:"systemCopy,omitempty"`
	SystemCopyNotRoot bool   `json:"systemCopyNotRoot,omitempty"`
}

// linuxAnchors are where portless copies the CA, per distribution family.
var linuxAnchors = []string{
	"/etc/pki/ca-trust/source/anchors/portless-ca.crt",          // Fedora, RHEL
	"/usr/local/share/ca-certificates/portless-ca.crt",          // Debian, Ubuntu
	"/etc/ca-certificates/trust-source/anchors/portless-ca.crt", // Arch
	"/etc/pki/trust/anchors/portless-ca.crt",                    // SUSE
}

// CA reads ca.pem and how it is trusted. It changes nothing.
func (c *Client) CA() CA {
	ca := CA{Path: filepath.Join(c.StateDir, "ca.pem")}
	if c.StateDir == "" {
		return ca
	}
	raw, err := os.ReadFile(ca.Path)
	if err != nil {
		return ca
	}
	ca.Exists = true
	if block, _ := pem.Decode(raw); block != nil {
		sum := sha256.Sum256(block.Bytes)
		ca.Fingerprint = colonHex(sum[:])
		if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
			ca.Subject = cert.Subject.CommonName
			ca.NotAfter = cert.NotAfter
		}
	}
	// portless's own marker: the SHA-256 of the PEM file once trusted.
	fileSum := sha256.Sum256(raw)
	if b, err := os.ReadFile(filepath.Join(c.StateDir, "ca.trusted")); err == nil {
		marker := strings.TrimPrefix(strings.TrimSpace(string(b)), "wsl:")
		ca.Trusted = marker == hex.EncodeToString(fileSum[:])
	}
	if runtime.GOOS == "linux" {
		for _, p := range linuxAnchors {
			sys, err := os.ReadFile(p)
			if err != nil {
				continue
			}
			ca.SystemCopy = p
			ca.SystemCopyNotRoot = !ownedByRoot(p)
			if strings.TrimSpace(string(sys)) == strings.TrimSpace(string(raw)) {
				ca.Trusted = true
			}
			break
		}
	}
	return ca
}

func colonHex(b []byte) string {
	h := strings.ToUpper(hex.EncodeToString(b))
	parts := make([]string, 0, len(h)/2)
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":")
}
