package hub

import (
	"context"

	"github.com/akamachinecode/portplane/internal/model"
)

// Output completes agent.Agent for chanAgent; the hub only hands agents out.
func (a *chanAgent) Output(context.Context, string, string) (model.Output, error) {
	return model.Output{}, nil
}
