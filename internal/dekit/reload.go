package dekit

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// FieldChange is one key of a task that differs between the config and the
// runner, as `dekit reload --json` reports it. Base is what the config said
// when the runner last took it in, Here is the runner's value now, Config
// the file's value now.
type FieldChange struct {
	Key      string          `json:"key"` // "cmd", "env.PORT", ...
	Base     json.RawMessage `json:"base"`
	Here     json.RawMessage `json:"here"`
	Config   json.RawMessage `json:"config"`
	Conflict bool            `json:"conflict"` // changed on both sides
	Take     bool            `json:"take"`     // --yes takes the config's value
}

// TaskChange is one task in a reload plan.
type TaskChange struct {
	Path   string        `json:"path"`
	Kind   string        `json:"kind"`  // changed, added, removed
	Apply  bool          `json:"apply"` // --yes applies it
	Reason string        `json:"reason,omitempty"`
	Fields []FieldChange `json:"fields,omitempty"`
}

// OrderChange says the config reordered its tasks.
type OrderChange struct {
	Apply    bool `json:"apply"`
	Conflict bool `json:"conflict"`
}

// ReloadPlan is the runner's list of differences with the config.
type ReloadPlan struct {
	Changes    []TaskChange `json:"changes"`
	EditedHere []string     `json:"edited_here"`
	Order      *OrderChange `json:"order,omitempty"`
}

// Empty reports whether the config and the runner agree.
func (p ReloadPlan) Empty() bool { return len(p.Changes) == 0 && p.Order == nil }

// Reload is `dekit reload --json`, with or without --yes.
type Reload struct {
	Applied bool       `json:"applied"`
	Errors  []string   `json:"errors"`
	Plan    ReloadPlan `json:"plan"`
}

// ParseReload reads `dekit reload --json`.
func ParseReload(b []byte) (Reload, error) {
	var r Reload
	if err := json.Unmarshal(b, &r); err != nil {
		return r, fmt.Errorf("dekit reload: %w", err)
	}
	if r.Errors == nil {
		r.Errors = []string{}
	}
	if r.Plan.Changes == nil {
		r.Plan.Changes = []TaskChange{}
	}
	if r.Plan.EditedHere == nil {
		r.Plan.EditedHere = []string{}
	}
	for i := range r.Plan.Changes {
		if r.Plan.Changes[i].Fields == nil {
			r.Plan.Changes[i].Fields = []FieldChange{}
		}
	}
	return r, nil
}

// ReloadPlanFor shows what a reload would change, without changing
// anything. ErrRunnerDown: the runner reads the config when it starts. An
// invalid config fails with dekit's message.
func (c *CLI) ReloadPlanFor(ctx context.Context, root string) (Reload, error) {
	out, err := c.run(ctx, 10*time.Second, runnerArgs(root, "reload", "--json")...)
	if err != nil {
		return Reload{}, err
	}
	return ParseReload(out)
}

// ApplyReload takes the config's changes (dekit reload --yes).
func (c *CLI) ApplyReload(ctx context.Context, root string) (Reload, error) {
	out, err := c.run(ctx, 30*time.Second, runnerArgs(root, "reload", "--yes", "--json")...)
	if err != nil {
		return Reload{}, err
	}
	return ParseReload(out)
}
