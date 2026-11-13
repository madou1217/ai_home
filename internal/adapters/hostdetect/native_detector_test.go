package hostdetect

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountdetectapi"
	"golang.org/x/crypto/pbkdf2"
	_ "modernc.org/sqlite"
)

type detectorTestHarness struct {
	aiHomeDir   string
	hostHomeDir string
	store       *sqliteaccount.Store
	catalog     *providers.Catalog
	now         time.Time
}

func newDetectorTestHarness(t *testing.T) *detectorTestHarness {
	t.Helper()
	tmp := t.TempDir()
	aiHome := filepath.Join(tmp, "aih")
	hostHome := filepath.Join(tmp, "host")
	if err := os.MkdirAll(aiHome, 0o700); err != nil {
		t.Fatalf("MkdirAll(aiHome) error = %v", err)
	}
	if err := os.MkdirAll(hostHome, 0o700); err != nil {
		t.Fatalf("MkdirAll(hostHome) error = %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	return &detectorTestHarness{
		aiHomeDir:   aiHome,
		hostHomeDir: hostHome,
		store:       store,
		catalog:     catalog,
		now:         time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC),
	}
}

func (h *detectorTestHarness) newOptions(extra ...func(*NativeDetectorOptions)) NativeDetectorOptions {
	opts := NativeDetectorOptions{
		AIHomeDir:     h.aiHomeDir,
		HostHomeDir:   h.hostHomeDir,
		Store:         h.store,
		Catalog:       h.catalog,
		Clock:         func() time.Time { return h.now },
		OSPlatform:    "darwin",
		LookupEnv:     func(string) (string, bool) { return "", false },
		Environ:       func() []string { return nil },
		UserDataRoots: []string{},
		VolumeRoots:   []string{},
	}
	for _, fn := range extra {
		if fn != nil {
			fn(&opts)
		}
	}
	return opts
}

func writeTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", path, err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func writeTestJSON(t *testing.T, path string, doc any) {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("json.Marshal error = %v", err)
	}
	writeTestFile(t, path, raw)
}

func makeTestJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payloadRaw, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal JWT claims error = %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(payloadRaw)
	return header + "." + payload + ".dGVzdHNpZw"
}

func decodeDetectResponse(t *testing.T, status int, body []byte) DetectResponse {
	t.Helper()
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, string(body))
	}
	var resp DetectResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("json.Unmarshal(DetectResponse) error = %v; body=%s", err, string(body))
	}
	return resp
}

func mustDetect(t *testing.T, detector *NativeDetector) DetectResponse {
	t.Helper()
	status, body, err := detector.Detect(context.Background())
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	return decodeDetectResponse(t, status, body)
}

func hasSkipReason(skipped []SkippedAccount, reason, provider string) bool {
	for _, item := range skipped {
		if item.Reason == reason && (provider == "" || item.Provider == provider) {
			return true
		}
	}
	return false
}

func pkcs7PadForTest(data []byte, blockSize int) []byte {
	pad := blockSize - (len(data) % blockSize)
	return append(data, bytes.Repeat([]byte{byte(pad)}, pad)...)
}

func encryptDesktopBlobV10(t *testing.T, plaintext []byte, password []byte, iterations int) []byte {
	t.Helper()
	key := pbkdf2.Key(password, []byte("saltysalt"), iterations, 16, sha1.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("aes.NewCipher error = %v", err)
	}
	padded := pkcs7PadForTest(plaintext, aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	iv := bytes.Repeat([]byte{0x20}, aes.BlockSize)
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)
	return append([]byte("v10"), ciphertext...)
}

func writeDesktopStateDB(t *testing.T, dbPath string, key string, blob []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		t.Fatalf("MkdirAll error = %v", err)
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(dbPath)}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sql.Open error = %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`); err != nil {
		t.Fatalf("CREATE TABLE error = %v", err)
	}
	bufferJSON, err := json.Marshal(map[string]any{
		"type": "Buffer",
		"data": func() []int {
			out := make([]int, len(blob))
			for i, b := range blob {
				out[i] = int(b)
			}
			return out
		}(),
	})
	if err != nil {
		t.Fatalf("marshal buffer json error = %v", err)
	}
	if _, err := db.Exec(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`, key, string(bufferJSON)); err != nil {
		t.Fatalf("INSERT error = %v", err)
	}
}

func TestNativeDetectorUnavailableReturns503(t *testing.T) {
	detector := NewNativeDetector(NativeDetectorOptions{HostHomeDir: t.TempDir()})
	status, body, err := detector.Detect(context.Background())
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", status, string(body))
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal error = %v", err)
	}
	if payload["ok"] != false || payload["error"] != "detect_host_accounts_unavailable" {
		t.Fatalf("unexpected error payload: %#v", payload)
	}
}

func TestNativeDetectorCodebuddyFamilyInfoAndGenerationUpdate(t *testing.T) {
	h := newDetectorTestHarness(t)
	reloadCount := 0
	detector := NewNativeDetector(h.newOptions(func(o *NativeDetectorOptions) {
		o.Reload = func(context.Context) error {
			reloadCount++
			return nil
		}
	}))

	infoPath := filepath.Join(
		h.hostHomeDir,
		"Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth",
		"Tencent-Cloud.coding-copilot.info",
	)
	makeCBDoc := func(iatSec, expSec int64, accessSuffix string) map[string]any {
		return map[string]any{
			"auth": map[string]any{
				"accessToken": makeTestJWT(t, map[string]any{
					"iss":   "https://www.codebuddy.ai/auth/realms/copilot",
					"sub":   "cb-uid-1",
					"iat":   iatSec,
					"exp":   expSec,
					"email": "cb-user@example.com",
					"nonce": accessSuffix,
				}),
				"refreshToken": makeTestJWT(t, map[string]any{
					"iss": "https://www.codebuddy.ai/auth/realms/copilot",
					"sub": "cb-uid-1",
					"iat": iatSec,
				}),
				"domain": "www.codebuddy.ai",
			},
			"account": map[string]any{
				"uid":      "cb-uid-1",
				"nickname": "CB User",
				"email":    "cb-user@example.com",
			},
		}
	}

	writeTestJSON(t, infoPath, makeCBDoc(h.now.Unix()-60, h.now.Unix()+3600, "gen1"))

	// 首次扫描应注册并触发 Reload。
	resp1 := mustDetect(t, detector)
	if !resp1.OK || resp1.Updated != 1 || !resp1.Reloaded || reloadCount != 1 {
		t.Fatalf("resp1=%#v reloadCount=%d", resp1, reloadCount)
	}
	if len(resp1.Registered) != 1 || resp1.Registered[0].Provider != "codebuddy" || !resp1.Registered[0].Created {
		t.Fatalf("unexpected registered: %#v", resp1.Registered)
	}
	if resp1.Accounts["codebuddy"] != 1 {
		t.Fatalf("accounts[codebuddy] = %d, want 1", resp1.Accounts["codebuddy"])
	}

	// 同代际再次扫描应跳过且不再触发 Reload。
	resp2 := mustDetect(t, detector)
	if resp2.Updated != 0 || resp2.Reloaded || reloadCount != 1 {
		t.Fatalf("resp2=%#v reloadCount=%d", resp2, reloadCount)
	}
	if !hasSkipReason(resp2.Skipped, "credential_not_newer", "codebuddy") {
		t.Fatalf("expected credential_not_newer skip, got %#v", resp2.Skipped)
	}

	// 新一代际更新：created=false，updated=1，触发 Reload。
	writeTestJSON(t, infoPath, makeCBDoc(h.now.Unix(), h.now.Unix()+7200, "gen2"))
	resp3 := mustDetect(t, detector)
	if resp3.Updated != 1 || !resp3.Reloaded || reloadCount != 2 {
		t.Fatalf("resp3=%#v reloadCount=%d", resp3, reloadCount)
	}
	if len(resp3.Registered) != 1 || resp3.Registered[0].Provider != "codebuddy" || resp3.Registered[0].Created {
		t.Fatalf("expected created=false update, got %#v", resp3.Registered)
	}

	// 站点串源测试：在 workbuddy-desktop-ai.info 里放中国站 issuer，应触发 credential_source_mismatch 或 credential_realm_mismatch。
	wbAIPath := filepath.Join(filepath.Dir(infoPath), "workbuddy-desktop-ai.info")
	writeTestJSON(t, wbAIPath, map[string]any{
		"auth": map[string]any{
			"accessToken": makeTestJWT(t, map[string]any{
				"iss": "https://www.workbuddy.cn/auth/realms/copilot",
				"sub": "wb-cn-uid",
				"iat": h.now.Unix() - 10,
				"exp": h.now.Unix() + 3600,
			}),
			"refreshToken": makeTestJWT(t, map[string]any{
				"iss": "https://www.workbuddy.cn/auth/realms/copilot",
				"sub": "wb-cn-uid",
				"iat": h.now.Unix() - 10,
			}),
			"domain": "www.workbuddy.cn",
		},
		"account": map[string]any{"uid": "wb-cn-uid"},
	})
	resp4 := mustDetect(t, detector)
	if !hasSkipReason(resp4.Skipped, "credential_source_mismatch", "") &&
		!hasSkipReason(resp4.Skipped, "credential_realm_mismatch", "") {
		t.Fatalf("expected mismatch skip, got %#v", resp4.Skipped)
	}
}

func TestNativeDetectorWorkbuddyEncryptedAndDesktopSQLite(t *testing.T) {
	h := newDetectorTestHarness(t)
	authDir := filepath.Join(h.hostHomeDir, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")
	wbAIPath := filepath.Join(authDir, "workbuddy-desktop-ai.info")
	writeTestJSON(t, wbAIPath, map[string]any{
		"auth": map[string]any{
			"accessToken":  map[string]any{"$wbEncrypted": 1, "cipher": "abc"},
			"refreshToken": map[string]any{"$wbEncrypted": 1, "cipher": "def"},
			"domain":       "www.workbuddy.ai",
		},
		"account": map[string]any{"uid": "wb-ai-1"},
	})

	decryptedWB, _ := json.Marshal(map[string]any{
		"auth": map[string]any{
			"accessToken": makeTestJWT(t, map[string]any{
				"iss":   "https://www.workbuddy.ai/auth/realms/copilot",
				"sub":   "wb-ai-1",
				"iat":   h.now.Unix() - 30,
				"exp":   h.now.Unix() + 3600,
				"email": "wb-ai@example.com",
			}),
			"refreshToken": makeTestJWT(t, map[string]any{
				"iss": "https://www.workbuddy.ai/auth/realms/copilot",
				"sub": "wb-ai-1",
				"iat": h.now.Unix() - 30,
			}),
			"domain": "www.workbuddy.ai",
		},
		"account": map[string]any{"uid": "wb-ai-1", "nickname": "WB AI"},
	})

	// 构建桌面版 CodeBuddy SQLite state.vscdb (AES-128-CBC v10 加密)。
	desktopPlain, _ := json.Marshal(map[string]any{
		"auth": map[string]any{
			"accessToken": makeTestJWT(t, map[string]any{
				"iss": "https://www.codebuddy.ai/auth/realms/copilot",
				"sub": "cb-desktop-uid",
				"iat": h.now.Unix() - 20,
				"exp": h.now.Unix() + 3600,
			}),
			"refreshToken": makeTestJWT(t, map[string]any{
				"iss": "https://www.codebuddy.ai/auth/realms/copilot",
				"sub": "cb-desktop-uid",
				"iat": h.now.Unix() - 20,
			}),
			"domain": "www.codebuddy.ai",
		},
		"account": map[string]any{"uid": "cb-desktop-uid", "nickname": "Desktop CB"},
	})
	v10Blob := encryptDesktopBlobV10(t, desktopPlain, []byte("test-keychain-pass"), 1003)
	cbDBPath := filepath.Join(h.hostHomeDir, "Library", "Application Support", "CodeBuddy", "User", "globalStorage", "state.vscdb")
	writeDesktopStateDB(t, cbDBPath, codebuddyDesktopSecretKey, v10Blob)

	// CodeBuddy CN 使用 v11 应报 desktop_credential_keyring_unavailable。
	cbCNDBPath := filepath.Join(h.hostHomeDir, "Library", "Application Support", "CodeBuddy CN", "User", "globalStorage", "state.vscdb")
	writeDesktopStateDB(t, cbCNDBPath, codebuddyDesktopSecretKey, []byte("v11someciphertext"))

	detector := NewNativeDetector(h.newOptions(func(o *NativeDetectorOptions) {
		o.DecodeWorkbuddy = func(_ context.Context, _ []byte, provider string) ([]byte, error) {
			if provider != "workbuddy" {
				return nil, errors.New("unexpected provider")
			}
			return decryptedWB, nil
		}
		o.ReadKeychain = func(service string) ([]byte, error) {
			if service == "CodeBuddy Safe Storage" {
				return []byte("test-keychain-pass"), nil
			}
			return nil, errors.New("not found")
		}
	}))

	resp := mustDetect(t, detector)
	if resp.Updated != 2 {
		t.Fatalf("updated = %d, want 2; registered=%#v skipped=%#v", resp.Updated, resp.Registered, resp.Skipped)
	}
	if resp.Accounts["workbuddy"] != 1 || resp.Accounts["codebuddy"] != 1 {
		t.Fatalf("unexpected account counts: %#v", resp.Accounts)
	}
	if !hasSkipReason(resp.Skipped, "desktop_credential_keyring_unavailable", "codebuddycn") {
		t.Fatalf("expected v11 keyring unavailable skip, got %#v", resp.Skipped)
	}
}

func TestNativeDetectorClineOAuthAndAPIKeyOnly(t *testing.T) {
	h := newDetectorTestHarness(t)
	providersPath := filepath.Join(h.hostHomeDir, ".cline", "data", "settings", "providers.json")

	// 仅 API Key 不应登记，应跳过 api_key_only_source。
	writeTestJSON(t, providersPath, map[string]any{
		"providers": map[string]any{
			"cline": map[string]any{
				"settings": map[string]any{"auth": map[string]any{"apiKey": "sk-cline-only"}},
			},
		},
	})
	detector := NewNativeDetector(h.newOptions())
	respOnlyKey := mustDetect(t, detector)
	if respOnlyKey.Updated != 0 || !hasSkipReason(respOnlyKey.Skipped, "api_key_only_source", "cline") {
		t.Fatalf("expected api_key_only_source, got resp=%#v", respOnlyKey)
	}

	// workos: JWT 首次注册 + 代际升级。
	makeClineDoc := func(iat int64) map[string]any {
		token := "workos:" + makeTestJWT(t, map[string]any{
			"sub":   "user_01CLINE",
			"email": "cline@example.com",
			"iat":   iat,
			"exp":   iat + 3600,
		})
		return map[string]any{
			"providers": map[string]any{
				"cline": map[string]any{
					"settings": map[string]any{
						"auth": map[string]any{
							"accessToken":  token,
							"refreshToken": "refresh-cline-1",
							"accountId":    "user_01CLINE",
							"email":        "cline@example.com",
						},
					},
				},
			},
		}
	}
	writeTestJSON(t, providersPath, makeClineDoc(h.now.Unix()-60))
	resp1 := mustDetect(t, detector)
	if resp1.Updated != 1 || resp1.Accounts["cline"] != 1 || !resp1.Registered[0].Created {
		t.Fatalf("expected cline created, got %#v", resp1)
	}

	writeTestJSON(t, providersPath, makeClineDoc(h.now.Unix()))
	resp2 := mustDetect(t, detector)
	if resp2.Updated != 1 || resp2.Registered[0].Created {
		t.Fatalf("expected cline update with created=false, got %#v", resp2)
	}
}

func TestNativeDetectorHostAuthProjectionAndTombstone(t *testing.T) {
	h := newDetectorTestHarness(t)
	codexAuthPath := filepath.Join(h.hostHomeDir, ".codex", "auth.json")
	writeTestJSON(t, codexAuthPath, map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"id_token": makeTestJWT(t, map[string]any{
				"email": "codex-host@example.com",
				"sub":   "auth0|codex-1",
				"https://api.openai.com/auth": map[string]any{
					"chatgpt_account_id": "acct-codex-1",
					"chatgpt_user_id":    "user-codex-1",
				},
			}),
			"access_token":  makeTestJWT(t, map[string]any{"sub": "auth0|codex-1", "exp": h.now.Unix() + 3600}),
			"refresh_token": "rt_codex_host_1",
			"account_id":    "acct-codex-1",
		},
	})

	detector := NewNativeDetector(h.newOptions())
	resp1 := mustDetect(t, detector)
	if resp1.Updated != 1 || resp1.Accounts["codex"] != 1 {
		t.Fatalf("expected codex host projection registered, got %#v", resp1)
	}
	registeredRef := accountcore.AccountRef(resp1.Registered[0].AccountRef)

	// 再次扫描保持只增不改。
	resp2 := mustDetect(t, detector)
	if resp2.Updated != 0 || !hasSkipReason(resp2.Skipped, "existing_account_unchanged", "codex") {
		t.Fatalf("expected existing_account_unchanged skip, got %#v", resp2)
	}

	// 删除账号写入墓碑后不得复活。
	if err := h.store.DeleteAccount(context.Background(), registeredRef); err != nil {
		t.Fatalf("DeleteAccount error = %v", err)
	}
	resp3 := mustDetect(t, detector)
	if resp3.Updated != 0 || resp3.Accounts["codex"] != 0 || !hasSkipReason(resp3.Skipped, "account_deleted_by_user", "codex") {
		t.Fatalf("expected account_deleted_by_user tombstone skip, got %#v", resp3)
	}
}

func TestNativeDetectorHostAPIKeyFilesAndSelfWriteGuard(t *testing.T) {
	h := newDetectorTestHarness(t)
	writeTestJSON(t, filepath.Join(h.aiHomeDir, "server.json"), map[string]any{
		"port":      19527,
		"clientKey": "aih-secret-client-key-999",
	})
	writeTestJSON(t, filepath.Join(h.hostHomeDir, ".codex", "auth.json"), map[string]any{
		"OPENAI_API_KEY": "sk-codex-host-key-1",
	})
	writeTestJSON(t, filepath.Join(h.hostHomeDir, ".claude", "settings.json"), map[string]any{
		"env": map[string]any{
			"ANTHROPIC_AUTH_TOKEN": "sk-ant-host-token-1",
			"ANTHROPIC_BASE_URL":   "https://api.example.com/anthropic",
		},
	})
	writeTestFile(t, filepath.Join(h.hostHomeDir, ".gemini", ".env"), []byte("GEMINI_API_KEY='gem-host-key-1'\n"))

	detector := NewNativeDetector(h.newOptions())
	resp1 := mustDetect(t, detector)
	if resp1.Updated != 3 || resp1.Accounts["codex"] != 1 || resp1.Accounts["claude"] != 1 || resp1.Accounts["gemini"] != 1 {
		t.Fatalf("expected 3 api key accounts, got %#v", resp1)
	}

	// 验证自写守卫：指向本地网关地址与携带 clientKey 的配置文件必须被拒绝。
	writeTestJSON(t, filepath.Join(h.hostHomeDir, ".codex", "auth.json"), map[string]any{
		"OPENAI_API_KEY": "aih-secret-client-key-999",
	})
	writeTestJSON(t, filepath.Join(h.hostHomeDir, ".claude", "settings.json"), map[string]any{
		"env": map[string]any{
			"ANTHROPIC_AUTH_TOKEN": "sk-ant-new-gateway",
			"ANTHROPIC_BASE_URL":   "http://127.0.0.1:19527/v1",
		},
	})
	// 删除 Gemini 账号写入 API Key 墓碑，保留同 Key 的 .gemini/.env 验证不会复活。
	var gemRef accountcore.AccountRef
	for _, r := range resp1.Registered {
		if r.Provider == "gemini" {
			gemRef = accountcore.AccountRef(r.AccountRef)
		}
	}
	if err := h.store.DeleteAccount(context.Background(), gemRef); err != nil {
		t.Fatalf("DeleteAccount(gemini) error = %v", err)
	}

	resp2 := mustDetect(t, detector)
	if resp2.Updated != 0 {
		t.Fatalf("expected 0 updates for guarded/tombstoned sources, got %#v", resp2)
	}
	if !hasSkipReason(resp2.Skipped, "aih_client_key_host_config", "codex") {
		t.Fatalf("expected aih_client_key_host_config, got %#v", resp2.Skipped)
	}
	if !hasSkipReason(resp2.Skipped, "aih_gateway_host_config", "claude") {
		t.Fatalf("expected aih_gateway_host_config, got %#v", resp2.Skipped)
	}
	if !hasSkipReason(resp2.Skipped, "account_deleted_by_user", "gemini") {
		t.Fatalf("expected account_deleted_by_user tombstone for gemini, got %#v", resp2.Skipped)
	}
}

func TestNativeDetectorHostEnvAPIKeysAndHTTPHandler(t *testing.T) {
	h := newDetectorTestHarness(t)
	env := map[string]string{
		"GEMINI_API_KEY":   "gem-env-key-1",
		"GOOGLE_API_KEY":   "gem-env-key-1", // 同 Key 去重
		"MOONSHOT_API_KEY": "ms-env-key-1",
		"OPENAI_API_KEY":   "sk-env-guarded",
		"OPENAI_BASE_URL":  "http://localhost:9527/v1",
	}
	detector := NewNativeDetector(h.newOptions(func(o *NativeDetectorOptions) {
		o.LookupEnv = func(k string) (string, bool) {
			v, ok := env[k]
			return v, ok
		}
		o.LoginShellEnv = func(_ context.Context, _ []string) (map[string]string, error) {
			return map[string]string{"KIMI_BASE_URL": "https://api.moonshot.cn/v1"}, nil
		}
	}))

	handler, err := webuiaccountdetectapi.NewHandler(webuiaccountdetectapi.Dependencies{
		Authorizer: allowTestAuthorizer{},
		Detector:   detector,
	})
	if err != nil {
		t.Fatalf("webuiaccountdetectapi.NewHandler error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, webuiaccountdetectapi.Path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	resp := decodeDetectResponse(t, rec.Code, rec.Body.Bytes())
	if !resp.OK || resp.Updated != 2 || resp.Accounts["gemini"] != 1 || resp.Accounts["kimi"] != 1 {
		t.Fatalf("expected deduplicated gemini + kimi from env, got %#v", resp)
	}
	if !hasSkipReason(resp.Skipped, "aih_gateway_host_config", "codex") {
		t.Fatalf("expected localhost:9527 self-write rejection for codex env, got %#v", resp.Skipped)
	}
	// Reload 未配置时应为 false。
	if resp.Reloaded {
		t.Fatalf("expected Reloaded=false when Reload callback is nil, got true")
	}
}

type allowTestAuthorizer struct{}

func (allowTestAuthorizer) Authorized(*http.Request) bool { return true }
