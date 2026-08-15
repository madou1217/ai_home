package deletionprojection_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/claude/securestorage"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
)

var deletionProjectionTime = time.Date(2026, 8, 15, 2, 3, 4, 0, time.UTC)

// TestPreparerMigratesCodexResourcesBeforeRemovingSensitiveProjection 验证
// session 等共享资源先进入原生目录，随后才删除账号凭据投影。
func TestPreparerMigratesCodexResourcesBeforeRemovingSensitiveProjection(t *testing.T) {
	t.Parallel()

	fixture := newProjectionFixture(t, codexCredential(t, "old", deletionProjectionTime))
	projectionRoot := fixture.projectionRoot("codex")
	writeCodexProjection(t, projectionRoot, fixture.credentials.snapshot.Credential())
	resourcePath := filepath.Join(projectionRoot, ".codex", "sessions", "thread.json")
	writePrivateFile(t, resourcePath, []byte(`{"thread":"kept"}`))

	if err := fixture.preparer.PrepareAccountDeletion(
		context.Background(),
		fixture.account,
	); err != nil {
		t.Fatalf("PrepareAccountDeletion() error = %v", err)
	}

	if _, err := os.Lstat(projectionRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("敏感 projection 未删除: %v", err)
	}
	kept, err := os.ReadFile(filepath.Join(fixture.hostHome, ".codex", "sessions", "thread.json"))
	if err != nil || string(kept) != `{"thread":"kept"}` {
		t.Fatalf("Provider 资源未保留: data=%q error=%v", kept, err)
	}
	if fixture.credentials.replaceCalls != 0 {
		t.Fatalf("相同凭据不应重复写库: calls=%d", fixture.credentials.replaceCalls)
	}
}

// TestPreparerCapturesNewerCodexCredentialBeforeResourceFailure 验证后续资源
// 收敛失败时，已经由官方时间证明更新的 Token 仍保存在未删除的数据库账号中。
func TestPreparerCapturesNewerCodexCredentialBeforeResourceFailure(t *testing.T) {
	t.Parallel()

	current := codexCredential(t, "old", deletionProjectionTime)
	newer := codexCredential(t, "new", deletionProjectionTime.Add(time.Minute))
	fixture := newProjectionFixture(t, current)
	projectionRoot := fixture.projectionRoot("codex")
	writeCodexProjection(t, projectionRoot, newer)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatalf("MkdirAll(outside) error = %v", err)
	}
	unmanagedLink := filepath.Join(projectionRoot, ".codex", "sessions")
	if err := os.Symlink(outside, unmanagedLink); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}

	err := fixture.preparer.PrepareAccountDeletion(context.Background(), fixture.account)
	if !errors.Is(err, accountapp.ErrAccountDeletionPreparationFailed) {
		t.Fatalf("PrepareAccountDeletion() error = %v", err)
	}
	if fixture.credentials.replaceCalls != 1 {
		t.Fatalf("较新凭据写入次数 = %d", fixture.credentials.replaceCalls)
	}
	persisted, valid := fixture.credentials.snapshot.Credential().(*codex.OAuthAuth)
	if !valid || persisted.AccessToken() != newer.AccessToken() {
		t.Fatal("资源失败后未保留较新 Codex OAuth")
	}
	if _, err := os.Lstat(projectionRoot); err != nil {
		t.Fatalf("失败关闭不应删除 projection: %v", err)
	}
}

// TestPreparerFailsClosedWhenClaudeProjectionCredentialChanged 验证 Claude
// projection 不携带稳定 UUID 时不能根据 opaque Token 或过期时间猜测身份。
func TestPreparerFailsClosedWhenClaudeProjectionCredentialChanged(t *testing.T) {
	t.Parallel()

	current := claudeCredential(t, "old", deletionProjectionTime.Add(time.Hour))
	changed := claudeCredential(t, "new", deletionProjectionTime.Add(2*time.Hour))
	fixture := newProjectionFixture(t, current)
	projectionRoot := fixture.projectionRoot("claude")
	writeClaudeProjection(t, projectionRoot, changed)

	err := fixture.preparer.PrepareAccountDeletion(context.Background(), fixture.account)
	if !errors.Is(err, accountapp.ErrAccountDeletionPreparationFailed) {
		t.Fatalf("PrepareAccountDeletion() error = %v", err)
	}
	if fixture.credentials.replaceCalls != 0 {
		t.Fatalf("Claude 身份不完整时不应覆盖凭据: calls=%d", fixture.credentials.replaceCalls)
	}
	if _, err := os.Lstat(projectionRoot); err != nil {
		t.Fatalf("失败关闭不应删除 projection: %v", err)
	}
}

// TestPreparerPreservesConflictingProviderResource 验证不同内容不会覆盖 host
// 文件，而是进入按 AccountRef 隔离的恢复目录。
func TestPreparerPreservesConflictingProviderResource(t *testing.T) {
	t.Parallel()

	fixture := newProjectionFixture(t, codexCredential(t, "old", deletionProjectionTime))
	projectionRoot := fixture.projectionRoot("codex")
	writeCodexProjection(t, projectionRoot, fixture.credentials.snapshot.Credential())
	writePrivateFile(
		t,
		filepath.Join(projectionRoot, ".codex", "history.jsonl"),
		[]byte("projection-history\n"),
	)
	writePrivateFile(
		t,
		filepath.Join(fixture.hostHome, ".codex", "history.jsonl"),
		[]byte("host-history\n"),
	)

	if err := fixture.preparer.PrepareAccountDeletion(
		context.Background(),
		fixture.account,
	); err != nil {
		t.Fatalf("PrepareAccountDeletion() error = %v", err)
	}

	hostData, err := os.ReadFile(filepath.Join(fixture.hostHome, ".codex", "history.jsonl"))
	if err != nil || string(hostData) != "host-history\n" {
		t.Fatalf("host 文件被覆盖: data=%q error=%v", hostData, err)
	}
	conflictPath := filepath.Join(
		fixture.hostHome,
		".codex",
		".aih-migration-conflicts",
		fixture.account.Ref().String(),
		"history.jsonl",
	)
	conflictData, err := os.ReadFile(conflictPath)
	if err != nil || string(conflictData) != "projection-history\n" {
		t.Fatalf("冲突资源未保留: data=%q error=%v", conflictData, err)
	}
}

// TestPreparerRejectsProjectionAncestorSymlink 验证固定路径的任一内部祖先是
// symlink 时不会跟随到 AIH_HOME 外部。
func TestPreparerRejectsProjectionAncestorSymlink(t *testing.T) {
	t.Parallel()

	fixture := newProjectionFixture(t, codexCredential(t, "old", deletionProjectionTime))
	outside := t.TempDir()
	runPath := filepath.Join(fixture.aiHome, "run")
	if err := os.Symlink(outside, runPath); err != nil {
		t.Fatalf("Symlink(run) error = %v", err)
	}

	err := fixture.preparer.PrepareAccountDeletion(context.Background(), fixture.account)
	if !errors.Is(err, accountapp.ErrAccountDeletionPreparationFailed) {
		t.Fatalf("PrepareAccountDeletion() error = %v", err)
	}
	if fixture.credentials.replaceCalls != 0 {
		t.Fatalf("路径校验失败后不应写凭据: calls=%d", fixture.credentials.replaceCalls)
	}
}

// TestPreparerAllowsMissingProjection 验证没有 Node projection 的纯 Go 账号
// 删除准备是幂等空操作。
func TestPreparerAllowsMissingProjection(t *testing.T) {
	t.Parallel()

	fixture := newProjectionFixture(t, codexCredential(t, "old", deletionProjectionTime))
	if err := fixture.preparer.PrepareAccountDeletion(
		context.Background(),
		fixture.account,
	); err != nil {
		t.Fatalf("PrepareAccountDeletion() error = %v", err)
	}
}

type projectionFixture struct {
	aiHome      string
	hostHome    string
	account     accountcore.Account
	credentials *credentialStoreStub
	preparer    *deletionprojection.Preparer
}

func newProjectionFixture(
	t *testing.T,
	credential accountapp.Credential,
) projectionFixture {
	t.Helper()

	aiHome := filepath.Join(t.TempDir(), "aih-home")
	hostHome := filepath.Join(t.TempDir(), "host-home")
	if err := os.MkdirAll(aiHome, 0o700); err != nil {
		t.Fatalf("MkdirAll(AIH_HOME) error = %v", err)
	}
	if err := os.MkdirAll(hostHome, 0o700); err != nil {
		t.Fatalf("MkdirAll(host HOME) error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          accountRef,
		ProviderID:   credential.ProviderID(),
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    deletionProjectionTime,
		UpdatedAt:    deletionProjectionTime,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential.ProviderID(),
		credential,
		deletionProjectionTime,
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	store := &credentialStoreStub{snapshot: snapshot}
	preparer, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Credentials: store,
		Clock:       func() time.Time { return deletionProjectionTime.Add(time.Second) },
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return projectionFixture{
		aiHome:      aiHome,
		hostHome:    hostHome,
		account:     account,
		credentials: store,
		preparer:    preparer,
	}
}

func (fixture projectionFixture) projectionRoot(providerID string) string {
	return filepath.Join(
		fixture.aiHome,
		"run",
		"auth-projections",
		providerID,
		fixture.account.Ref().String(),
	)
}

type credentialStoreStub struct {
	snapshot     accountapp.CredentialSnapshot
	replaceCalls int
}

func (store *credentialStoreStub) GetCredentialSnapshot(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	return store.snapshot, nil
}

func (store *credentialStoreStub) ReplaceCredential(
	_ context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	store.replaceCalls++
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		replacement.Credential().ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = next
	return nil
}

func writeCodexProjection(
	t *testing.T,
	projectionRoot string,
	credential accountapp.Credential,
) {
	t.Helper()

	auth, valid := credential.(codex.Auth)
	if !valid {
		t.Fatalf("credential type = %T, want codex.Auth", credential)
	}
	document, err := authfile.Encode(auth)
	if err != nil {
		t.Fatalf("authfile.Encode() error = %v", err)
	}
	writePrivateFile(t, filepath.Join(projectionRoot, ".codex", "auth.json"), document)
}

func writeClaudeProjection(
	t *testing.T,
	projectionRoot string,
	auth *claude.OAuthAuth,
) {
	t.Helper()

	document, err := securestorage.Encode(securestorage.DecodedOAuth{
		Auth: auth,
	})
	if err != nil {
		t.Fatalf("securestorage.Encode() error = %v", err)
	}
	writePrivateFile(t, filepath.Join(projectionRoot, ".claude", ".credentials.json"), document)
}

func writePrivateFile(t *testing.T, filePath string, data []byte) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatalf("MkdirAll(%s) error = %v", filePath, err)
	}
	if err := os.WriteFile(filePath, data, 0o600); err != nil {
		t.Fatalf("WriteFile(%s) error = %v", filePath, err)
	}
}

func codexCredential(t *testing.T, tokenLabel string, refreshedAt time.Time) *codex.OAuthAuth {
	t.Helper()

	idToken := testJWT(t, map[string]any{
		"sub":   "deletion-projection-user",
		"email": "deletion-projection@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "deletion-projection-workspace",
			"chatgpt_plan_type":  "plus",
		},
	})
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       "synthetic-codex-access-" + tokenLabel,
		RefreshToken:      "synthetic-codex-refresh-" + tokenLabel,
		IDToken:           idToken,
		RefreshedAtMS:     refreshedAt.UnixMilli(),
		ExplicitAccountID: "deletion-projection-workspace",
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	return auth
}

func claudeCredential(t *testing.T, tokenLabel string, expiresAt time.Time) *claude.OAuthAuth {
	t.Helper()

	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "sk-ant-oat01-synthetic-" + tokenLabel,
		RefreshToken: "sk-ant-ort01-synthetic-" + tokenLabel,
		ExpiresAtMS:  expiresAt.UnixMilli(),
		Scopes:       []string{"user:inference", "user:profile"},
		Identity: claude.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174777",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	return auth
}

func testJWT(t *testing.T, payload map[string]any) string {
	t.Helper()

	header := []byte(`{"alg":"none","typ":"JWT"}`)
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(body) + ".signature"
}
