// Package model holds the values agents report and the UI shows. Every type
// here is plain data and JSON-serialisable, so a remote agent can send it over
// the wire unchanged (ADR-0005).
package model

import "time"

// State is what the user sees for an app.
type State string

const (
	StateOn       State = "on"       // alive, and its port is listening (or it has no known port)
	StateStarting State = "starting" // alive, port not listening yet, or waiting for a dependency
	StateStopping State = "stopping"
	StateFailed   State = "failed" // exited with an error, crashed, or not ready in time
	StateOff      State = "off"
	StateDone     State = "done" // a job that finished successfully
	StateUnknown  State = "unknown"
)

// Alive reports whether the app's process is running.
func (s State) Alive() bool {
	return s == StateOn || s == StateStarting || s == StateStopping
}

// Verb is an action on an app or a project.
type Verb string

const (
	VerbStart   Verb = "start"
	VerbStop    Verb = "stop"
	VerbRestart Verb = "restart"
	// VerbKill stops at once with a hard kill, for an app that does not
	// answer Stop.
	VerbKill Verb = "kill"
	// VerbVeto stops and keeps it stopped, even when another app needs it,
	// until it is started again (start lifts the veto: dekit has no unveto).
	VerbVeto Verb = "veto"
	// VerbForceRestart kills and starts again; a stopped app just starts.
	VerbForceRestart Verb = "force-restart"
	// VerbRemove removes a task: only one spawned at run time (dynamic) or
	// one in Portplane's own fragment, which loses its entry there.
	VerbRemove Verb = "rm"
)

// Valid reports whether v is a known verb.
func (v Verb) Valid() bool {
	switch v {
	case VerbStart, VerbStop, VerbRestart, VerbKill, VerbVeto, VerbForceRestart, VerbRemove:
		return true
	}
	return false
}

// Target names what an action applies to on one machine: one task, or every
// task under a path prefix (a project or worktree) in one runner.
type Target struct {
	Machine string   `json:"machine"`
	Runner  string   `json:"runner"`           // dekit project root on that machine
	Task    string   `json:"task,omitempty"`   // exact task path
	Prefix  string   `json:"prefix,omitempty"` // every task under this folder ("shop/")
	Tasks   []string `json:"tasks,omitempty"`  // several exact paths, when they share no folder
}

// App is one dekit task.
type App struct {
	ID        string   `json:"id"` // stable within a machine: runner root + "#" + task path
	Runner    string   `json:"runner"`
	Task      string   `json:"task"`
	Label     string   `json:"label"`
	Kind      string   `json:"kind"` // service or job
	Project   string   `json:"project"`
	Worktree  string   `json:"worktree,omitempty"` // empty for the main checkout
	Dir       string   `json:"dir,omitempty"`
	Command   []string `json:"command,omitempty"`
	Deps      []string `json:"deps,omitempty"`
	State     State    `json:"state"`
	RawState  string   `json:"rawState,omitempty"` // dekit's own state word
	Detail    string   `json:"detail,omitempty"`   // e.g. "exit code 1", "waiting for install"
	URL       string   `json:"url,omitempty"`
	Hostname  string   `json:"hostname,omitempty"` // portless hostname, known even while off
	Port      int      `json:"port,omitempty"`     // internal port, while running
	Ports     []int    `json:"ports,omitempty"`    // every listening port of its process tree
	PID       int      `json:"pid,omitempty"`
	Order     int      `json:"order"`               // position in the config
	RemoteURL string   `json:"remoteUrl,omitempty"` // set by the hub for apps on other machines
	// Dynamic: added at run time (dekit spawn), not in any config file.
	Dynamic bool `json:"dynamic,omitempty"`
	// Portplane: declared in Portplane's own fragment (.portplane/tasks.yaml).
	Portplane bool `json:"portplane,omitempty"`
}

// Port is a listening TCP port that no known app owns.
type Port struct {
	Port     int    `json:"port"`
	Address  string `json:"address"`
	PID      int    `json:"pid,omitempty"`
	Process  string `json:"process,omitempty"`
	Dir      string `json:"dir,omitempty"`
	Project  string `json:"project,omitempty"` // git repository name of Dir, if any
	InFolder bool   `json:"inFolder"`          // Dir is inside one of the watched folders
	URL      string `json:"url,omitempty"`
	Route    string `json:"route,omitempty"` // portless hostname pointing at it, if any
}

// Runner is one dekit project (a folder with dekit.yaml).
type Runner struct {
	Root  string `json:"root"`
	Name  string `json:"name"`
	Up    bool   `json:"up"`
	Error string `json:"error,omitempty"`
}

// Tools describes what is installed on a machine.
type Tools struct {
	Dekit        string `json:"dekit,omitempty"`    // version, empty when missing
	Portless     string `json:"portless,omitempty"` // version, empty when missing
	ProxyRunning bool   `json:"proxyRunning"`
	ProxyHTTPS   bool   `json:"proxyHttps"`
	ProxyPort    int    `json:"proxyPort,omitempty"`
}

// Machine identifies the machine an agent runs on.
type Machine struct {
	ID       string `json:"id"`   // "local", or the SSH host alias
	Name     string `json:"name"` // display name
	Local    bool   `json:"local"`
	Hostname string `json:"hostname,omitempty"`
	OS       string `json:"os,omitempty"`
	Arch     string `json:"arch,omitempty"`
	Status   string `json:"status"` // online, connecting, offline
	Error    string `json:"error,omitempty"`
	Agent    string `json:"agent,omitempty"` // agent version
}

// MachineSnapshot is everything one agent reports.
type MachineSnapshot struct {
	Machine    Machine   `json:"machine"`
	Tools      Tools     `json:"tools"`
	Folders    []string  `json:"folders"`
	Runners    []Runner  `json:"runners"`
	Apps       []App     `json:"apps"`
	OtherPorts []Port    `json:"otherPorts"`
	Projects   []Project `json:"projects"` // Apps grouped for display
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Snapshot is the hub's merged view of every machine.
type Snapshot struct {
	Machines []MachineSnapshot `json:"machines"`
	Version  uint64            `json:"version"` // increases on every change
}

// Project groups the apps of one project, by worktree.
type Project struct {
	Name      string     `json:"name"`
	Runner    string     `json:"runner"`
	Prefix    string     `json:"prefix,omitempty"` // shared task path prefix, for project-wide actions
	Running   int        `json:"running"`          // services alive
	Total     int        `json:"total"`            // services (jobs are steps, not counted)
	Worktrees []Worktree `json:"worktrees"`
}

// Worktree groups the apps of one checkout.
type Worktree struct {
	Name    string   `json:"name"` // empty for the main checkout
	Prefix  string   `json:"prefix,omitempty"`
	Running int      `json:"running"`
	Apps    []string `json:"apps"` // App IDs, in config order
}

// Excerpt is the end of a task's terminal, shown when it fails (ADR-0011).
type Excerpt struct {
	Lines   []string `json:"lines"`
	Command string   `json:"command"` // shows the full screen in a terminal
}

// Output is a task's whole terminal screen, for the Output panel (ADR-0021).
type Output struct {
	// Screen is what the task's terminal shows now, rows joined by "\n".
	// Colour and style codes (ANSI SGR sequences) are kept; every other
	// control sequence is removed, and trailing blank rows are dropped.
	Screen string `json:"screen"`
	// Truncated means the start was cut to keep the answer small.
	Truncated bool `json:"truncated,omitempty"`
	// RunnerDown means the project's runner is not running, so no task has a
	// screen to show (`dekit up` starts it).
	RunnerDown bool `json:"runnerDown,omitempty"`
	// Command attaches a terminal to the task: dekit -C <root> attach <task>.
	Command string `json:"command"`
}
