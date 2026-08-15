package deletionprojection

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/claude/securestorage"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
)

const maxCredentialArtifactBytes int64 = 1024 * 1024

func (preparer *Preparer) reconcileCredential(
	ctx context.Context,
	account accountcore.Account,
	roots []projectionRoot,
) error {
	snapshot, err := preparer.credentials.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		return err
	}
	if !snapshot.IsValid() ||
		snapshot.AccountRef() != account.Ref() ||
		snapshot.ProviderID() != account.ProviderID() {
		return fmt.Errorf("凭据快照与账号不一致")
	}

	switch account.ProviderID() {
	case providerCodex:
		return preparer.reconcileCodexCredential(ctx, snapshot, roots)
	case providerClaude:
		return preparer.reconcileClaudeCredential(snapshot, roots)
	default:
		return fmt.Errorf("Provider 凭据收敛策略不存在")
	}
}

func (preparer *Preparer) reconcileCodexCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
	roots []projectionRoot,
) error {
	current, valid := snapshot.Credential().(codex.Auth)
	if !valid || current == nil {
		return fmt.Errorf("当前 Codex 凭据类型无效")
	}
	candidates := make([]codex.Auth, 0, len(roots))
	for _, root := range roots {
		relativePath := []string{".codex", "auth.json"}
		if root.kind == projectionKindCodexDesktop {
			relativePath = []string{"auth.json"}
		}
		document, found, err := readBoundedRegularFile(root.path, relativePath)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		candidate, err := authfile.Decode(document, authfile.DecodeOptions{
			APIKeyBaseURL: codexAPIKeyBaseURL(current),
		})
		if err != nil {
			return err
		}
		candidates = append(candidates, candidate)
	}
	if len(candidates) == 0 {
		return nil
	}

	switch currentAuth := current.(type) {
	case *codex.OAuthAuth:
		selected, changed, err := selectNewestCodexOAuth(
			snapshot.AccountRef(),
			currentAuth,
			candidates,
		)
		if err != nil || !changed {
			return err
		}
		return preparer.replaceCredential(ctx, snapshot, selected)
	case *codex.APIKeyAuth:
		for _, candidate := range candidates {
			apiKey, ok := candidate.(*codex.APIKeyAuth)
			if !ok || apiKey == nil || apiKey.APIKey() != currentAuth.APIKey() {
				return fmt.Errorf("Codex API Key 投影与数据库不一致")
			}
		}
		return nil
	default:
		return fmt.Errorf("Codex 凭据类型不受支持")
	}
}

func (preparer *Preparer) reconcileClaudeCredential(
	snapshot accountapp.CredentialSnapshot,
	roots []projectionRoot,
) error {
	current, valid := snapshot.Credential().(*claude.OAuthAuth)
	if !valid || current == nil {
		for _, root := range roots {
			_, found, err := readBoundedRegularFile(
				root.path,
				[]string{".claude", ".credentials.json"},
			)
			if err != nil {
				return err
			}
			if found {
				return fmt.Errorf("Claude 非 refreshable 账号存在 OAuth 投影")
			}
		}
		return nil
	}

	for _, root := range roots {
		document, found, err := readBoundedRegularFile(
			root.path,
			[]string{".claude", ".credentials.json"},
		)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		decoded, err := securestorage.Decode(document, securestorage.DecodeOptions{
			Identity: current.Identity(),
		})
		if err != nil {
			return err
		}
		// Claude secure storage 不携带稳定账号 UUID。只有逐字段完全相同时，
		// 才能证明该投影仍属于当前账号；Token 变化必须先由运行时安全捕获。
		if !sameClaudeOAuth(current, decoded.Auth) {
			return fmt.Errorf("Claude 投影 Token 缺少可验证的稳定身份")
		}
	}
	return nil
}

func selectNewestCodexOAuth(
	accountRef accountcore.AccountRef,
	current *codex.OAuthAuth,
	candidates []codex.Auth,
) (*codex.OAuthAuth, bool, error) {
	selected := current
	for _, candidate := range candidates {
		oauth, valid := candidate.(*codex.OAuthAuth)
		if !valid || oauth == nil {
			return nil, false, fmt.Errorf("Codex OAuth 投影凭据类型不一致")
		}
		candidateRef, err := accountcore.DeriveAccountRef(oauth)
		if err != nil || candidateRef != accountRef || oauth.IdentitySeed() != current.IdentitySeed() {
			return nil, false, fmt.Errorf("Codex OAuth 投影身份不一致")
		}
		if sameCodexOAuthMaterial(oauth, selected) {
			if oauth.RefreshedAtMS() > selected.RefreshedAtMS() {
				selected = oauth
			}
			continue
		}
		candidateTime := oauth.RefreshedAtMS()
		selectedTime := selected.RefreshedAtMS()
		if candidateTime <= 0 || selectedTime <= 0 {
			return nil, false, fmt.Errorf("Codex OAuth 投影刷新时间不足")
		}
		switch {
		case candidateTime > selectedTime:
			selected = oauth
		case candidateTime == selectedTime:
			return nil, false, fmt.Errorf("Codex OAuth 投影刷新版本冲突")
		}
	}
	return selected, !sameCodexOAuth(current, selected), nil
}

func (preparer *Preparer) replaceCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
	credential accountapp.Credential,
) error {
	now := time.UnixMilli(preparer.clock().UTC().UnixMilli()).UTC()
	if now.IsZero() || now.UnixMilli() <= 0 || now.Year() > 9999 {
		return fmt.Errorf("凭据版本时钟无效")
	}
	if !now.After(snapshot.UpdatedAt()) {
		now = snapshot.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(snapshot, credential, now)
	if err != nil {
		return err
	}
	return preparer.credentials.ReplaceCredential(ctx, replacement)
}

func readBoundedRegularFile(root string, segments []string) ([]byte, bool, error) {
	if err := assertPlainDirectory(root); err != nil {
		return nil, false, err
	}
	current := root
	for index, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || filepath.Base(segment) != segment {
			return nil, false, ErrInvalidRequest
		}
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, false, fmt.Errorf("凭据 artifact 路径包含 symlink")
		}
		if index < len(segments)-1 && !info.IsDir() {
			return nil, false, fmt.Errorf("凭据 artifact 父级不是目录")
		}
		if index == len(segments)-1 && !info.Mode().IsRegular() {
			return nil, false, fmt.Errorf("凭据 artifact 不是普通文件")
		}
	}
	file, err := os.Open(current)
	if err != nil {
		return nil, false, err
	}
	defer func() {
		_ = file.Close()
	}()
	document, err := io.ReadAll(io.LimitReader(file, maxCredentialArtifactBytes+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(document)) == 0 || int64(len(document)) > maxCredentialArtifactBytes {
		return nil, false, fmt.Errorf("凭据 artifact 大小无效")
	}
	return document, true, nil
}

func codexAPIKeyBaseURL(auth codex.Auth) string {
	if apiKey, valid := auth.(*codex.APIKeyAuth); valid && apiKey != nil {
		return apiKey.BaseURL()
	}
	return ""
}

func sameCodexOAuth(left *codex.OAuthAuth, right *codex.OAuthAuth) bool {
	return sameCodexOAuthMaterial(left, right) &&
		left.RefreshedAtMS() == right.RefreshedAtMS()
}

func sameCodexOAuthMaterial(left *codex.OAuthAuth, right *codex.OAuthAuth) bool {
	return left != nil && right != nil &&
		left.AccessToken() == right.AccessToken() &&
		left.RefreshToken() == right.RefreshToken() &&
		left.IDToken() == right.IDToken() &&
		left.UpstreamAccountID() == right.UpstreamAccountID()
}

func sameClaudeOAuth(left *claude.OAuthAuth, right *claude.OAuthAuth) bool {
	return left != nil && right != nil &&
		left.AccountUUID() == right.AccountUUID() &&
		left.AccessToken() == right.AccessToken() &&
		left.RefreshToken() == right.RefreshToken() &&
		left.ExpiresAtMS() == right.ExpiresAtMS() &&
		left.RefreshTokenExpiresAtMS() == right.RefreshTokenExpiresAtMS() &&
		left.ClientID() == right.ClientID() &&
		slices.Equal(left.Scopes(), right.Scopes())
}
