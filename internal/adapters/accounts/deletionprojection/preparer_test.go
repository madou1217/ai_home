package deletionprojection_test

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

type memoryCredentialStore struct {
	snapshot     accountapp.CredentialSnapshot
	replacements int
}

func (store *memoryCredentialStore) GetCredentialSnapshot(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	return store.snapshot, nil
}

func (store *memoryCredentialStore) ReplaceCredential(
	_ context.Context,
	replacement accountapp.CredentialReplacement,
) error {
	snapshot, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		replacement.Credential().ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = snapshot
	store.replacements++
	return nil
}

func realDir(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func mustCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func mustNativeCredential(t *testing.T, providerID, payload string) *accountcore.NativeCredential {
	t.Helper()
	decoded, err := nativeaccount.NewDecoder().DecodeNativeAuth(providerID, []byte(payload))
	if err != nil {
		t.Fatalf("解码 %s 原生凭据: %v", providerID, err)
	}
	credential, ok := decoded.(*accountcore.NativeCredential)
	if !ok || credential == nil {
		t.Fatalf("%s 凭据不是 NativeCredential", providerID)
	}
	return credential
}

func mustAccount(t *testing.T, catalog *providers.Catalog, credential accountapp.Credential) accountcore.Account {
	t.Helper()
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: 1,
		CreatedAt:    time.UnixMilli(1000).UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return account
}

func writeFile(t *testing.T, filePath, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, filePath string) string {
	t.Helper()
	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func geminiNativePayload(accessToken, refreshToken string, expiryDate int64) string {
	return fmt.Sprintf(
		`{"googleAccounts":{"active":"user@example.invalid"},"oauthCreds":{"access_token":%q,"refresh_token":%q,"expiry_date":%d}}`,
		accessToken,
		refreshToken,
		expiryDate,
	)
}

func jwtWithIssuedAt(seconds int64) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(
		`{"iat":%d,"exp":%d}`,
		seconds,
		seconds+3600,
	)))
	return header + "." + payload + ".signature"
}

// grokAuthFile 是 ~/.grok/auth.json 的落盘形态：文件本身就是 profile map，
// 数据库里的 native_auth_json 才把它包在 "auth" 字段下。
func grokAuthFile(key, refreshToken string) string {
	return fmt.Sprintf(
		`{"default":{"user_id":"contract-user-a","key":%q,"refresh_token":%q}}`,
		key,
		refreshToken,
	)
}

func grokNativePayload(key, refreshToken string) string {
	return fmt.Sprintf(`{"auth":%s}`, grokAuthFile(key, refreshToken))
}

func projectionRoot(aiHome, providerID, accountRef string) string {
	return filepath.Join(aiHome, "run", "auth-projections", providerID, accountRef)
}

func TestGeminiDeletionOnlyRemovesProjectionAndAdoptsNewerCredential(t *testing.T) {
	ctx := context.Background()
	aiHome := realDir(t)
	hostHome := realDir(t)
	catalog := mustCatalog(t)

	stored := mustNativeCredential(t, "gemini", geminiNativePayload(
		"old-access", "old-refresh", 1_700_000_000_000,
	))
	account := mustAccount(t, catalog, stored)
	root := projectionRoot(aiHome, "gemini", account.Ref().String())
	writeFile(t, filepath.Join(root, ".gemini", "oauth_creds.json"), `{"access_token":"new-access","refresh_token":"new-refresh","expiry_date":1700003600000}`)
	writeFile(t, filepath.Join(root, ".gemini", "google_accounts.json"), `{"active":"user@example.invalid"}`)

	hostOAuth := filepath.Join(hostHome, ".gemini", "oauth_creds.json")
	hostAccounts := filepath.Join(hostHome, ".gemini", "google_accounts.json")
	hostProjects := filepath.Join(hostHome, ".gemini", "projects.json")
	writeFile(t, hostOAuth, `{"access_token":"host-access"}`)
	writeFile(t, hostAccounts, `{"active":"host@example.invalid"}`)
	writeFile(t, hostProjects, `{"projects":["host"]}`)
	if err := os.Symlink(hostProjects, filepath.Join(root, ".gemini", "projects.json")); err != nil {
		t.Fatal(err)
	}
	beforeOAuth := readFile(t, hostOAuth)
	beforeAccounts := readFile(t, hostAccounts)
	beforeProjects := readFile(t, hostProjects)

	snapshot, err := accountapp.NewCredentialSnapshot(
		account.Ref(), "gemini", stored, time.UnixMilli(1000).UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	credentials := &memoryCredentialStore{snapshot: snapshot}
	preparer, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Credentials: credentials,
		Clock:       func() time.Time { return time.UnixMilli(2000).UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := preparer.PrepareAccountDeletion(ctx, account); err != nil {
		t.Fatalf("删除准备失败: %v", err)
	}

	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("投影应被删除, lstat err = %v", err)
	}
	if readFile(t, hostOAuth) != beforeOAuth ||
		readFile(t, hostAccounts) != beforeAccounts ||
		readFile(t, hostProjects) != beforeProjects {
		t.Fatal("宿主 ~/.gemini 文件被修改")
	}
	if credentials.replacements != 1 {
		t.Fatalf("CAS 采纳次数 = %d, want 1", credentials.replacements)
	}
	current := credentials.snapshot.Credential().(*accountcore.NativeCredential)
	payload := string(current.Payload())
	if !strings.Contains(payload, "new-access") || strings.Contains(payload, "old-access") {
		t.Fatalf("数据库凭据未采纳投影的新版本: %s", payload)
	}
}

func TestGeminiDeletionDoesNotReplaceOlderProjectionCredential(t *testing.T) {
	ctx := context.Background()
	aiHome := realDir(t)
	hostHome := realDir(t)
	catalog := mustCatalog(t)

	stored := mustNativeCredential(t, "gemini", geminiNativePayload(
		"db-access", "db-refresh", 1_700_003_600_000,
	))
	account := mustAccount(t, catalog, stored)
	root := projectionRoot(aiHome, "gemini", account.Ref().String())
	writeFile(t, filepath.Join(root, ".gemini", "oauth_creds.json"), `{"access_token":"stale-access","refresh_token":"stale-refresh","expiry_date":1700000000000}`)
	writeFile(t, filepath.Join(root, ".gemini", "google_accounts.json"), `{"active":"user@example.invalid"}`)

	snapshot, err := accountapp.NewCredentialSnapshot(
		account.Ref(), "gemini", stored, time.UnixMilli(1000).UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	credentials := &memoryCredentialStore{snapshot: snapshot}
	preparer, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Credentials: credentials,
		Clock:       func() time.Time { return time.UnixMilli(2000).UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := preparer.PrepareAccountDeletion(ctx, account); err != nil {
		t.Fatalf("删除准备失败: %v", err)
	}
	if credentials.replacements != 0 {
		t.Fatalf("旧投影不应覆盖数据库凭据, replacements = %d", credentials.replacements)
	}
	current := credentials.snapshot.Credential().(*accountcore.NativeCredential)
	if !strings.Contains(string(current.Payload()), "db-access") {
		t.Fatal("数据库凭据被旧投影改写")
	}
}

func TestGrokDeletionOnlyRemovesProjectionAndKeepsHost(t *testing.T) {
	ctx := context.Background()
	aiHome := realDir(t)
	hostHome := realDir(t)
	catalog := mustCatalog(t)

	stored := mustNativeCredential(t, "grok", grokNativePayload(
		jwtWithIssuedAt(1_700_000_000), "old-refresh",
	))
	account := mustAccount(t, catalog, stored)
	root := projectionRoot(aiHome, "grok", account.Ref().String())
	writeFile(t, filepath.Join(root, ".grok", "auth.json"), grokAuthFile(
		jwtWithIssuedAt(1_700_000_100), "new-refresh",
	))

	hostAuth := filepath.Join(hostHome, ".grok", "auth.json")
	writeFile(t, hostAuth, grokAuthFile(jwtWithIssuedAt(1_600_000_000), "host-refresh"))
	beforeAuth := readFile(t, hostAuth)

	snapshot, err := accountapp.NewCredentialSnapshot(
		account.Ref(), "grok", stored, time.UnixMilli(1000).UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	credentials := &memoryCredentialStore{snapshot: snapshot}
	preparer, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Credentials: credentials,
		Clock:       func() time.Time { return time.UnixMilli(2000).UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := preparer.PrepareAccountDeletion(ctx, account); err != nil {
		t.Fatalf("删除准备失败: %v", err)
	}

	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("投影应被删除, lstat err = %v", err)
	}
	if readFile(t, hostAuth) != beforeAuth {
		t.Fatal("宿主 ~/.grok 文件被修改")
	}
	if credentials.replacements != 1 {
		t.Fatalf("CAS 采纳次数 = %d, want 1", credentials.replacements)
	}
	current := credentials.snapshot.Credential().(*accountcore.NativeCredential)
	if !strings.Contains(string(current.Payload()), "new-refresh") {
		t.Fatal("数据库凭据未采纳 grok 投影的新版本")
	}
}

func TestGeminiAndGrokDeletionWriteTombstoneAndAllowExplicitImport(t *testing.T) {
	for _, testCase := range []struct {
		provider        string
		payload         string
		writeProjection func(t *testing.T, root string)
	}{
		{
			provider: "gemini",
			payload:  geminiNativePayload("tombstone-access", "tombstone-refresh", 1_700_000_000_000),
			writeProjection: func(t *testing.T, root string) {
				writeFile(t, filepath.Join(root, ".gemini", "oauth_creds.json"),
					`{"access_token":"tombstone-access","refresh_token":"tombstone-refresh","expiry_date":1700000000000}`)
				writeFile(t, filepath.Join(root, ".gemini", "google_accounts.json"),
					`{"active":"user@example.invalid"}`)
			},
		},
		{
			provider: "grok",
			payload:  grokNativePayload(jwtWithIssuedAt(1_700_000_000), "tombstone-refresh"),
			writeProjection: func(t *testing.T, root string) {
				writeFile(t, filepath.Join(root, ".grok", "auth.json"),
					grokAuthFile(jwtWithIssuedAt(1_700_000_000), "tombstone-refresh"))
			},
		},
	} {
		t.Run(testCase.provider, func(t *testing.T) {
			ctx := context.Background()
			aiHome := realDir(t)
			hostHome := realDir(t)
			catalog := mustCatalog(t)
			store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
				AIHomeDir: aiHome,
				Catalog:   catalog,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()

			credential := mustNativeCredential(t, testCase.provider, testCase.payload)
			clock := func() time.Time { return time.UnixMilli(1000).UTC() }
			registrar, err := accountapp.NewRegistrar(catalog, store, clock)
			if err != nil {
				t.Fatal(err)
			}
			account, err := registrar.Register(ctx, credential, nil)
			if err != nil {
				t.Fatal(err)
			}
			testCase.writeProjection(t, projectionRoot(aiHome, testCase.provider, account.Ref().String()))

			preparer, err := deletionprojection.New(deletionprojection.Options{
				AIHomeDir:   aiHome,
				HostHomeDir: hostHome,
				Credentials: store,
				Clock:       func() time.Time { return time.UnixMilli(5000).UTC() },
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := preparer.PrepareAccountDeletion(ctx, account); err != nil {
				t.Fatalf("删除准备失败: %v", err)
			}
			if err := store.DeleteAccount(ctx, account.Ref()); err != nil {
				t.Fatal(err)
			}
			tombstoned, err := store.IsAccountTombstoned(ctx, account.Ref().String())
			if err != nil || !tombstoned {
				t.Fatalf("账号墓碑 = %v, %v", tombstoned, err)
			}
			// 显式导入是用户重新添加账号的路径，不能被墓碑挡住；
			// 墓碑只用于阻止宿主扫描把已删账号自动复活。
			if _, err := registrar.Register(ctx, credential, nil); err != nil {
				t.Fatalf("显式导入恢复失败: %v", err)
			}
			if _, err := store.GetByRef(ctx, account.Ref()); err != nil {
				t.Fatalf("恢复后的账号不可读: %v", err)
			}
		})
	}
}

// jwtWithSubject 生成带 sub 的 JWT；cline / opencode 的身份都从 sub 派生。
func jwtWithSubject(seconds int64, subject string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(
		`{"iat":%d,"exp":%d,"sub":%q}`,
		seconds,
		seconds+3600,
		subject,
	)))
	return header + "." + payload + ".signature"
}

// clineProvidersDocument 是 providers.json 的整库形态；入库前必须收窄。
func clineProvidersDocument(accessToken, refreshToken string, expiresAt int64) string {
	return fmt.Sprintf(
		`{"version":1,"lastUsedProvider":"cline","providers":{"cline":{"settings":{"auth":{"accessToken":%q,"refreshToken":%q,"expiresAt":%d}}}}}`,
		accessToken,
		refreshToken,
		expiresAt,
	)
}

func clineNativePayload(accessToken, refreshToken string) string {
	return fmt.Sprintf(`{"auth":%s}`, clineProvidersDocument(accessToken, refreshToken, 1_700_000_000_000))
}

// openCodeAuthFile 是 ~/.local/share/opencode/auth.json 的落盘形态。
func openCodeAuthFile(access, refresh, accountID string) string {
	return fmt.Sprintf(
		`{"opencode":{"type":"oauth","access":%q,"refresh":%q,"metadata":{"accountID":%q}}}`,
		access,
		refresh,
		accountID,
	)
}

func openCodeNativePayload(access, refresh, accountID string) string {
	return fmt.Sprintf(`{"auth":%s}`, openCodeAuthFile(access, refresh, accountID))
}

func qoderNativePayload(credentials string) string {
	return fmt.Sprintf(
		`{"credentials":%q,"machineId":"11111111-2222-3333-4444-555555555555","userInfo":{"uid":"0f1e2d3c-0000-4000-8000-000000000002","email":"q@example.com"}}`,
		credentials,
	)
}

// TestFileSystemProviderDeletionOnlyRemovesProjection 覆盖本批四家的真实落点：
// 删除后投影根消失，宿主同名文件逐字节不变；可比较代际的 cline/opencode
// 采纳投影里的新凭据，qoder 家族在代际不可比较时保持库内版本（fail-closed）。
func TestFileSystemProviderDeletionOnlyRemovesProjection(t *testing.T) {
	const hostMachineID = "11111111-2222-3333-4444-555555555555"
	tests := []struct {
		provider         string
		stored           string
		projection       func(t *testing.T, root string)
		hostPath         []string
		hostContent      string
		wantReplacements int
		assertPayload    func(t *testing.T, payload string)
	}{
		{
			provider: "cline",
			stored: clineNativePayload(
				"workos:"+jwtWithSubject(1_700_000_000, "user_cline"),
				"old-refresh",
			),
			projection: func(t *testing.T, root string) {
				writeFile(t, filepath.Join(root, ".cline", "data", "settings", "providers.json"),
					fmt.Sprintf(
						`{"version":1,"lastUsedProvider":"cline","providers":{"cline":{"settings":{"auth":{"accessToken":"workos:%s","refreshToken":"new-refresh","expiresAt":1700003600000}}},"anthropic":{"settings":{"apiKey":"foreign-secret"}}}}`,
						jwtWithSubject(1_700_000_100, "user_cline"),
					))
				writeFile(t, filepath.Join(root, ".cline", "data", "secrets.json"),
					`{"apiKey":"account-secret"}`)
			},
			hostPath:         []string{".cline", "data", "settings", "providers.json"},
			hostContent:      `{"providers":{"cline":{"settings":{"apiKey":"host-key"}}}}`,
			wantReplacements: 1,
			assertPayload: func(t *testing.T, payload string) {
				t.Helper()
				if !strings.Contains(payload, "new-refresh") {
					t.Fatalf("cline 未采纳投影里的新 refresh token: %s", payload)
				}
				if strings.Contains(payload, "foreign-secret") || strings.Contains(payload, "account-secret") {
					t.Fatalf("cline 投影收窄失败，混入了其它槽位/CLI 密钥: %s", payload)
				}
			},
		},
		{
			provider: "opencode",
			stored: openCodeNativePayload(
				jwtWithSubject(1_700_000_000, "acc_1"),
				"old-refresh",
				"acc_1",
			),
			projection: func(t *testing.T, root string) {
				canonical := filepath.Join(root, ".local", "share", "opencode", "auth.json")
				writeFile(t, canonical, openCodeAuthFile(
					jwtWithSubject(1_700_000_100, "acc_1"),
					"new-refresh",
					"acc_1",
				))
				// XDG 桥接目录里是指向 canonical 的软链；删除只能摘链接，不能跟过去。
				bridge := filepath.Join(root, ".local", "share", "aih-opencode-runtime", "opencode", "auth.json")
				if err := os.MkdirAll(filepath.Dir(bridge), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(canonical, bridge); err != nil {
					t.Fatal(err)
				}
				writeFile(t, filepath.Join(root, ".config", "opencode", "auth.json"),
					openCodeAuthFile(jwtWithSubject(1_600_000_000, "acc_1"), "backup-refresh", "acc_1"))
			},
			hostPath:         []string{".local", "share", "opencode", "auth.json"},
			hostContent:      `{"opencode":{"type":"api","key":"host-key"}}`,
			wantReplacements: 1,
			assertPayload: func(t *testing.T, payload string) {
				t.Helper()
				if !strings.Contains(payload, "new-refresh") || strings.Contains(payload, "backup-refresh") {
					t.Fatalf("opencode 应采用 canonical auth.json 而不是旧备份: %s", payload)
				}
			},
		},
		{
			provider: "qoder",
			stored:   qoderNativePayload("opaque-old"),
			projection: func(t *testing.T, root string) {
				writeFile(t, filepath.Join(root, ".auth", "user"), "opaque-new")
				writeFile(t, filepath.Join(root, ".auth", "machine_id"), hostMachineID)
				writeFile(t, filepath.Join(root, ".cache", "dns-cache.json"), `{"hosts":{}}`)
			},
			hostPath:         []string{".qoder", ".auth", "user"},
			hostContent:      "host-opaque-credential",
			wantReplacements: 0,
			assertPayload: func(t *testing.T, payload string) {
				t.Helper()
				if !strings.Contains(payload, "opaque-old") {
					t.Fatalf("qoder 代际不可比较时不应改写库内凭据: %s", payload)
				}
			},
		},
		{
			provider: "qodercn",
			stored:   qoderNativePayload("opaque-cn-old"),
			projection: func(t *testing.T, root string) {
				writeFile(t, filepath.Join(root, ".auth", "user"), "opaque-cn-new")
				writeFile(t, filepath.Join(root, ".auth", "machine_id"), hostMachineID)
			},
			hostPath:         []string{".qoder-cn", ".auth", "user"},
			hostContent:      "host-opaque-cn-credential",
			wantReplacements: 0,
			assertPayload: func(t *testing.T, payload string) {
				t.Helper()
				if !strings.Contains(payload, "opaque-cn-old") {
					t.Fatalf("qodercn 代际不可比较时不应改写库内凭据: %s", payload)
				}
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.provider, func(t *testing.T) {
			ctx := context.Background()
			aiHome := realDir(t)
			hostHome := realDir(t)
			catalog := mustCatalog(t)

			stored := mustNativeCredential(t, testCase.provider, testCase.stored)
			account := mustAccount(t, catalog, stored)
			root := projectionRoot(aiHome, testCase.provider, account.Ref().String())
			testCase.projection(t, root)

			hostFile := filepath.Join(append([]string{hostHome}, testCase.hostPath...)...)
			writeFile(t, hostFile, testCase.hostContent)
			beforeHost := readFile(t, hostFile)

			snapshot, err := accountapp.NewCredentialSnapshot(
				account.Ref(), testCase.provider, stored, time.UnixMilli(1000).UTC(),
			)
			if err != nil {
				t.Fatal(err)
			}
			credentials := &memoryCredentialStore{snapshot: snapshot}
			preparer, err := deletionprojection.New(deletionprojection.Options{
				AIHomeDir:   aiHome,
				HostHomeDir: hostHome,
				Credentials: credentials,
				Clock:       func() time.Time { return time.UnixMilli(2000).UTC() },
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := preparer.PrepareAccountDeletion(ctx, account); err != nil {
				t.Fatalf("删除准备失败: %v", err)
			}

			if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("投影应被删除, lstat err = %v", err)
			}
			if readFile(t, hostFile) != beforeHost {
				t.Fatalf("宿主 %s 被修改", filepath.Join(testCase.hostPath...))
			}
			if credentials.replacements != testCase.wantReplacements {
				t.Fatalf("CAS 采纳次数 = %d, want %d", credentials.replacements, testCase.wantReplacements)
			}
			current := credentials.snapshot.Credential().(*accountcore.NativeCredential)
			testCase.assertPayload(t, string(current.Payload()))
		})
	}
}
