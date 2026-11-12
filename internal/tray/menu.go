package tray

import (
	"context"
	"strconv"
	"strings"
	"sync"

	"github.com/akamachinecode/portplane/internal/model"
)

// Extras give the tray the favourites and problems menu (plan §6.5). Set
// them with SetExtras before Run; without them the tray shows the summary,
// Open, Start at login and Quit.
type Extras struct {
	// Favorites returns the pinned apps, as "<machine>|<appId>".
	Favorites func() []string
	// Act starts, stops or restarts one app.
	Act func(ctx context.Context, machine string, app model.App, verb model.Verb) error
	// OpenRoute opens the window at a route of the UI, such as "#/health".
	OpenRoute func(fragment string)
	// OpenURL opens an app's address in the browser.
	OpenURL func(url string) error
	// Problems counts what the Health view lists as errors and warnings.
	Problems func(model.Snapshot) int
}

var (
	extrasMu sync.Mutex
	extras   Extras
)

// SetExtras sets the favourites and problems menu for the next Run.
func SetExtras(e Extras) {
	extrasMu.Lock()
	extras = e
	extrasMu.Unlock()
}

func currentExtras() Extras {
	extrasMu.Lock()
	defer extrasMu.Unlock()
	return extras
}

// MaxFavorites is how many pinned apps the menu lists.
const MaxFavorites = 12

// Menu is what the tray menu shows for one snapshot.
type Menu struct {
	Summary  string
	Problems int
	// Favorites in the order they were pinned; pinned apps no machine
	// reports (removed, or on a machine that is offline) are left out.
	Favorites []Favorite
	// More counts favourites that did not fit.
	More int
	// CanStartPinned: at least one favourite is stopped and can start.
	CanStartPinned bool
}

// Favorite is one pinned app in the menu.
type Favorite struct {
	Key     string // "<machine>|<appId>"
	Machine string
	App     model.App
	// Title is "web · my-monorepo — Running"; the machine is named when it
	// is not this computer.
	Title string
	Alive bool
	// CanAct: dekit runs where the app lives, so it can start and stop.
	CanAct bool
	// URL opens the running app; empty while it is not running.
	URL string
}

var stateWords = map[model.State]string{
	model.StateOn:       "Running",
	model.StateStarting: "Starting…",
	model.StateStopping: "Stopping…",
	model.StateFailed:   "Failed",
	model.StateOff:      "Stopped",
	model.StateDone:     "Done",
	model.StateUnknown:  "Unknown",
}

// BuildMenu lays out the menu for a snapshot, the pinned apps and the
// problem count.
func BuildMenu(s model.Snapshot, favorites []string, problems int) Menu {
	m := Menu{Summary: Count(s).Summary(), Problems: problems}
	type found struct {
		ms  *model.MachineSnapshot
		app model.App
	}
	byKey := map[string]found{}
	for i := range s.Machines {
		ms := &s.Machines[i]
		for _, a := range ms.Apps {
			byKey[ms.Machine.ID+"|"+a.ID] = found{ms, a}
		}
	}
	seen := map[string]bool{}
	for _, key := range favorites {
		f, ok := byKey[key]
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		if len(m.Favorites) == MaxFavorites {
			m.More++
			continue
		}
		online := f.ms.Machine.Local || f.ms.Machine.Status == "online"
		fav := Favorite{
			Key:     key,
			Machine: f.ms.Machine.ID,
			App:     f.app,
			Title:   favoriteTitle(f.ms, f.app),
			Alive:   f.app.State.Alive(),
			CanAct:  online && f.ms.Tools.Dekit != "",
		}
		if f.app.State == model.StateOn {
			fav.URL = f.app.URL
			if !f.ms.Machine.Local {
				fav.URL = f.app.RemoteURL
			}
		}
		if fav.CanAct && !fav.Alive {
			m.CanStartPinned = true
		}
		m.Favorites = append(m.Favorites, fav)
	}
	return m
}

func favoriteTitle(ms *model.MachineSnapshot, a model.App) string {
	parts := []string{a.Label}
	if a.Project != "" && a.Project != a.Label {
		parts = append(parts, a.Project)
	}
	if !ms.Machine.Local {
		parts = append(parts, ms.Machine.Name)
	}
	word := stateWords[a.State]
	if word == "" {
		word = string(a.State)
	}
	return strings.Join(parts, " · ") + " — " + word
}

// ProblemsTitle is the menu item that opens Health.
func ProblemsTitle(n int) string {
	if n == 1 {
		return "1 problem…"
	}
	return strconv.Itoa(n) + " problems…"
}

// Problems counts the errors and warnings the Health view shows from the
// snapshot alone (web/src/shell/health.ts, snapshotProblems): machines
// that cannot be reached, missing dekit, a stopped proxy, runners that are
// down or unreadable, and failed apps.
func Problems(s model.Snapshot) int {
	n := 0
	for _, ms := range s.Machines {
		m := ms.Machine
		if m.Local && m.Error != "" {
			n++
		}
		if !m.Local {
			if m.Status == "offline" || (m.Status == "connecting" && m.Error != "") {
				n++
			}
			if m.Status != "online" {
				continue
			}
		}
		if ms.Tools.Dekit == "" {
			n++
		}
		if ms.Tools.Portless != "" && !ms.Tools.ProxyRunning {
			n++
		}
		if ms.Tools.Dekit != "" {
			for _, r := range ms.Runners {
				if !r.Up || r.Error != "" {
					n++
				}
			}
		}
		for _, a := range ms.Apps {
			if a.State == model.StateFailed {
				n++
			}
		}
	}
	return n
}
