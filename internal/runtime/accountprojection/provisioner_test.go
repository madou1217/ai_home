package accountprojection

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
)

type memoryStore struct {
	mu       sync.Mutex
	snapshot accountapp.CredentialSnapshot
}

func (store *memoryStore) GetCredentialSnapshot(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.snapshot.AccountRef() != accountRef {
		return accountapp.CredentialSnapshot{}, accountapp.ErrCredentialNotFound
	}
	return store.snapshot, nil
}

func (store *memoryStore) ReplaceCredential(
	_ context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if replacement.ExpectedUpdatedAt() != store.snapshot.UpdatedAt() {
		return accountapp.ErrCredentialConflict
	}
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		store.snapshot.ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = next
	return nil
}

func TestCodexProjectionPrepareCaptureRemove(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	hostCodex := filepath.Join(hostHome, ".codex")
	if err := os.MkdirAll(filepath.Join(hostCodex, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hostCodex, "sessions", "s1.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hostCodex, "history.jsonl"), []byte("host-history\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	hostAuth := []byte("host-auth-sentinel\n")
	if err := os.WriteFile(filepath.Join(hostCodex, "auth.json"), hostAuth, 0o600); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	current := testOAuth(t, "user-1", "account-1", now.Add(-time.Hour))
	accountRef, err := accountcore.DeriveAccountRef(current)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(accountRef, "codex", current, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	store := &memoryStore{snapshot: snapshot}
	registry := providerstorage.New()
	provisioner, err := New(Options{
		AIHomeDir:     aiHome,
		Policies:      registry,
		Materializers: registry.Materializers(),
		Linker:        NewLinker(),
		Credentials:   store,
		Now:           func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	runtimeDir := filepath.Join(aiHome, "run", "auth-projections", "codex", accountRef.String())
	request := appprojection.Request{
		ProviderID:         "codex",
		AccountRef:         accountRef,
		Credential:         current,
		HostHomeDir:        hostHome,
		AIHomeDir:          aiHome,
		Platform:           "darwin",
		Purpose:            appprojection.PurposeLaunch,
		ProjectionRequired: true,
		RuntimeDir:         runtimeDir,
	}
	result, err := provisioner.Prepare(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Root != runtimeDir {
		t.Fatalf("root = %q, want %q", result.Root, runtimeDir)
	}
	if result.SetEnv["CODEX_HOME"] != filepath.Join(runtimeDir, ".codex") {
		t.Fatalf("CODEX_HOME = %q", result.SetEnv["CODEX_HOME"])
	}
	if result.SetEnv["CODEX_SQLITE_HOME"] != hostCodex {
		t.Fatalf("CODEX_SQLITE_HOME = %q, want %q", result.SetEnv["CODEX_SQLITE_HOME"], hostCodex)
	}
	assertManagedLink(t, filepath.Join(runtimeDir, ".codex", "sessions"), filepath.Join(hostCodex, "sessions"))
	assertManagedLink(t, filepath.Join(runtimeDir, ".codex", "history.jsonl"), filepath.Join(hostCodex, "history.jsonl"))
	if _, err := os.Lstat(filepath.Join(runtimeDir, ".codex", "config.toml")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config.toml must stay private, err=%v", err)
	}
	authPath := filepath.Join(runtimeDir, ".codex", "auth.json")
	info, err := os.Stat(authPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("auth.json mode = %o, want 600", info.Mode().Perm())
	}
	assertAuthIdentity(t, authPath, current.IdentitySeed())
	if hostData, err := os.ReadFile(filepath.Join(hostCodex, "auth.json")); err != nil || !bytes.Equal(hostData, hostAuth) {
		t.Fatalf("host auth.json must not be modified: err=%v data=%q", err, hostData)
	}

	next := testOAuth(t, "user-1", "account-1", now)
	nextData, err := authfile.Encode(next)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, nextData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := provisioner.Capture(ctx, request, result); err != nil {
		t.Fatal(err)
	}
	captured, err := store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		t.Fatal(err)
	}
	if captured.Credential().(*codex.OAuthAuth).AccessToken() != next.AccessToken() {
		t.Fatal("capture did not adopt the newer token")
	}
	capturedAt := captured.UpdatedAt()
	if err := provisioner.Capture(ctx, request, result); err != nil {
		t.Fatal(err)
	}
	stable, err := store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		t.Fatal(err)
	}
	if !stable.UpdatedAt().Equal(capturedAt) {
		t.Fatal("unchanged capture must not rewrite the credential")
	}

	second := testOAuth(t, "user-2", "account-2", now.Add(-time.Hour))
	secondRef, err := accountcore.DeriveAccountRef(second)
	if err != nil {
		t.Fatal(err)
	}
	secondDir := filepath.Join(aiHome, "run", "auth-projections", "codex", secondRef.String())
	secondRequest := request
	secondRequest.AccountRef = secondRef
	secondRequest.Credential = second
	secondRequest.RuntimeDir = secondDir
	secondResult, err := provisioner.Prepare(ctx, secondRequest)
	if err != nil {
		t.Fatal(err)
	}
	if secondResult.Root == result.Root {
		t.Fatal("two accounts must not share a projection root")
	}
	assertAuthIdentity(t, filepath.Join(secondDir, ".codex", "auth.json"), second.IdentitySeed())
	assertManagedLink(t, filepath.Join(secondDir, ".codex", "sessions"), filepath.Join(hostCodex, "sessions"))

	if err := provisioner.Remove(ctx, "codex", accountRef); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(runtimeDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("projection root should be removed, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(hostCodex, "sessions", "s1.jsonl")); err != nil {
		t.Fatalf("host sessions must survive projection removal: %v", err)
	}
	if hostData, err := os.ReadFile(filepath.Join(hostCodex, "auth.json")); err != nil || !bytes.Equal(hostData, hostAuth) {
		t.Fatalf("host auth.json must survive projection removal: err=%v data=%q", err, hostData)
	}
}

func assertManagedLink(t *testing.T, link string, target string) {
	t.Helper()
	destination, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("readlink %s: %v", link, err)
	}
	if filepath.Clean(destination) != filepath.Clean(target) {
		t.Fatalf("link %s -> %s, want %s", link, destination, target)
	}
}

func assertAuthIdentity(t *testing.T, path string, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	auth, err := authfile.Decode(data, authfile.DecodeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if auth.IdentitySeed() != want {
		t.Fatalf("auth identity = %q, want %q", auth.IdentitySeed(), want)
	}
}

func testOAuth(t *testing.T, user string, account string, refreshedAt time.Time) *codex.OAuthAuth {
	t.Helper()
	authClaims := map[string]any{
		"chatgpt_user_id":    user,
		"chatgpt_account_id": account,
	}
	access := fakeJWT(t, map[string]any{
		"sub":                         user,
		"iat":                         refreshedAt.Unix(),
		"exp":                         refreshedAt.Add(24 * time.Hour).Unix(),
		"https://api.openai.com/auth": authClaims,
	})
	idToken := fakeJWT(t, map[string]any{
		"sub":                         user,
		"email":                       user + "@example.com",
		"https://api.openai.com/auth": authClaims,
	})
	refresh := fakeJWT(t, map[string]any{"sub": user})
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       access,
		RefreshToken:      refresh,
		IDToken:           idToken,
		RefreshedAtMS:     refreshedAt.UnixMilli(),
		ExplicitAccountID: account,
	})
	if err != nil {
		t.Fatal(err)
	}
	return auth
}

func fakeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".c2ln"
}
