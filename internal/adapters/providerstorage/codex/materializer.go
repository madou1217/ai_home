package codexstorage

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
)

var (
	// ErrUnsupportedCredential 表示 P3 只投影 Codex OAuth；API Key 继续走启动参数路径。
	ErrUnsupportedCredential = errors.New("codex projection requires oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("codex projection identity mismatch")
)

// Materializer 把 Codex OAuth 领域凭据编码成官方 auth.json，并读取客户端续期后的文件。
type Materializer struct{}

// ProviderID 返回 Codex 规范 Provider ID。
func (Materializer) ProviderID() string { return "codex" }

// Materialize 只编码，不落盘；Provisioner 负责权限和原子替换。
func (Materializer) Materialize(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if request.ProviderID != "codex" || root == "" {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	auth, ok := request.Credential.(*codex.OAuthAuth)
	if !ok || auth == nil {
		return nil, ErrUnsupportedCredential
	}
	path := filepath.Join(root, ".codex", "auth.json")
	// Codex 会原地续期 auth.json。磁盘那份比账号快照新，说明上一次 Capture 没跑成
	// （进程被强杀、回写失败）：这时绝不能用旧快照覆盖，否则轮换过的 refresh_token
	// 直接失效。保持磁盘内容，退出后由 Capture 追平账号库。
	if existing, found := readOAuthFile(path); found {
		if sameOAuth(auth, existing) || shouldAdoptOAuth(auth, existing) {
			return nil, nil
		}
	}
	data, err := authfile.Encode(auth)
	if err != nil {
		return nil, err
	}
	return []accountprojection.ArtifactWrite{{
		Path: path,
		Data: data,
		Mode: 0o600,
	}}, nil
}

// readOAuthFile 读取投影里的 auth.json；文件缺失、损坏或不是 OAuth 时按“不可用”
// 处理，由 Materialize 用账号快照重建（重建比阻断启动更安全）。
func readOAuthFile(path string) (*codex.OAuthAuth, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	decoded, err := authfile.Decode(data, authfile.DecodeOptions{})
	if err != nil {
		return nil, false
	}
	auth, ok := decoded.(*codex.OAuthAuth)
	if !ok || auth == nil {
		return nil, false
	}
	return auth, true
}

// Capture 读取投影里的 auth.json；缺失视为没有变化，格式/身份错误返回错误。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != "codex" || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	path := filepath.Join(root, ".codex", "auth.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	decoded, err := authfile.Decode(data, authfile.DecodeOptions{})
	if err != nil {
		return nil, false, err
	}
	next, ok := decoded.(*codex.OAuthAuth)
	if !ok || next == nil {
		return nil, false, ErrUnsupportedCredential
	}
	if current, ok := request.Credential.(*codex.OAuthAuth); ok && current != nil {
		if current.IdentitySeed() != next.IdentitySeed() {
			return nil, false, ErrIdentityMismatch
		}
		if sameOAuth(current, next) {
			return next, false, nil
		}
	}
	return next, true, nil
}

// ShouldAdopt 只在投影文件的代际更新时回写；时间相同或更旧一律不覆盖账号库。
func (Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentAuth, currentOK := current.(*codex.OAuthAuth)
	nextAuth, nextOK := next.(*codex.OAuthAuth)
	if !currentOK || !nextOK || currentAuth == nil || nextAuth == nil {
		return false
	}
	return shouldAdoptOAuth(currentAuth, nextAuth)
}

// shouldAdoptOAuth 判断磁盘/投影的一代是否比账号库的一代更新。
func shouldAdoptOAuth(current *codex.OAuthAuth, next *codex.OAuthAuth) bool {
	if current == nil || next == nil ||
		current.IdentitySeed() != next.IdentitySeed() || sameOAuth(current, next) {
		return false
	}
	if next.RefreshedAtMS() > current.RefreshedAtMS() {
		return true
	}
	// 账号库时间未知，而客户端写出了明确刷新时刻：可以采纳。
	return current.RefreshedAtMS() == 0 && next.RefreshedAtMS() > 0
}

// sameOAuth 判断两代 OAuth 凭据是否完全一致；时间/Token/工作区任一变化都算新代。
func sameOAuth(current *codex.OAuthAuth, next *codex.OAuthAuth) bool {
	if current == nil || next == nil {
		return false
	}
	return current.AccessToken() == next.AccessToken() &&
		current.RefreshToken() == next.RefreshToken() &&
		current.IDToken() == next.IDToken() &&
		current.UpstreamAccountID() == next.UpstreamAccountID() &&
		current.RefreshedAtMS() == next.RefreshedAtMS()
}
