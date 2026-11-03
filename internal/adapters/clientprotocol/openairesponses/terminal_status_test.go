package openairesponses

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

func TestTerminalStatusForCancelledIsIncomplete(t *testing.T) {
	status, reason := terminalStatusFor(inference.StopReasonCancelled)
	if status != statusIncomplete || reason != "cancelled" {
		t.Fatalf("terminalStatusFor(cancelled) = (%q, %q), want (%q, %q)", status, reason, statusIncomplete, "cancelled")
	}
}
