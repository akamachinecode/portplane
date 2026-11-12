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
	Onboarding    Onboarding    `json:"onboarding"`
	// AppsLayout is how the Apps view lists apps: cards or table.
	AppsLayout string `json:"appsLayout"`
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
