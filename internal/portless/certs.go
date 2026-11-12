package portless

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/akamachinecode/portplane/internal/privileged"
)

// Certificates (plan §5.6): the certificates portless signed for each
// hostname, exporting the CA for phones on the LAN, regenerating it, and
// fixing the ownership of the system's copy on Linux.

// HostCert is one certificate in host-certs/.
type HostCert struct {
	File     string    `json:"file"`
	Names    []string  `json:"names"`
	NotAfter time.Time `json:"notAfter,omitzero"`
	// SignedByCA: the current ca.pem signed it. A certificate from an older
	// CA makes browsers warn; portless replaces it when it expires.
	SignedByCA bool `json:"signedByCa"`
}

// HostCerts lists host-certs/*.pem (not the keys), newest expiry first.
func (c *Client) HostCerts() []HostCert {
	out := []HostCert{}
	if c.StateDir == "" {
		return out
	}
	var ca *x509.Certificate
	if b, err := os.ReadFile(filepath.Join(c.StateDir, "ca.pem")); err == nil {
		ca = parseCert(b)
	}
	dir := filepath.Join(c.StateDir, "host-certs")
	files, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, f := range files {
		name := f.Name()
		if f.IsDir() || !strings.HasSuffix(name, ".pem") || strings.HasSuffix(name, "-key.pem") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		cert := parseCert(b)
		if cert == nil {
			continue
		}
		h := HostCert{File: name, Names: cert.DNSNames, NotAfter: cert.NotAfter}
		if len(h.Names) == 0 && cert.Subject.CommonName != "" {
			h.Names = []string{cert.Subject.CommonName}
		}
		if ca != nil {
			h.SignedByCA = cert.CheckSignatureFrom(ca) == nil
		}
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].File < out[j].File })
	return out
}

func parseCert(b []byte) *x509.Certificate {
	block, _ := pem.Decode(b)
	if block == nil {
		return nil
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil
	}
	return cert
}

// ExportCA copies ca.pem into dir as portless-ca.pem (another name when
// that one exists) and returns the new file. A phone on the LAN needs it to
// trust the proxy's certificates.
func (c *Client) ExportCA(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(c.StateDir, "ca.pem"))
	if err != nil {
		return "", errors.New("portless has no certificate yet: start the proxy with HTTPS or trust it first")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(dir, "portless-ca.pem")
	for i := 2; exists(dest); i++ {
		dest = filepath.Join(dir, fmt.Sprintf("portless-ca-%d.pem", i))
	}
	if err := os.WriteFile(dest, b, 0o644); err != nil {
		return "", err
	}
	return dest, nil
}

// caFiles are what makes up the CA and what it signed. Regenerating moves
// them aside; `portless trust` then creates a new CA and server certificate,
// and portless signs host certificates again on demand.
var caFiles = []string{"ca.pem", "ca-key.pem", "ca.srl", "ca.trusted", "server.pem", "server-key.pem", "host-certs"}

// BackupCA moves the CA, its trust marker and the certificates it signed
// into a new folder of the state directory, and returns that folder.
// Nothing is deleted, so the old CA can be put back by hand.
func (c *Client) BackupCA(now time.Time) (string, error) {
	if c.StateDir == "" {
		return "", errors.New("portless's state folder is unknown")
	}
	dir := filepath.Join(c.StateDir, "ca-backup-"+now.Format("20060102-150405"))
	if err := os.Mkdir(dir, 0o700); err != nil {
		return "", err
	}
	moved := 0
	for _, name := range caFiles {
		from := filepath.Join(c.StateDir, name)
		if !exists(from) {
			continue
		}
		if err := os.Rename(from, filepath.Join(dir, name)); err != nil {
			return dir, fmt.Errorf("moving %s aside: %w", name, err)
		}
		moved++
	}
	if moved == 0 {
		_ = os.Remove(dir)
		return "", nil
	}
	return dir, nil
}

// TrustArgs are the arguments of `portless trust`, which creates the CA
// when it is missing and adds it to the system's trust store.
func TrustArgs() []string { return []string{"trust"} }

// FixOwnershipCommand gives the system's copy of the CA back to root
// (Linux): while the user owns it, any program of theirs could replace it
// with another CA that the system would then trust.
func FixOwnershipCommand(path string) (privileged.Command, error) {
	if path == "" {
		return privileged.Command{}, errors.New("no system copy of the certificate to fix")
	}
	chown := "/usr/bin/chown"
	if !exists(chown) {
		if p, err := exec.LookPath("chown"); err == nil {
			if abs, err := filepath.Abs(p); err == nil {
				chown = abs
			}
		}
	}
	return privileged.Command{
		Argv:   []string{chown, "root:root", path},
		Reason: "Portplane needs your password to give the trusted local certificate back to the administrator.",
	}, nil
}
