package aihserver

import (
	"context"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	agyprojection "github.com/madou1217/ai_home/internal/adapters/agy/projection"
)

// providerDefaultReader 读取 Provider 的默认账号；错误表示没有默认账号。
type providerDefaultReader interface {
	GetProviderDefault(
		ctx context.Context,
		providerID string,
	) (accountcore.ProviderDefault, error)
}

// syncDefaultAgyAuthToHost 把默认 agy 账号的凭据写入真实 HOME 的全局 CLI 路径。
//
// Node 的 host-sync 只在账号是 provider 默认账号时同步（lib/account/host-sync.js:500），
// 因为 aih 之外的 agy CLI/桌面端读的是 ~/.gemini/antigravity-cli。非默认账号、
// 没有默认配置或读取失败都视为无需同步。
func syncDefaultAgyAuthToHost(
	ctx context.Context,
	store providerDefaultReader,
	hostHomeDir string,
	accountRef accountcore.AccountRef,
	auth *agy.OAuthAuth,
) error {
	if ctx == nil || store == nil || auth == nil ||
		!accountRef.IsValid() || strings.TrimSpace(hostHomeDir) == "" {
		return nil
	}
	current, err := store.GetProviderDefault(ctx, agy.ProviderID)
	if err != nil || current.AccountRef() != accountRef {
		return nil
	}
	return agyprojection.WriteGlobalAuth(hostHomeDir, auth)
}
