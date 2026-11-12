package window

import "testing"

func TestValidFragment(t *testing.T) {
	for f, want := range map[string]bool{
		"#/health": true,
		"#/apps/local/%2Fhome%2Fdev%2Fcode%23web": true,
		"#/projects/box/%2Fsrv":                   true,
		"":                                        false,
		"#health":                                 false,
		"/health":                                 false,
		`#/x"); alert(1); ("`:                     false,
		"#/a b":                                   false,
		"#/a\nb":                                  false,
		"#/<script>":                              false,
	} {
		if got := ValidFragment(f); got != want {
			t.Errorf("ValidFragment(%q) = %v, want %v", f, got, want)
		}
	}
}

func TestNormalizeTheme(t *testing.T) {
	for in, want := range map[string]string{"light": "light", "dark": "dark", "system": "system", "": "system", "sepia": "system"} {
		if got := NormalizeTheme(in); got != want {
			t.Errorf("NormalizeTheme(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRouteURL(t *testing.T) {
	for raw, want := range map[string]string{
		"http://127.0.0.1:4799":         "http://127.0.0.1:4799/#/health",
		"http://127.0.0.1:4799/":        "http://127.0.0.1:4799/#/health",
		"http://127.0.0.1:4799/#/apps":  "http://127.0.0.1:4799/#/health",
		"https://portplane.localhost/x": "https://portplane.localhost/x#/health",
	} {
		if got := RouteURL(raw, "#/health"); got != want {
			t.Errorf("RouteURL(%q) = %q, want %q", raw, got, want)
		}
	}
}
