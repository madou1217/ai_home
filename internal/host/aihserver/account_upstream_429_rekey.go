package aihserver

import (
	"context"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	runtimeupstreamretry "github.com/madou1217/ai_home/internal/runtime/upstreamretry"
)

// moveAccountUpstream429Override migrates an account's 429 retry override key
// when identity re-keying assigns a new AccountRef.
func moveAccountUpstream429Override(
	store *runtimeupstreamretry.Store,
	previous accountcore.AccountRef,
	current accountcore.AccountRef,
) error {
	if store == nil || !previous.IsValid() || !current.IsValid() || previous == current {
		return nil
	}
	return store.RekeyAccountOverride(context.Background(), previous.String(), current.String())
}
