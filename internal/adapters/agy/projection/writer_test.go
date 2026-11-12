package projection

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/agy/authmeta"
)

func testAgyAuth(t *testing.T, accessToken string) *agy.OAuthAuth {
	t.Helper()
	return testAgyAuthFor(t, "agy@example.test", accessToken, time.Date(2026, time.November, 11, 10, 0, 0, 0, time.UTC))
}

func testAgyAuthFor(t *testing.T, email string, accessToken string, refreshedAt time.Time) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         email,
		AccessToken:   accessToken,
		RefreshToken:  "refresh-token",
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", path, err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("Unmarshal(%s) error = %v", path, err)
	}
	return document
}

func writeFile(t *testing.T, path string, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

func requireMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat(%s) error = %v", path, err)
	}
	if info.Mode().Perm() != want {
		t.Fatalf("%s mode = %o, want %o", path, info.Mode().Perm(), want)
	}
}

func runtimeDirFor(aiHomeDir string, accountRef string) string {
	return filepath.Join(aiHomeDir, "run", "auth-projections", "agy", accountRef)
}

func TestWriteMaterializesAllAgyArtifacts(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	runtimeDir := runtimeDirFor(aiHomeDir, accountRef)
	// 旧投影里刻意放了 Node 不认识的键（universe_domain / stale_key）：兼容文件是
	// 纯派生产物，整份覆盖后它们必须消失。
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"),
		`{"access_token":"old","refresh_token":"old-refresh","scope":"cloud-platform",`+
			`"universe_domain":"googleapis.com","stale_key":"drop-me","expiry_date":1}`, 0o644)
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "google_accounts.json"),
		`{"active":"old@example.test","old":["older@example.test"]}`, 0o600)
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "email.cache"),
		"old@example.test", 0o644)
	// id_token 只存在于 CLI 自己写的规范凭据里：Node 的 oauth_creds.json 由这份
	// 文档派生，所以它能带过去；CLI 的其它键（custom / token.scope）不属于派生集。
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
		`{"auth_method":"oauth","custom":"keep-me",`+
			`"token":{"access_token":"old","scope":"legacy","id_token":"id-token-keep"}}`, 0o600)

	auth := testAgyAuth(t, "new-access")
	if err := Write(aiHomeDir, accountRef, auth); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	// CLI 规范凭据：Node agy-token-refresh.persistAgyOAuthSnapshot 的字段形状。
	antigravityPath := filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token")
	antigravity := readJSON(t, antigravityPath)
	if antigravity["auth_method"] != "consumer" {
		t.Fatalf("auth_method = %v, want consumer（CLI 只认 consumer）", antigravity["auth_method"])
	}
	if antigravity["id_token_email"] != "agy@example.test" {
		t.Fatalf("id_token_email = %v", antigravity["id_token_email"])
	}
	if antigravity["last_refresh"] != "2026-11-11T10:00:00.000Z" {
		t.Fatalf("last_refresh = %v, want ISO 毫秒形态", antigravity["last_refresh"])
	}
	if antigravity["custom"] != "keep-me" {
		t.Fatalf("custom = %v, want 保留 CLI 自己的键", antigravity["custom"])
	}
	token, _ := antigravity["token"].(map[string]any)
	if token["access_token"] != "new-access" || token["refresh_token"] != "refresh-token" ||
		token["token_type"] != "Bearer" {
		t.Fatalf("token = %v", token)
	}
	if token["expiry"] != "2026-11-11T11:00:00.000Z" {
		t.Fatalf("expiry = %v, want ISO 毫秒形态", token["expiry"])
	}
	if number(token["expires_at_ms"]) != auth.ExpiresAtMS() ||
		number(token["refreshed_at_ms"]) != auth.RefreshedAtMS() {
		t.Fatalf("token 毫秒字段 = %v", token)
	}
	if _, found := token["expires_in"]; found {
		t.Fatal("expires_in 不在 Node 的物化字段里，不应写入")
	}
	if token["scope"] != "legacy" {
		t.Fatalf("token.scope = %v, want 保留未知子键", token["scope"])
	}

	// 桌面端副本与规范文件必须逐字节一致（Node 写同一份文档）。
	desktopRaw, err := os.ReadFile(filepath.Join(runtimeDir, ".gemini", "jetski-standalone-oauth-token"))
	if err != nil {
		t.Fatalf("ReadFile(jetski) error = %v", err)
	}
	antigravityRaw, err := os.ReadFile(antigravityPath)
	if err != nil {
		t.Fatalf("ReadFile(antigravity) error = %v", err)
	}
	if string(desktopRaw) != string(antigravityRaw) {
		t.Fatalf("jetski 副本与规范凭据不一致：\n%s\n%s", desktopRaw, antigravityRaw)
	}

	// 桌面端 2.x 读的通用 Gemini OAuth 文件：由 oauthToken 派生。
	creds := readJSON(t, filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"))
	if creds["access_token"] != "new-access" || creds["refresh_token"] != "refresh-token" ||
		creds["token_type"] != "Bearer" {
		t.Fatalf("oauth_creds = %v", creds)
	}
	if number(creds["expiry_date"]) != auth.ExpiresAtMS() {
		t.Fatalf("expiry_date = %v", creds["expiry_date"])
	}
	if creds["scope"] != authmeta.GeminiOAuthScope {
		t.Fatalf("scope = %v, want Node AGY_GEMINI_OAUTH_SCOPE", creds["scope"])
	}
	if creds["id_token"] != "id-token-keep" {
		t.Fatalf("id_token = %v, want 从 CLI 规范凭据派生", creds["id_token"])
	}
	// Node 是整份覆盖：派生集之外的键不得残留。
	if _, found := creds["universe_domain"]; found {
		t.Fatalf("universe_domain = %v, want 整份覆盖后消失", creds["universe_domain"])
	}
	if _, found := creds["stale_key"]; found {
		t.Fatalf("stale_key = %v, want 整份覆盖后消失", creds["stale_key"])
	}
	if len(creds) != 6 {
		t.Fatalf("oauth_creds keys = %d (%v), want Node 固定 6 键", len(creds), creds)
	}

	// 账号列表：active 指向本账号，old 由 Node buildAgyGoogleAccounts 清空。
	accounts := readJSON(t, filepath.Join(runtimeDir, ".gemini", "google_accounts.json"))
	if accounts["active"] != "agy@example.test" {
		t.Fatalf("google_accounts active = %v", accounts["active"])
	}
	oldAccounts, _ := accounts["old"].([]any)
	if len(oldAccounts) != 0 {
		t.Fatalf("google_accounts old = %v, want 清空", accounts["old"])
	}

	emailCache, err := os.ReadFile(filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "email.cache"))
	if err != nil || string(emailCache) != "agy@example.test" {
		t.Fatalf("email.cache = %q, %v", string(emailCache), err)
	}

	for _, relative := range []string{
		antigravityTokenFile,
		desktopTokenFile,
		emailCacheFile,
		oauthCredsFile,
		googleAccountsFile,
	} {
		requireMode(t, filepath.Join(runtimeDir, filepath.FromSlash(relative)), projectionFileMode)
	}
}

// 领域凭据里的 id_token 必须写进两份 CLI 凭据与派生的 oauth_creds.json；
// 否则新建投影（没有历史 CLI 文件）会缺这个字段。
func TestWriteUsesCredentialIDToken(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	runtimeDir := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", accountRef)
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	refreshedAt := time.Date(2026, time.November, 11, 10, 0, 0, 0, time.UTC)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.test",
		AccessToken:   "new-access",
		RefreshToken:  "new-refresh",
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
		IDToken:       "credential-id-token",
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	if err := Write(aiHomeDir, accountRef, auth); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	creds := readJSON(t, filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"))
	if creds["id_token"] != "credential-id-token" {
		t.Fatalf("oauth_creds id_token = %v", creds["id_token"])
	}
	cliToken := readJSON(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"))
	token, _ := cliToken["token"].(map[string]any)
	if token["id_token"] != "credential-id-token" {
		t.Fatalf("cli token id_token = %v", token["id_token"])
	}
}

func TestWriteSkipsMissingRuntimeDir(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	if err := Write(aiHomeDir, accountRef, testAgyAuth(t, "new-access")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if _, err := os.Stat(runtimeDirFor(aiHomeDir, accountRef)); !os.IsNotExist(err) {
		t.Fatalf("runtime dir was created: %v", err)
	}
}

func TestWriteRejectsInvalidInput(t *testing.T) {
	auth := testAgyAuth(t, "new-access")
	if err := Write("", "acct_0123456789abcdef0123", auth); err != ErrInvalidInput {
		t.Fatalf("Write(empty home) error = %v", err)
	}
	if err := Write(t.TempDir(), "", auth); err != ErrInvalidInput {
		t.Fatalf("Write(empty ref) error = %v", err)
	}
	if err := Write(t.TempDir(), "acct_0123456789abcdef0123", nil); err != ErrInvalidInput {
		t.Fatalf("Write(nil auth) error = %v", err)
	}
}

// re-key 场景：Google 侧改了邮箱，刷新回来的凭据是另一个邮箱，投影里的
// 邮箱缓存、账号列表与 id_token_email 都必须跟着变。
func TestWriteFollowsEmailRekey(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	runtimeDir := runtimeDirFor(aiHomeDir, accountRef)
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "google_accounts.json"),
		`{"active":"before@example.test","old":["before@example.test","other@example.test"]}`, 0o600)
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "email.cache"),
		"before@example.test", 0o600)
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
		`{"auth_method":"consumer","id_token_email":"before@example.test","token":{"access_token":"old"}}`, 0o600)

	auth := testAgyAuthFor(t, "after@example.test", "new-access", time.Date(2026, time.November, 11, 10, 0, 0, 0, time.UTC))
	if err := Write(aiHomeDir, accountRef, auth); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	antigravity := readJSON(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"))
	if antigravity["id_token_email"] != "after@example.test" {
		t.Fatalf("id_token_email = %v, want 新邮箱", antigravity["id_token_email"])
	}
	token, _ := antigravity["token"].(map[string]any)
	if token["access_token"] != "new-access" {
		t.Fatalf("token.access_token = %v", token["access_token"])
	}
	emailCache, err := os.ReadFile(filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "email.cache"))
	if err != nil || string(emailCache) != "after@example.test" {
		t.Fatalf("email.cache = %q, %v", string(emailCache), err)
	}
	accounts := readJSON(t, filepath.Join(runtimeDir, ".gemini", "google_accounts.json"))
	if accounts["active"] != "after@example.test" {
		t.Fatalf("active = %v, want 新邮箱", accounts["active"])
	}
	if oldAccounts, _ := accounts["old"].([]any); len(oldAccounts) != 0 {
		t.Fatalf("old = %v, want re-key 后清空", accounts["old"])
	}
	// 同一次物化里通用 Gemini 凭据也要跟上新邮箱所在的账号（token 是最新的）。
	creds := readJSON(t, filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"))
	if creds["access_token"] != "new-access" {
		t.Fatalf("oauth_creds access_token = %v", creds["access_token"])
	}
	// 规范凭据里没有 id_token 时，Node 的展开语法会省略该键（不是写空串）。
	if _, found := creds["id_token"]; found {
		t.Fatalf("id_token = %v, want 省略", creds["id_token"])
	}
	if len(creds) != 5 {
		t.Fatalf("oauth_creds keys = %d (%v), want 5 键", len(creds), creds)
	}
}

// 新账号第一次刷新：投影根存在但里面是空的，五份文件都要按 0600 建好，
// 目录按 0700 创建。
func TestWriteCreatesArtifactsInEmptyProjection(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	runtimeDir := runtimeDirFor(aiHomeDir, accountRef)
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := Write(aiHomeDir, accountRef, testAgyAuth(t, "new-access")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	for _, relative := range []string{
		antigravityTokenFile,
		desktopTokenFile,
		emailCacheFile,
		oauthCredsFile,
		googleAccountsFile,
	} {
		path := filepath.Join(runtimeDir, filepath.FromSlash(relative))
		requireMode(t, path, projectionFileMode)
	}
	requireMode(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli"), projectionDirMode)
}

// 投影里的 JSON 被打断（客户端写一半、磁盘坏块）时按「没有数据」处理并整份重写。
func TestWriteRepairsCorruptArtifacts(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	runtimeDir := runtimeDirFor(aiHomeDir, accountRef)
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "{not-json", 0o600)
	writeFile(t, filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"), "[1,2,3]", 0o600)

	if err := Write(aiHomeDir, accountRef, testAgyAuth(t, "new-access")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	antigravity := readJSON(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"))
	if antigravity["auth_method"] != "consumer" {
		t.Fatalf("auth_method = %v", antigravity["auth_method"])
	}
	creds := readJSON(t, filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"))
	if creds["access_token"] != "new-access" || creds["scope"] != authmeta.GeminiOAuthScope {
		t.Fatalf("oauth_creds = %v", creds)
	}
}

// 原生 artifact 没记录刷新时间时（NewNativeOAuthAuth 允许未知），不能把
// 「1970 年刷新过」写进投影：refreshed_at_ms / last_refresh 保持缺失。
func TestWriteOmitsUnknownRefreshGeneration(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	runtimeDir := runtimeDirFor(aiHomeDir, accountRef)
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	auth, err := agy.NewNativeOAuthAuth(agy.OAuthInput{
		Email:        "agy@example.test",
		AccessToken:  "new-access",
		RefreshToken: "refresh-token",
		ExpiresAtMS:  time.Date(2026, time.November, 11, 11, 0, 0, 0, time.UTC).UnixMilli(),
		TokenType:    "Bearer",
		AuthMethod:   agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewNativeOAuthAuth() error = %v", err)
	}
	if err := Write(aiHomeDir, accountRef, auth); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	antigravity := readJSON(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"))
	token, _ := antigravity["token"].(map[string]any)
	if _, found := token["refreshed_at_ms"]; found {
		t.Fatalf("refreshed_at_ms = %v, want 缺失", token["refreshed_at_ms"])
	}
	if _, found := antigravity["last_refresh"]; found {
		t.Fatalf("last_refresh = %v, want 缺失", antigravity["last_refresh"])
	}
	if token["expiry"] != "2026-11-11T11:00:00.000Z" {
		t.Fatalf("expiry = %v", token["expiry"])
	}
}

func number(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	default:
		return 0
	}
}
