package portless

import (
	"bufio"
	"context"
	"net"
	"sort"
	"strings"
	"time"
)

// LAN mode (plan §5.1, §5.6): `portless proxy start --lan` listens on every
// address and publishes each route as <name>.local over mDNS, so phones and
// other computers on the same network open the apps. portless 0.16
// publishes with avahi-publish-address on Linux and dns-sd on macOS; it
// has no mDNS publisher on Windows, so LAN mode doesn't start there.

// MDNS is whether this computer can publish .local names the way portless
// does.
type MDNS struct {
	// Supported: portless has an mDNS publisher for this OS.
	Supported bool   `json:"supported"`
	Tool      string `json:"tool,omitempty"`
	Installed bool   `json:"installed"`
	Path      string `json:"path,omitempty"`
	// Package and Install say how to get the tool where it's missing.
	Package string `json:"package,omitempty"`
	Install string `json:"install,omitempty"`
}

// CheckMDNS finds the mDNS publisher portless uses on goos. osRelease is
// /etc/os-release, to name the Linux package.
func CheckMDNS(goos string, lookup func(string) string, osRelease string) MDNS {
	switch goos {
	case "darwin":
		m := MDNS{Supported: true, Tool: "dns-sd", Path: lookup("dns-sd")}
		m.Installed = m.Path != ""
		return m
	case "linux":
		m := MDNS{Supported: true, Tool: "avahi-publish-address", Path: lookup("avahi-publish-address")}
		m.Installed = m.Path != ""
		m.Package, m.Install = AvahiInstall(osRelease)
		return m
	}
	return MDNS{}
}

// AvahiInstall names the package with avahi-publish-address for a Linux
// distribution and the command that installs it.
func AvahiInstall(osRelease string) (pkg, command string) {
	ids := osIDs(osRelease)
	has := func(names ...string) bool {
		for _, n := range names {
			for _, id := range ids {
				if id == n {
					return true
				}
			}
		}
		return false
	}
	switch {
	case has("fedora", "rhel", "centos", "rocky", "almalinux"):
		return "avahi-tools", "sudo dnf install avahi-tools"
	case has("arch", "manjaro", "endeavouros"):
		return "avahi", "sudo pacman -S avahi"
	case has("opensuse", "suse", "opensuse-leap", "opensuse-tumbleweed"):
		return "avahi-utils", "sudo zypper install avahi-utils"
	case has("alpine"):
		return "avahi-tools", "sudo apk add avahi-tools"
	default:
		// Debian, Ubuntu and their derivatives; also what portless suggests.
		return "avahi-utils", "sudo apt install avahi-utils"
	}
}

// osIDs reads ID and ID_LIKE from /etc/os-release.
func osIDs(osRelease string) []string {
	var ids []string
	sc := bufio.NewScanner(strings.NewReader(osRelease))
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		if !ok || (k != "ID" && k != "ID_LIKE") {
			continue
		}
		ids = append(ids, strings.Fields(strings.ToLower(strings.Trim(v, `"'`)))...)
	}
	return ids
}

// LANAddress is an address of this computer that phones on the same
// network can reach.
type LANAddress struct {
	IP        string `json:"ip"`
	Interface string `json:"interface"`
	// Default: the address on the default route, the one portless picks
	// when no address is pinned.
	Default bool `json:"default"`
}

// Iface is one network interface's facts, for LANCandidates.
type Iface struct {
	Name     string
	Up       bool
	Loopback bool
	MAC      string
	IPs      []net.IP
}

// LANCandidates keeps the IPv4 addresses a phone could reach: not loopback,
// link-local, Tailscale's 100.64.0.0/10, or the virtual interfaces of
// Docker, VMs and VPNs (portless skips the same ones).
func LANCandidates(ifaces []Iface, defaultIP string) []LANAddress {
	_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
	var out []LANAddress
	for _, i := range ifaces {
		if !i.Up || i.Loopback || virtualIface(i.Name, i.MAC) {
			continue
		}
		for _, ip := range i.IPs {
			v4 := ip.To4()
			if v4 == nil || v4.IsLoopback() || v4.IsLinkLocalUnicast() || cgnat.Contains(v4) {
				continue
			}
			out = append(out, LANAddress{IP: v4.String(), Interface: i.Name, Default: v4.String() == defaultIP})
		}
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Default && !out[b].Default })
	return out
}

func virtualIface(name, mac string) bool {
	n := strings.ToLower(name)
	for _, p := range []string{"docker", "br-", "veth", "virbr", "vboxnet", "vmnet", "tailscale", "utun", "tun", "tap", "wg", "zt", "podman", "cni", "flannel", "lxc", "lxd"} {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	if strings.Contains(name, "vEthernet") || strings.HasPrefix(n, "bridge") {
		return true
	}
	m := strings.ToLower(mac)
	return m == "" || m == "00:00:00:00:00:00" || strings.HasPrefix(m, "00:15:5d") // Hyper-V
}

// SystemIfaces lists this computer's interfaces.
func SystemIfaces() []Iface {
	list, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []Iface
	for _, i := range list {
		f := Iface{Name: i.Name, Up: i.Flags&net.FlagUp != 0, Loopback: i.Flags&net.FlagLoopback != 0, MAC: i.HardwareAddr.String()}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				f.IPs = append(f.IPs, n.IP)
			}
		}
		out = append(out, f)
	}
	return out
}

// DefaultRouteIP is the address this computer uses on its default route,
// as portless finds it: a UDP socket "connected" to a public address picks
// the route without sending anything.
func DefaultRouteIP() string {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, err := (&net.Dialer{}).DialContext(ctx, "udp4", "1.1.1.1:53")
	if err != nil {
		return ""
	}
	defer func() { _ = c.Close() }()
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok && !a.IP.IsUnspecified() && !a.IP.IsLoopback() {
		return a.IP.String()
	}
	return ""
}

// LANHostname is a route's name on the network: the same name under
// .local, as portless publishes it.
func LANHostname(hostname string, tlds []string) string {
	base := BaseName(hostname, append([]string{"local"}, tlds...))
	if base == "" {
		return ""
	}
	return base + ".local"
}
