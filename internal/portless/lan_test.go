package portless

import (
	"net"
	"reflect"
	"testing"
)

func TestCheckMDNS(t *testing.T) {
	has := func(string) string { return "/usr/bin/tool" }
	none := func(string) string { return "" }
	if m := CheckMDNS("darwin", has, ""); !m.Supported || m.Tool != "dns-sd" || !m.Installed {
		t.Errorf("darwin %+v", m)
	}
	if m := CheckMDNS("windows", has, ""); m.Supported {
		t.Errorf("portless 0.16 has no mDNS publisher on Windows: %+v", m)
	}
	fedora := "NAME=\"Fedora Linux\"\nID=fedora\nVERSION_ID=44\n"
	if m := CheckMDNS("linux", none, fedora); !m.Supported || m.Installed || m.Tool != "avahi-publish-address" || m.Package != "avahi-tools" || m.Install != "sudo dnf install avahi-tools" {
		t.Errorf("fedora %+v", m)
	}
	cases := map[string]string{
		"ID=ubuntu\nID_LIKE=debian\n":                "sudo apt install avahi-utils",
		"ID=pop\nID_LIKE=\"ubuntu debian\"\n":        "sudo apt install avahi-utils",
		"ID=endeavouros\nID_LIKE=arch\n":             "sudo pacman -S avahi",
		"ID=\"opensuse-tumbleweed\"\nID_LIKE=suse\n": "sudo zypper install avahi-utils",
		"ID=rocky\nID_LIKE=\"rhel centos fedora\"\n": "sudo dnf install avahi-tools",
		"": "sudo apt install avahi-utils",
	}
	for rel, want := range cases {
		if _, cmd := AvahiInstall(rel); cmd != want {
			t.Errorf("%q: %s", rel, cmd)
		}
	}
}

func TestLANCandidates(t *testing.T) {
	ifaces := []Iface{
		{Name: "lo", Up: true, Loopback: true, IPs: []net.IP{net.ParseIP("127.0.0.1")}},
		{Name: "wlp2s0", Up: true, MAC: "a4:c3:f0:11:22:33", IPs: []net.IP{net.ParseIP("192.168.1.20"), net.ParseIP("fe80::1"), net.ParseIP("169.254.3.4")}},
		{Name: "enp3s0", Up: true, MAC: "a4:c3:f0:11:22:34", IPs: []net.IP{net.ParseIP("10.0.0.5")}},
		{Name: "docker0", Up: true, MAC: "02:42:ac:11:00:01", IPs: []net.IP{net.ParseIP("172.17.0.1")}},
		{Name: "tailscale0", Up: true, IPs: []net.IP{net.ParseIP("100.101.102.103")}},
		{Name: "eth9", Up: true, MAC: "00:15:5d:01:02:03", IPs: []net.IP{net.ParseIP("172.20.0.1")}},
		{Name: "en7", Up: false, MAC: "a4:c3:f0:11:22:35", IPs: []net.IP{net.ParseIP("192.168.2.9")}},
		{Name: "en8", Up: true, MAC: "a4:c3:f0:11:22:36", IPs: []net.IP{net.ParseIP("100.64.1.1")}},
	}
	got := LANCandidates(ifaces, "10.0.0.5")
	want := []LANAddress{{IP: "10.0.0.5", Interface: "enp3s0", Default: true}, {IP: "192.168.1.20", Interface: "wlp2s0"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%+v", got)
	}
	if LANCandidates(nil, "") != nil {
		t.Error("none")
	}
}

func TestLANHostname(t *testing.T) {
	cases := map[string]string{"web.localhost": "web.local", "api.shop.test": "api.shop.local", "web.local": "web.local", "docs.dev.example.com": "docs.local"}
	for in, want := range cases {
		if got := LANHostname(in, []string{"test", "dev.example.com"}); got != want {
			t.Errorf("%s: %s", in, got)
		}
	}
}

func TestValidTLD(t *testing.T) {
	for _, ok := range []string{"localhost", "test", ".test", "dev.example.com", "a1-b"} {
		if !ValidTLD(ok) {
			t.Errorf("refused %q", ok)
		}
	}
	for _, bad := range []string{"", "bad tld", "-x", "x-", "a..b", "Test", "a.", string(make([]byte, 64))} {
		if ValidTLD(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
	if err := (ProxyOptions{Port: 443, HTTPS: true, TLDs: []string{"dev.example.com"}}).Validate(); err != nil {
		t.Errorf("multi-label TLD: %v", err)
	}
	if err := (ProxyOptions{Port: 443, LAN: true, LANIP: "not-an-ip"}).Validate(); err == nil {
		t.Error("bad LAN IP")
	}
}
