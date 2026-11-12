package server

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/portless"
)

// portless.json per project (plan §5.5): where configs are, one folder's
// configs, and writing one after a preview.

// ConfigApp is an app that runs in a config's folder.
type ConfigApp struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Project string `json:"project"`
	// RunMode: the app runs `portless run`, so this folder's config names it.
	RunMode bool `json:"runMode"`
}

// ConfigPlace is one folder with a portless config, or one where an app
// runs `portless run` and a config would name it.
type ConfigPlace struct {
	Dir  string      `json:"dir"`
	Wins string      `json:"wins"`
	Apps []ConfigApp `json:"apps"`
}

func (p *portlessAPI) configPlaces(ctx context.Context) []ConfigPlace {
	if p.d.Local == nil {
		return []ConfigPlace{}
	}
	local := p.d.Local(ctx)
	byDir := map[string]*ConfigPlace{}
	var order []string
	place := func(dir string) *ConfigPlace {
		if pl, ok := byDir[dir]; ok {
			return pl
		}
		pl := &ConfigPlace{Dir: dir, Apps: []ConfigApp{}}
		byDir[dir] = pl
		order = append(order, dir)
		return pl
	}
	for _, r := range local.Runners {
		place(r.Root)
	}
	for _, a := range local.Apps {
		if a.Dir == "" {
			continue
		}
		run := false
		if w := portless.ParseCommand(a.Command); w != nil && w.Run && w.Name == "" {
			run = true
		}
		pl := place(a.Dir)
		pl.Apps = append(pl.Apps, ConfigApp{ID: a.ID, Label: a.Label, Project: a.Project, RunMode: run})
	}
	out := []ConfigPlace{}
	for _, dir := range order {
		pl := byDir[dir]
		pl.Wins = portless.ReadProjectConfigs(dir).Wins
		run := false
		for _, a := range pl.Apps {
			run = run || a.RunMode
		}
		if pl.Wins != "" || run {
			out = append(out, *pl)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Dir < out[j].Dir })
	return out
}

// knownDir accepts only folders Portplane shows: a project, an app's
// folder, or a folder inside the watched ones.
func (p *portlessAPI) knownDir(ctx context.Context, dir string) (string, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return "", errors.New("pick a project folder")
	}
	dir = filepath.Clean(dir)
	if p.d.Local == nil {
		return "", errors.New("no local machine")
	}
	local := p.d.Local(ctx)
	for _, f := range local.Folders {
		if dekit.Inside(dir, f) {
			return dir, nil
		}
	}
	for _, r := range local.Runners {
		if dekit.Inside(dir, r.Root) {
			return dir, nil
		}
	}
	return "", errors.New("only portless config inside the folders Portplane watches can be edited here")
}

func (p *portlessAPI) configs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, p.configPlaces(r.Context()))
}

func (p *portlessAPI) config(w http.ResponseWriter, r *http.Request) {
	dir, err := p.knownDir(r.Context(), r.URL.Query().Get("dir"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, portless.ReadProjectConfigs(dir))
}

type configRequest struct {
	Dir    string `json:"dir"`
	Target string `json:"target"` // portless.json or package.json
	Text   string `json:"text"`
	Digest string `json:"digest,omitempty"` // of the file as the editor read it; "" for a new file
}

// ConfigPreview is POST /api/portless/config/preview.
type ConfigPreview struct {
	Edit     *FileEdit `json:"edit,omitempty"`
	Problems []string  `json:"problems"`
	Warnings []string  `json:"warnings"`
}

func (p *portlessAPI) configPreview(w http.ResponseWriter, r *http.Request) {
	var req configRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	dir, err := p.knownDir(r.Context(), req.Dir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	_, problems, warnings := portless.ValidateConfig([]byte(req.Text))
	pv := ConfigPreview{Problems: problems, Warnings: warnings}
	if len(problems) == 0 {
		e, err := portless.PlanConfigText(dir, req.Target, req.Text)
		if err != nil {
			pv.Problems = append(pv.Problems, err.Error())
		} else {
			fe := fileEdit(e)
			pv.Edit = &fe
		}
	}
	writeJSON(w, http.StatusOK, pv)
}

func (p *portlessAPI) configSave(w http.ResponseWriter, r *http.Request) {
	var req configRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	dir, err := p.knownDir(r.Context(), req.Dir)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	e, err := portless.PlanConfigText(dir, req.Target, req.Text)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	cur := ""
	if e.Before != "" || !e.Created {
		cur = portless.ReadProjectConfigs(dir).Portless.Digest
		if req.Target == portless.PackageFile {
			cur = portless.ReadProjectConfigs(dir).Package.Digest
		}
	}
	if strings.TrimSpace(req.Digest) != cur {
		writeError(w, http.StatusConflict, portless.ErrConfigChanged)
		return
	}
	if err := portless.WriteEdit(e); err != nil {
		code := http.StatusInternalServerError
		if errors.Is(err, portless.ErrConfigChanged) {
			code = http.StatusConflict
		}
		writeError(w, code, err)
		return
	}
	p.d.Refresh()
	writeJSON(w, http.StatusOK, portless.ReadProjectConfigs(dir))
}
