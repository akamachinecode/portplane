package dekit

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// NewApp is what the "Add an app" wizard collects (plan §4.6).
type NewApp struct {
	Path      string   `json:"path"` // the task path, such as "api"
	Label     string   `json:"label,omitempty"`
	Folder    string   `json:"folder"` // absolute
	Cmd       []string `json:"cmd"`
	Job       bool     `json:"job,omitempty"`
	Name      string   `json:"name,omitempty"` // portless name: https://<name>.localhost; "" for none
	Wrap      bool     `json:"wrap,omitempty"` // portless <name> <cmd>; else a portless alias to Port
	Port      int      `json:"port,omitempty"`
	Ready     *Ready   `json:"ready,omitempty"`
	Deps      []string `json:"deps,omitempty"`
	Autostart bool     `json:"autostart,omitempty"`
}

// AliasTask is the task that registers a fixed-port app's URL.
func (a NewApp) AliasTask() string { return a.Path + "-url" }

// Validate checks the wizard's answers.
func (a NewApp) Validate() error {
	if err := ValidTaskPath(a.Path); err != nil {
		return err
	}
	if !filepath.IsAbs(a.Folder) {
		return errors.New("choose the app's folder")
	}
	if len(a.Cmd) == 0 || strings.TrimSpace(a.Cmd[0]) == "" {
		return errors.New("enter the command that starts the app")
	}
	if a.Name != "" {
		if err := ValidURLName(a.Name); err != nil {
			return err
		}
		if a.Job {
			return errors.New("a step that runs once has no URL")
		}
		if !a.Wrap && (a.Port <= 0 || a.Port > 65535) {
			return errors.New("enter the port the app listens on, for its URL")
		}
	}
	if a.Job && a.Ready != nil {
		return errors.New("a step that runs once has no ready check")
	}
	return nil
}

// InsertOps are the edits that add the app to a file in fileDir.
func (a NewApp) InsertOps(fileDir string) ([]EditOp, error) {
	if err := a.Validate(); err != nil {
		return nil, err
	}
	cwd, err := filepath.Rel(fileDir, a.Folder)
	if err != nil {
		cwd = a.Folder
	}
	cwd = filepath.ToSlash(cwd)
	var ops []EditOp
	deps := append([]string{}, a.Deps...)
	cmd := append([]string{}, a.Cmd...)
	name := strings.TrimSuffix(a.Name, ".localhost")
	if name != "" && a.Wrap {
		cmd = append([]string{"portless", name}, cmd...)
	}
	if name != "" && !a.Wrap {
		alias := ordered(
			pair{"label", a.labelOr() + " URL"},
			pair{"type", "job"},
			pair{"cmd", []string{"portless", "alias", name, strconv.Itoa(a.Port), "--force"}},
		)
		ops = append(ops, EditOp{Op: "insert", Path: []string{"tasks"}, Key: a.AliasTask(), Value: alias})
		deps = append(deps, a.AliasTask())
	}
	fields := []pair{}
	if a.Label != "" {
		fields = append(fields, pair{"label", a.Label})
	}
	if a.Job {
		fields = append(fields, pair{"type", "job"})
	}
	fields = append(fields, pair{"cwd", cwd}, pair{"cmd", cmd})
	if len(deps) > 0 {
		fields = append(fields, pair{"deps", deps})
	}
	if a.Ready != nil {
		r := map[string]any{}
		switch {
		case a.Ready.Log != "":
			r["log"] = a.Ready.Log
		case a.Ready.TCP > 0:
			r["tcp"] = a.Ready.TCP
		case a.Ready.HTTP != "":
			r["http"] = a.Ready.HTTP
		}
		if len(r) > 0 {
			fields = append(fields, pair{"ready", r})
		}
	}
	if a.Autostart {
		fields = append(fields, pair{"autostart", true})
	}
	ops = append(ops, EditOp{Op: "insert", Path: []string{"tasks"}, Key: a.Path, Value: ordered(fields...)})
	return ops, nil
}

func (a NewApp) labelOr() string {
	if a.Label != "" {
		return a.Label
	}
	return a.Path
}

type pair struct {
	k string
	v any
}

// ordered marshals key/value pairs as a JSON object in that order.
func ordered(pairs ...pair) json.RawMessage {
	var b strings.Builder
	b.WriteByte('{')
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(p.k)
		vb, err := json.Marshal(p.v)
		if err != nil {
			panic(fmt.Sprintf("newapp: %v", err))
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return json.RawMessage(b.String())
}
