package tray

import (
	"testing"

	"github.com/akamachinecode/portplane/internal/model"
)

func TestCount(t *testing.T) {
	s := model.Snapshot{Machines: []model.MachineSnapshot{
		{Apps: []model.App{{State: model.StateOn}, {State: model.StateFailed}, {State: model.StateStarting, Kind: "job"}}},
		{Apps: []model.App{{State: model.StateOn}, {State: model.StateStarting}}},
	}}
	c := Count(s)
	if c != (Counts{Running: 2, Starting: 1, Failed: 1}) || c.Summary() != "2 running · 1 starting · 1 failed" {
		t.Fatalf("%+v %q", c, c.Summary())
	}
	if itoa(42) != "42" || itoa(7) != "7" {
		t.Fatal("itoa")
	}
}
