package deletionprojection

import (
	"context"
	"encoding/json"
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
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
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

	spec, found := projectionSpecFor(account.ProviderID())
	if !found {
		return fmt.Errorf("Provider 凭据收敛策略不存在")
	}
	// 按规格里的凭据模式查表，不按 Provider 名分支：新增 Provider 只需要
	// 在规格表里声明文件和模式，这里不再打开。
	reconcile, found := credentialReconcilers[spec.credential.mode]
	if !found {
		return fmt.Errorf("Provider 凭据收敛策略不存在")
	}
	return reconcile(preparer, ctx, snapshot, roots, spec.credential)
}

// credentialReconciler 是凭据收敛模式的实现表。
type credentialReconciler func(
	*Preparer,
	context.Context,
	accountapp.CredentialSnapshot,
	[]projectionRoot,
	credentialSpec,
) error

var credentialReconcilers = map[credentialMode]credentialReconciler{
	credentialCodexOAuth:       reconcileCodexCredential,
	credentialClaudeOAuth:      reconcileClaudeCredential,
	credentialNativeGeneration: reconcileNativeCredential,
}

func reconcileCodexCredential(
	preparer *Preparer,
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
	roots []projectionRoot,
	spec credentialSpec,
) error {
	current, valid := snapshot.Credential().(codex.Auth)
	if !valid || current == nil {
		return fmt.Errorf("当前 Codex 凭据类型无效")
	}
	candidates := make([]codex.Auth, 0, len(roots))
	for _, root := range roots {
		relativePath := credentialArtifactPath(spec, root.kind)
		if len(relativePath) == 0 {
			continue
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

func reconcileClaudeCredential(
	_ *Preparer,
	_ context.Context,
	snapshot accountapp.CredentialSnapshot,
	roots []projectionRoot,
	spec credentialSpec,
) error {
	current, valid := snapshot.Credential().(*claude.OAuthAuth)
	if !valid || current == nil {
		for _, root := range roots {
			relativePath := credentialArtifactPath(spec, root.kind)
			if len(relativePath) == 0 {
				continue
			}
			_, found, err := readBoundedRegularFile(root.path, relativePath)
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
		relativePath := credentialArtifactPath(spec, root.kind)
		if len(relativePath) == 0 {
			continue
		}
		document, found, err := readBoundedRegularFile(root.path, relativePath)
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

// reconcileNativeCredential 从投影回收 gemini/grok 这类原生凭据。
//
// 只有投影里的代际证据（gemini 的 expiry_date、grok 的 access token iat）
// 能证明比数据库更新时才 CAS 采纳；代际相同视为同一份凭据，不做无意义的
// 字节级替换；代际不可比较时失败关闭，避免把旧凭据写回新账号。
func reconcileNativeCredential(
	preparer *Preparer,
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
	roots []projectionRoot,
	spec credentialSpec,
) error {
	current, valid := snapshot.Credential().(*accountcore.NativeCredential)
	if !valid || current == nil {
		for _, root := range roots {
			for _, artifact := range spec.artifacts {
				if artifact.rootKind != root.kind {
					continue
				}
				_, found, err := readBoundedRegularFile(root.path, artifact.segments)
				if err != nil {
					return err
				}
				if found {
					return fmt.Errorf("静态凭据账号存在原生凭据投影")
				}
			}
		}
		return nil
	}

	selected := current
	for _, root := range roots {
		candidate, found, err := decodeProjectionNativeCredential(
			root,
			spec,
			current,
			snapshot.ProviderID(),
		)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		if candidate.IdentitySeed() != current.IdentitySeed() ||
			candidate.AuthKind() != current.AuthKind() {
			return fmt.Errorf("投影原生凭据身份不一致")
		}
		if sameNativeGeneration(candidate, selected) {
			continue
		}
		newer, ordered := candidate.NewerThan(selected)
		if !ordered {
			return fmt.Errorf("投影原生凭据代际无法比较")
		}
		if newer {
			selected = candidate
		}
	}
	if selected == current {
		return nil
	}
	return preparer.replaceCredential(ctx, snapshot, selected)
}

// decodeProjectionNativeCredential 把投影里的凭据文件重建成 native_auth_json。
//
// 以数据库现有载荷为底：投影只覆盖自己声明的字段，像 gemini 的 google_accounts
// 缺失时仍能保留已入库的邮箱身份，避免把可选文件缺失误判成身份丢失。
func decodeProjectionNativeCredential(
	root projectionRoot,
	spec credentialSpec,
	current *accountcore.NativeCredential,
	providerID string,
) (*accountcore.NativeCredential, bool, error) {
	envelope := make(map[string]json.RawMessage)
	if payload := current.Payload(); len(payload) > 0 {
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return nil, false, fmt.Errorf("当前原生凭据文档无效")
		}
	}
	found := false
	missingRequired := false
	for _, artifact := range spec.artifacts {
		if artifact.rootKind != root.kind {
			continue
		}
		document, exists, err := readBoundedRegularFile(root.path, artifact.segments)
		if err != nil {
			return nil, false, err
		}
		if !exists {
			if artifact.optional {
				continue
			}
			missingRequired = true
			continue
		}
		envelope[artifact.field] = document
		found = true
	}
	if missingRequired {
		if !found {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("投影原生凭据不完整")
	}
	if !found {
		return nil, false, nil
	}
	document, err := json.Marshal(envelope)
	if err != nil {
		return nil, false, fmt.Errorf("投影原生凭据文档无效")
	}
	decoded, err := nativeaccount.NewDecoder().DecodeNativeAuth(providerID, document)
	if err != nil {
		return nil, false, fmt.Errorf("投影原生凭据无效")
	}
	credential, valid := decoded.(*accountcore.NativeCredential)
	if !valid || credential == nil {
		return nil, false, fmt.Errorf("投影原生凭据类型无效")
	}
	return credential, true, nil
}

// sameNativeGeneration 判断两份凭据是否来自同一代签发。
// 代际相同但序列化字节不同时只保留数据库版本，不触发 CAS。
func sameNativeGeneration(left, right *accountcore.NativeCredential) bool {
	leftGenerations := left.Generations()
	rightGenerations := right.Generations()
	if len(leftGenerations) != len(rightGenerations) {
		return false
	}
	values := make(map[string]int64, len(rightGenerations))
	for _, item := range rightGenerations {
		values[item.Scope] = item.Value
	}
	for _, item := range leftGenerations {
		value, found := values[item.Scope]
		if !found || value != item.Value {
			return false
		}
	}
	return true
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
