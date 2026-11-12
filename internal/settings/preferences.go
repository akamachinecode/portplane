package settings

import (
	"fmt"
	"strings"
)

// Preferences are how the user likes Portplane: look, favourites,
// notifications, update checks and where the first-run setup stands.
type Preferences struct {
	Theme         string        `json:"theme"`     // system, light or dark
	Density       string        `json:"density"`   // comfortable or compact
	Favorites     []string      `json:"favorites"` // "<machine>|<appId>"
	Notifications Notifications `json:"notifications"`
	UpdateCheck   string        `json:"updateCheck"` // manual or auto (ADR-0025)
	// UpdateAsked is true once the user answered whether Portplane may
	// check for new versions once a day (ADR-0031); until then the app
	// asks.
	UpdateAsked bool       `json:"updateAsked"`
	Onboarding  Onboarding `json:"onboarding"`
	// AppsLayout is how the Apps view lists apps: cards or table.
	AppsLayout string `json:"appsLayout"`
	// Icons are the icons the user chose for apps and projects (ADR-0030),
	// keyed "project:<machine>|<name>" or "app:<machine>|<appId>". Anything
	// without an entry shows the image found in its folder, or its initials.
	Icons map[string]IconChoice `json:"icons,omitempty"`
}

// IconChoice is the icon the user picked for one app or project: its
// initials (with their own letters and colour), or an image file on a
// machine.
type IconChoice struct {
	Kind    string `json:"kind"`              // auto, initials or file
	Text    string `json:"text,omitempty"`    // initials: up to 3 characters
	Tint    int    `json:"tint,omitempty"`    // initials: 1–8, 0 for the name's own
	Machine string `json:"machine,omitempty"` // file: the machine the file is on
	Path    string `json:"path,omitempty"`    // file: an absolute path
}

// Notifications says which system notifications to show. Only failures
// are on by default (plan §6.5).
type Notifications struct {
	Failures   bool `json:"failures"`   // an app crashed, or a job failed
	Recoveries bool `json:"recoveries"` // a failed app is back
	Jobs       bool `json:"jobs"`       // an install or another long job finished
	Config     bool `json:"config"`     // a dekit.yaml changed and needs a reload
}

// Onboarding records the first-run setup, so it resumes where it was left.
type Onboarding struct {
	Completed bool     `json:"completed"`
	Skipped   bool     `json:"skipped"`
	Step      string   `json:"step,omitempty"`
	Done      []string `json:"done"`
	// Choices keeps what the user picked on the way, such as the proxy
	// mode ("service" or "unprivileged").
	Choices map[string]string `json:"choices,omitempty"`
}

// DefaultPreferences is what a new user gets.
func DefaultPreferences() Preferences {
	return Preferences{
		Theme:         "system",
		Density:       "comfortable",
		Favorites:     []string{},
		Notifications: Notifications{Failures: true},
		UpdateCheck:   "manual",
		Onboarding:    Onboarding{Done: []string{}},
		AppsLayout:    "cards",
	}
}

// Normalize fills what is missing with the defaults.
func (p *Preferences) Normalize() {
	d := DefaultPreferences()
	if p.Theme == "" {
		p.Theme = d.Theme
	}
	if p.Density == "" {
		p.Density = d.Density
	}
	if p.Favorites == nil {
		p.Favorites = []string{}
	}
	if p.UpdateCheck == "" {
		p.UpdateCheck = d.UpdateCheck
	}
	if p.Onboarding.Done == nil {
		p.Onboarding.Done = []string{}
	}
	if p.AppsLayout == "" {
		p.AppsLayout = d.AppsLayout
	}
}

// Validate rejects values the UI does not know.
func (p Preferences) Validate() error {
	oneOf := func(field, v string, allowed ...string) error {
		for _, a := range allowed {
			if v == a {
				return nil
			}
		}
		return fmt.Errorf("%s must be one of %s, not %q", field, strings.Join(allowed, ", "), v)
	}
	if err := oneOf("theme", p.Theme, "system", "light", "dark"); err != nil {
		return err
	}
	if err := oneOf("density", p.Density, "comfortable", "compact"); err != nil {
		return err
	}
	if err := oneOf("updateCheck", p.UpdateCheck, "manual", "auto"); err != nil {
		return err
	}
	if err := oneOf("appsLayout", p.AppsLayout, "cards", "table"); err != nil {
		return err
	}
	if len(p.Favorites) > 500 {
		return fmt.Errorf("too many favourites")
	}
	if len(p.Icons) > 2000 {
		return fmt.Errorf("too many icons")
	}
	for key, c := range p.Icons {
		if err := c.validate(key); err != nil {
			return err
		}
	}
	return nil
}

func (c IconChoice) validate(key string) error {
	if !strings.HasPrefix(key, "project:") && !strings.HasPrefix(key, "app:") || len(key) > 2048 {
		return fmt.Errorf("icon key %q must start with \"project:\" or \"app:\"", key)
	}
	switch c.Kind {
	case "auto":
	case "initials":
		if n := len([]rune(c.Text)); n > 3 {
			return fmt.Errorf("the initials of %s are %d characters long; 3 at most", key, n)
		}
		if c.Tint < 0 || c.Tint > 8 {
			return fmt.Errorf("the colour of %s must be between 1 and 8", key)
		}
	case "file":
		if c.Machine == "" || c.Path == "" || len(c.Path) > 4096 {
			return fmt.Errorf("the icon of %s needs a machine and a path", key)
		}
	default:
		return fmt.Errorf("icon kind must be auto, initials or file, not %q", c.Kind)
	}
	return nil
}

// Prefs returns the preferences with the defaults filled in.
func (s Settings) Prefs() Preferences {
	if s.Preferences == nil {
		return DefaultPreferences()
	}
	p := *s.Preferences
	p.Normalize()
	return p
}
