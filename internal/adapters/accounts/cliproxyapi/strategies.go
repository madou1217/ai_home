package cliproxyapi

import (
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	codexType  = "codex"
	claudeType = "claude"
)

// codexStrategy 只编码 CLIProxyAPI auth-dir 原生支持的 Codex OAuth。
type codexStrategy struct{}

// encode 保留 CPA 执行和刷新 Codex 请求所需的完整官方字段。
func (codexStrategy) encode(
	snapshot accountapp.ExportSnapshot,
) (any, error) {
	auth, supported := snapshot.Credential().(*codex.OAuthAuth)
	if !supported {
		return nil, accountapp.ErrUnsupportedAccountExport
	}
	return codexAuthFile{
		IDToken:      auth.IDToken(),
		AccessToken:  auth.AccessToken(),
		RefreshToken: auth.RefreshToken(),
		AccountID:    auth.UpstreamAccountID(),
		LastRefresh:  formatUnixMillis(auth.RefreshedAtMS()),
		Email:        auth.Email(),
		Type:         codexType,
		Expired:      formatUnixMillis(auth.AccessExpiresAtMS()),
		Disabled:     !snapshot.Account().Enabled(),
	}, nil
}

// claudeStrategy 只编码 CLIProxyAPI auth-dir 原生支持的可刷新 Claude OAuth。
type claudeStrategy struct{}

// encode 只输出 CPA 官方文件定义的账号、组织字段，不附加 scope 或 AIH 本地身份。
func (claudeStrategy) encode(
	snapshot accountapp.ExportSnapshot,
) (any, error) {
	auth, supported := snapshot.Credential().(*claude.OAuthAuth)
	if !supported {
		return nil, accountapp.ErrUnsupportedAccountExport
	}
	profile := claudeProfile(snapshot)
	return claudeAuthFile{
		AccessToken:      auth.AccessToken(),
		RefreshToken:     auth.RefreshToken(),
		Email:            profile.Email(),
		AccountUUID:      auth.AccountUUID(),
		OrganizationUUID: profile.OrganizationUUID(),
		OrganizationName: profile.OrganizationName(),
		Type:             claudeType,
		Expired:          formatUnixMillis(auth.ExpiresAtMS()),
		Disabled:         !snapshot.Account().Enabled(),
	}, nil
}

// claudeProfile 从可选公开资料读取 CPA 最新 auth-file 支持的公开身份。
func claudeProfile(snapshot accountapp.ExportSnapshot) claude.OAuthProfile {
	profile, found := snapshot.Profile()
	if !found {
		return claude.OAuthProfile{}
	}
	claudeProfile, valid := profile.(claude.AccountProfile)
	if !valid {
		return claude.OAuthProfile{}
	}
	return claudeProfile.OAuthProfile()
}

// formatUnixMillis 把领域毫秒时间转换为 CPA 使用的 RFC3339；零表示未知。
func formatUnixMillis(value int64) string {
	if value <= 0 {
		return ""
	}
	return time.UnixMilli(value).UTC().Format(time.RFC3339)
}
