package remote

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/akamachinecode/portplane/internal/hub"
	"github.com/akamachinecode/portplane/internal/model"
	"github.com/akamachinecode/portplane/internal/settings"
)

// Manager keeps the hub's remote machines in line with the settings.
type Manager struct {
	Hub      *hub.Hub
	Store    *settings.Store
	Forward  *Forwarder
	Binaries func(ctx context.Context, goos, goarch string) (string, error)
	// NewSSH builds the connector for a host (replaceable in tests).
	NewSSH func(host string) *SSH

	mu     sync.Mutex
	agents map[string]*Agent
}

// MachineInfo is a configured machine.
type MachineInfo struct {
	settings.Machine
}

func (m *Manager) ssh(host string) *SSH {
	if m.NewSSH != nil {
		return m.NewSSH(host)
	}
	return &SSH{Host: host, Binaries: m.Binaries}
}

// Start connects every machine in the settings.
func (m *Manager) Start() error {
	st, err := m.Store.Load()
	if err != nil {
		return err
	}
	for _, mc := range st.Machines {
		m.attach(mc, m.ssh(mc.Host))
	}
	return nil
}

func (m *Manager) attach(mc settings.Machine, conn Connector) {
	a := NewAgent(mc.ID, mc.Name, mc.Folders, conn)
	m.mu.Lock()
	if m.agents == nil {
		m.agents = map[string]*Agent{}
	}
	m.agents[mc.ID] = a
	m.mu.Unlock()
	m.Hub.Add(mc.ID, m.Forward.Wrap(a, mc.ID), model.Machine{ID: mc.ID, Name: mc.Name, Status: "connecting"})
}

// Add tests the connection (installing the agent), then saves the machine
// and starts following it.
func (m *Manager) Add(ctx context.Context, host, name string, folders []string) (settings.Machine, error) {
	host = strings.TrimSpace(host)
	if host == "" || strings.HasPrefix(host, "-") || strings.ContainsAny(host, " \t\n'\"`$;|&") {
		return settings.Machine{}, errors.New("enter an SSH host, such as an alias from ~/.ssh/config or user@host")
	}
	if name = strings.TrimSpace(name); name == "" {
		name = host
		if i := strings.IndexByte(name, '@'); i >= 0 {
			name = name[i+1:]
		}
		if i := strings.IndexByte(name, '.'); i > 0 {
			name = name[:i]
		}
	}
	conn := m.ssh(host)
	if _, err := conn.Install(ctx); err != nil {
		return settings.Machine{}, err
	}
	var mc settings.Machine
	_, err := m.Store.Update(func(st *settings.Settings) error {
		for _, x := range st.Machines {
			if x.Host == host {
				return fmt.Errorf("%s is already added as %s", host, x.Name)
			}
		}
		id := Label(name)
		taken := map[string]bool{"local": true}
		for _, x := range st.Machines {
			taken[x.ID] = true
		}
		for i := 2; taken[id]; i++ {
			id = Label(name) + "-" + strconv.Itoa(i)
		}
		mc = settings.Machine{ID: id, Name: name, Host: host, Folders: cleanList(folders)}
		st.Machines = append(st.Machines, mc)
		return nil
	})
	if err != nil {
		return settings.Machine{}, err
	}
	m.attach(mc, conn)
	return mc, nil
}

// Update changes a machine's name or folders.
func (m *Manager) Update(ctx context.Context, id, name string, folders []string) (settings.Machine, error) {
	var mc settings.Machine
	found := false
	_, err := m.Store.Update(func(st *settings.Settings) error {
		for i := range st.Machines {
			if st.Machines[i].ID != id {
				continue
			}
			if strings.TrimSpace(name) != "" {
				st.Machines[i].Name = strings.TrimSpace(name)
			}
			if folders != nil {
				st.Machines[i].Folders = cleanList(folders)
			}
			mc, found = st.Machines[i], true
		}
		if !found {
			return fmt.Errorf("unknown machine %q", id)
		}
		return nil
	})
	if err != nil {
		return mc, err
	}
	m.mu.Lock()
	a := m.agents[id]
	m.mu.Unlock()
	if a != nil {
		a.SetName(mc.Name)
		if err := a.SetFolders(ctx, mc.Folders); err != nil {
			return mc, err
		}
	}
	return mc, nil
}

// Remove forgets a machine.
func (m *Manager) Remove(id string) error {
	found := false
	_, err := m.Store.Update(func(st *settings.Settings) error {
		out := st.Machines[:0]
		for _, x := range st.Machines {
			if x.ID == id {
				found = true
				continue
			}
			out = append(out, x)
		}
		st.Machines = out
		if !found {
			return fmt.Errorf("unknown machine %q", id)
		}
		return nil
	})
	if err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.agents, id)
	m.mu.Unlock()
	m.Hub.Remove(id)
	return nil
}

// List returns the configured machines.
func (m *Manager) List() ([]settings.Machine, error) {
	st, err := m.Store.Load()
	if err != nil {
		return nil, err
	}
	if st.Machines == nil {
		return []settings.Machine{}, nil
	}
	return st.Machines, nil
}

// OpenPort returns a local URL for any port on a remote machine.
func (m *Manager) OpenPort(ctx context.Context, id string, port int) (string, error) {
	a, err := m.Hub.Agent(id)
	if err != nil {
		return "", err
	}
	op, ok := a.(interface {
		OpenPort(ctx context.Context, port int) (string, error)
	})
	if !ok {
		return "", errors.New("not a remote machine")
	}
	return op.OpenPort(ctx, port)
}

func cleanList(in []string) []string {
	out := []string{}
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
