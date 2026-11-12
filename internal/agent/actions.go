package agent

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/akamachinecode/portplane/internal/dekit"
	"github.com/akamachinecode/portplane/internal/model"
)

// forceRestarter is the part of the dekit CLI that restarts with a hard
// kill; a Runner without it kills and starts in two calls.
type forceRestarter interface {
	ForceRestart(ctx context.Context, root, task string) error
}

func (l *Local) forceRestart(ctx context.Context, root, task string) error {
	if fr, ok := l.dekit.(forceRestarter); ok {
		return fr.ForceRestart(ctx, root, task)
	}
	if err := l.dekit.Act(ctx, root, string(model.VerbKill), task); err != nil {
		return err
	}
	return l.dekit.Act(ctx, root, string(model.VerbStart), task)
}

// remove takes a task away (plan §4.2): one spawned at run time leaves the
// runner; one in Portplane's fragment also loses its entry there, so it
// does not come back at the next load. Tasks the user wrote stay: their
// file is theirs to change.
func (l *Local) remove(ctx context.Context, a model.App) error {
	switch {
	case a.Dynamic:
	case a.Portplane:
		cfg, err := l.configs.load(a.Runner)
		if err != nil {
			return err
		}
		t := cfg.Task(a.Task)
		if t == nil {
			return fmt.Errorf("%s is not in Portplane's tasks any more", a.Task)
		}
		src, err := os.ReadFile(t.File)
		if err != nil {
			return err
		}
		out, err := dekit.DeleteEntry(src, []string{"tasks", t.Key})
		if err != nil {
			return fmt.Errorf("removing %s from %s: %w", a.Task, t.File, err)
		}
		if err := dekit.WriteFileAtomic(t.File, out); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%s is in your dekit.yaml: remove it there (Portplane only removes the tasks it added or ones started with Run a command)", a.Label)
	}
	err := l.dekit.Act(ctx, a.Runner, string(model.VerbRemove), a.Task)
	if errors.Is(err, dekit.ErrRunnerDown) {
		err = nil // nothing runs; the file no longer has it
	}
	l.refreshSoon()
	return err
}
