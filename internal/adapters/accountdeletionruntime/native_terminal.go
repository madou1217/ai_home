package accountdeletionruntime

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/nativeterminal"
)

// NativeTerminalOwner closes native-owned panes through their original owner so
// projection flush/cleanup completes before any generic tmux release is attempted.
type NativeTerminalOwner struct{ AIHomeDir string }

func (o NativeTerminalOwner) Inspect(ctx context.Context, a accountcore.Account) ([]accountapp.DeletionBlocker, error) {
	entries, err := nativeterminal.List(o.AIHomeDir)
	if err != nil {
		return nil, err
	}
	out := []accountapp.DeletionBlocker{}
	for _, entry := range entries {
		if entry.Provider == a.ProviderID() && entry.AccountRef == a.Ref().String() {
			out = append(out, accountapp.DeletionBlocker{Kind: "native_terminal", Label: "原生持久会话", Provider: a.ProviderID(), AccountRef: a.Ref().String(), Session: entry.Session, Socket: entry.Socket, Detail: entry.Label})
		}
	}
	return out, nil
}
func (o NativeTerminalOwner) Release(ctx context.Context, a accountcore.Account) error {
	_, err := nativeterminal.CloseAccount(ctx, o.AIHomeDir, a.ProviderID(), a.Ref().String())
	return err
}
func (o NativeTerminalOwner) Prepare(context.Context, accountcore.Account) error      { return nil }
func (o NativeTerminalOwner) Finish(context.Context, accountcore.Account, bool) error { return nil }
