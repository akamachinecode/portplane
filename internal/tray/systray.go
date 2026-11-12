//go:build !darwin || cgo

package tray

import (
	"context"
	"runtime"
	"slices"
	"strconv"
	"sync"
	"time"

	"fyne.io/systray"

	"github.com/akamachinecode/portplane/internal/icon"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/window"
)

// Available reports whether a tray can be shown here.
func Available() bool {
	switch runtime.GOOS {
	case "darwin", "windows":
		return true
	}
	// Linux and BSDs: needs a session bus with a StatusNotifier host.
	return statusNotifierHost()
}

func setIcon(lit int) {
	if lit > 3 {
		lit = 3
	}
	switch runtime.GOOS {
	case "darwin":
		systray.SetTemplateIcon(icon.TemplatePNG(44, lit), icon.PNG(44, lit))
	case "windows":
		systray.SetIcon(icon.ICO(icon.PNG(16, lit), icon.PNG(32, lit)))
	default:
		systray.SetIcon(icon.PNG(64, lit))
	}
}

// favoritesRefresh is how often the pinned apps are read again, so a pin
// made in the window shows without waiting for the next snapshot.
const favoritesRefresh = 3 * time.Second

func run(ctx context.Context, o Options) {
	x := currentExtras()
	onReady := func() {
		watchReopen(ctx, o.Open)
		setIcon(0)
		systray.SetTooltip("Portplane")
		status := systray.AddMenuItem("Starting…", "")
		status.Disable()
		problems := systray.AddMenuItem("", "See what needs your attention in Health")
		problems.Hide()
		open := systray.AddMenuItem("Open Portplane", "Open the Portplane window")
		var favs *favoritesMenu
		if x.Favorites != nil {
			systray.AddSeparator()
			favs = newFavoritesMenu(ctx, x, o.ReportFailure)
		}
		systray.AddSeparator()
		on := false
		if o.Autostart != nil {
			on, _ = o.Autostart()
		}
		login := systray.AddMenuItemCheckbox("Start at login", "Start Portplane when you log in", on)
		systray.AddSeparator()
		quit := systray.AddMenuItem("Quit Portplane", "Stop Portplane (your dev servers keep running)")

		go func() {
			lastLit := -1
			var last model.Snapshot
			var pinned []string
			refresh := time.NewTicker(favoritesRefresh)
			defer refresh.Stop()
			render := func() {
				c := Count(last)
				n := 0
				if x.Problems != nil {
					n = x.Problems(last)
				}
				status.SetTitle(c.Summary())
				tip := "Portplane: " + c.Summary()
				if n > 0 {
					tip += " · " + ProblemsTitle(n)
					problems.SetTitle("⚠ " + ProblemsTitle(n))
					problems.Show()
				} else {
					problems.Hide()
				}
				systray.SetTooltip(tip)
				if favs != nil {
					favs.update(BuildMenu(last, pinned, n))
				}
				if runtime.GOOS == "darwin" {
					if c.Running > 0 {
						systray.SetTitle(" " + strconv.Itoa(c.Running))
					} else {
						systray.SetTitle("")
					}
				}
				lit := min(c.Running, 3)
				if lit != lastLit {
					setIcon(lit)
					lastLit = lit
				}
			}
			for {
				select {
				case <-ctx.Done():
					systray.Quit()
					return
				case s := <-o.Updates:
					last = s
					if x.Favorites != nil {
						pinned = x.Favorites()
					}
					render()
					if o.Autostart != nil { // it may have changed in the UI or the CLI
						if on, err := o.Autostart(); err == nil && on != login.Checked() {
							if on {
								login.Check()
							} else {
								login.Uncheck()
							}
						}
					}
				case <-refresh.C:
					if x.Favorites == nil {
						continue
					}
					if p := x.Favorites(); !slices.Equal(p, pinned) {
						pinned = p
						render()
					}
				case <-open.ClickedCh:
					if o.Open != nil {
						o.Open()
					}
				case <-problems.ClickedCh:
					if x.OpenRoute != nil {
						x.OpenRoute("#/health")
					} else if o.Open != nil {
						o.Open()
					}
				case <-login.ClickedCh:
					if o.SetAutostart == nil {
						continue
					}
					want := !login.Checked()
					if err := o.SetAutostart(want); err != nil {
						if o.ReportFailure != nil {
							o.ReportFailure(err)
						}
						continue
					}
					if want {
						login.Check()
					} else {
						login.Uncheck()
					}
				case <-quit.ClickedCh:
					if o.Quit != nil {
						o.Quit()
					}
					systray.Quit()
					return
				}
			}
		}()
	}
	systray.Run(onReady, func() {})
}

// favoritesMenu is the pinned apps part of the menu: a fixed set of slots,
// shown and retitled as the pins and their states change (the tray cannot
// insert items in the middle of a menu).
type favoritesMenu struct {
	ctx      context.Context
	x        Extras
	report   func(error)
	header   *systray.MenuItem
	empty    *systray.MenuItem
	slots    []*favSlot
	more     *systray.MenuItem
	startAll *systray.MenuItem

	mu   sync.Mutex
	menu Menu
}

type favSlot struct {
	item, open, toggle, restart, details *systray.MenuItem

	mu    sync.Mutex
	fav   Favorite
	shown *Favorite // what the items show now, nil when hidden
}

func newFavoritesMenu(ctx context.Context, x Extras, report func(error)) *favoritesMenu {
	f := &favoritesMenu{ctx: ctx, x: x, report: report}
	f.header = systray.AddMenuItem("Pinned apps", "")
	f.header.Disable()
	f.empty = systray.AddMenuItem("Pin apps in Portplane to see them here", "")
	f.empty.Disable()
	for range MaxFavorites {
		s := &favSlot{item: systray.AddMenuItem("", "")}
		s.open = s.item.AddSubMenuItem("Open in browser", "Open the app's address")
		s.toggle = s.item.AddSubMenuItem("Start", "")
		s.restart = s.item.AddSubMenuItem("Restart", "Stop the app and start it again")
		s.details = s.item.AddSubMenuItem("Show details", "Open the app in Portplane")
		s.item.Hide()
		f.slots = append(f.slots, s)
		go f.listen(s)
	}
	f.more = systray.AddMenuItem("", "See every pinned app in Portplane")
	f.more.Hide()
	f.startAll = systray.AddMenuItem("Start everything pinned", "Start the pinned apps that are stopped")
	f.startAll.Hide()
	go f.listenAll()
	return f
}

func (f *favoritesMenu) update(m Menu) {
	f.mu.Lock()
	f.menu = m
	f.mu.Unlock()
	if len(m.Favorites) == 0 {
		f.header.Hide()
		f.empty.Show()
		f.startAll.Hide()
	} else {
		f.empty.Hide()
		f.header.Show()
		f.startAll.Show()
		if m.CanStartPinned {
			f.startAll.Enable()
		} else {
			f.startAll.Disable()
		}
	}
	if m.More > 0 {
		f.more.SetTitle(strconv.Itoa(m.More) + " more in Portplane…")
		f.more.Show()
	} else {
		f.more.Hide()
	}
	for i, s := range f.slots {
		if i < len(m.Favorites) {
			s.show(m.Favorites[i])
		} else {
			s.hide()
		}
	}
}

func (s *favSlot) show(fav Favorite) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fav = fav
	if s.shown != nil && s.shown.Title == fav.Title && s.shown.Alive == fav.Alive && s.shown.CanAct == fav.CanAct && s.shown.URL == fav.URL {
		return
	}
	s.item.SetTitle(fav.Title)
	if fav.URL != "" {
		s.open.Show()
	} else {
		s.open.Hide()
	}
	if fav.Alive {
		s.toggle.SetTitle("Stop")
		s.toggle.SetTooltip("Stop " + fav.App.Label)
	} else {
		s.toggle.SetTitle("Start")
		s.toggle.SetTooltip("Start " + fav.App.Label)
	}
	if fav.CanAct {
		s.toggle.Enable()
	} else {
		s.toggle.Disable()
	}
	if fav.Alive && fav.CanAct {
		s.restart.Show()
	} else {
		s.restart.Hide()
	}
	s.item.Show()
	shown := fav
	s.shown = &shown
}

func (s *favSlot) hide() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shown != nil {
		s.item.Hide()
		s.shown = nil
	}
}

func (s *favSlot) current() (Favorite, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fav, s.shown != nil
}

func (f *favoritesMenu) listen(s *favSlot) {
	for {
		var act func(Favorite)
		select {
		case <-f.ctx.Done():
			return
		case <-s.open.ClickedCh:
			act = func(fav Favorite) {
				if fav.URL != "" && f.x.OpenURL != nil {
					f.fail(f.x.OpenURL(fav.URL))
				}
			}
		case <-s.toggle.ClickedCh:
			act = func(fav Favorite) {
				verb := model.VerbStart
				if fav.Alive {
					verb = model.VerbStop
				}
				f.act(fav, verb)
			}
		case <-s.restart.ClickedCh:
			act = func(fav Favorite) { f.act(fav, model.VerbRestart) }
		case <-s.details.ClickedCh:
			act = func(fav Favorite) {
				if f.x.OpenRoute != nil {
					f.x.OpenRoute(window.AppRoute(fav.Machine, fav.App.ID))
				}
			}
		}
		if fav, ok := s.current(); ok {
			go act(fav)
		}
	}
}

func (f *favoritesMenu) listenAll() {
	for {
		select {
		case <-f.ctx.Done():
			return
		case <-f.startAll.ClickedCh:
			f.mu.Lock()
			favs := slices.Clone(f.menu.Favorites)
			f.mu.Unlock()
			for _, fav := range favs {
				if fav.CanAct && !fav.Alive {
					go f.act(fav, model.VerbStart)
				}
			}
		}
	}
}

func (f *favoritesMenu) act(fav Favorite, verb model.Verb) {
	if f.x.Act == nil || !fav.CanAct {
		return
	}
	ctx, cancel := context.WithTimeout(f.ctx, 30*time.Second)
	defer cancel()
	f.fail(f.x.Act(ctx, fav.Machine, fav.App, verb))
}

func (f *favoritesMenu) fail(err error) {
	if err != nil && f.report != nil {
		f.report(err)
	}
}
