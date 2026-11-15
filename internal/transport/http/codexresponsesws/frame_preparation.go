package codexresponsesws

import (
	"github.com/madou1217/ai_home/application/effortalign"
	"github.com/madou1217/ai_home/core/inference"
)

// prepareBoundClientFrame applies model/effort policy on every turn without
// clearing connection-local continuity. Foreign-account reasoning is handled
// separately by the session's existing account-change guard.
func (handler *Handler) prepareBoundClientFrame(payload []byte, model string, effectiveModel string) []byte {
	prepared := normalizeClientFrameModel(payload, model)
	if handler == nil {
		return prepared
	}
	return effortalign.AlignResponsesPayload(prepared, inference.ProviderCodex, effectiveModel, handler.ladders)
}
