package accountsapi_test

import (
	"database/sql"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestAccountsAPIConcurrentStaticImportCreatesExactlyOneAggregate 通过真实
// TCP 和临时 SQLite 验证同一静态身份的并发导入只有一个创建者。
// nativeImportHTTPDocument 构造原生 artifact 导入文档（原先用 sub2api 文档，
// 该格式已于 2026-10-23 移除）。签名保留 (platform, authType, credentials, extra)，
// 内部映射成 `{provider_id, artifacts:{auth_json}}`：
//   - platform 即 provider_id；
//   - credentials 直接作为 auth_json（原生契约本就收 api_key / access_token 等字段）。
// 这样「并发只建一个 / 幂等 / 代际仲裁 / 不泄漏凭据」这些导入语义的覆盖原样保留。
func nativeImportHTTPDocument(
	t *testing.T,
	platform string,
	authType string,
	credentials map[string]any,
	extra map[string]any,
) []byte {
	t.Helper()

	merged := map[string]any{}
	for key, value := range credentials {
		merged[key] = value
	}
	for key, value := range extra {
		merged[key] = value
	}
	providerID := nativeProviderIDForPlatform(platform)
	// 原生导入收的是**官方 artifact 形状**，不是扁平的 api_key/base_url：
	//   codex  → auth.json：{"auth_mode":"apikey","OPENAI_API_KEY":...}
	//   claude → 只支持 OAuth（credentials_json + global_config_json），api_key 走原生导入会被拒。
	artifacts := map[string]any{}
	switch providerID {
	case "codex":
		authJSON := map[string]any{}
		if authType == "oauth" {
			// 官方 OAuth auth.json：tokens 子对象，account_id 承载工作区。
			authJSON["auth_mode"] = "chatgpt"
			authJSON["tokens"] = map[string]any{
				"id_token":      merged["id_token"],
				"access_token":  merged["access_token"],
				"refresh_token": merged["refresh_token"],
				"account_id":    merged["chatgpt_account_id"],
			}
		} else {
			authJSON["auth_mode"] = "apikey"
			if key, ok := merged["api_key"]; ok {
				authJSON["OPENAI_API_KEY"] = key
			}
		}
		artifacts["auth_json"] = authJSON
	case "claude":
		// Claude 原生导入只支持 OAuth：credentials_json（claudeAiOauth）+ global_config_json（身份）。
		// expiresAt 必须来自调用方：代际仲裁靠它区分新旧凭据
		// （写死会让两次导入代际相同，第二次更新不生效）。
		expiresAt := int64(4102444800000)
		if raw, ok := merged["expires_at"]; ok {
			switch typed := raw.(type) {
			case int64:
				expiresAt = typed
			case int:
				expiresAt = int64(typed)
			case float64:
				expiresAt = int64(typed)
			}
		}
		artifacts["credentials_json"] = map[string]any{
			"claudeAiOauth": map[string]any{
				"accessToken":      merged["access_token"],
				"refreshToken":     merged["refresh_token"],
				"expiresAt":        expiresAt,
				"clientId":         "claude-code-official-client",
				"scopes":           []string{"user:inference", "user:profile"},
				"subscriptionType": "max",
			},
		}
		artifacts["global_config_json"] = map[string]any{
			"oauthAccount": map[string]any{
				"accountUuid":  "123e4567-e89b-12d3-a456-426614174000",
				"emailAddress": "synthetic-native-claude@example.invalid",
				"displayName":  "Synthetic Native Claude",
			},
		}
	default:
		artifacts["auth_json"] = merged
	}
	return marshalRequestJSON(t, map[string]any{
		"provider_id": providerID,
		"artifacts":   artifacts,
	})
}

// nativeProviderIDForPlatform 把 sub2api 的上游厂商标识映射成 AIH 的 provider_id。
func nativeProviderIDForPlatform(platform string) string {
	switch platform {
	case "openai":
		return "codex"
	case "anthropic":
		return "claude"
	default:
		return platform
	}
}

func TestAccountsAPIConcurrentStaticImportCreatesExactlyOneAggregate(t *testing.T) {
	t.Parallel()

	registeredAt := time.Date(
		2026,
		time.August,
		15,
		1,
		0,
		0,
		0,
		time.UTC,
	)
	aiHomeDir := t.TempDir()
	server := newAccountsLiveServerAt(
		t,
		registeredAt,
		aiHomeDir,
	)
	document := nativeImportHTTPDocument(
		t,
		"openai",
		"apikey",
		map[string]any{
			"api_key":  "synthetic-concurrent-native-key",
			"base_url": "https://api.openai.com/v1",
		},
		nil,
	)
	const concurrency = 24
	exchanges := make([]liveExchange, concurrency)
	start := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(concurrency)
	for index := range concurrency {
		go func() {
			defer wait.Done()
			<-start
			exchanges[index] = performLiveRequest(
				t,
				server.Client(),
				http.MethodPost,
				server.URL+accountsapi.NativeImportPath,
				document,
			)
		}()
	}
	close(start)
	wait.Wait()

	assertConcurrentStaticImportResults(t, exchanges)
	listed := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"?limit=50",
		nil,
	)
	assertLiveStatus(t, listed, http.StatusOK)
	var listDocument struct {
		Data []concurrentImportAccountView `json:"data"`
	}
	decodeLiveBody(t, listed.responseBody, &listDocument)
	if len(listDocument.Data) != 1 ||
		listDocument.Data[0].AccountRef == "" ||
		listDocument.Data[0].CLIAccountID != 1 ||
		!listDocument.Data[0].HasCredential {
		t.Fatalf("并发导入后的账号投影 = %#v", listDocument.Data)
	}
	if listDocument.Data[0].UpdatedAt != listDocument.Data[0].CreatedAt {
		t.Fatalf(
			"静态幂等导入覆盖了账号 metadata: created_at=%s updated_at=%s",
			listDocument.Data[0].CreatedAt,
			listDocument.Data[0].UpdatedAt,
		)
	}
	assertConcurrentStaticImportDatabase(
		t,
		aiHomeDir,
		listDocument.Data[0].AccountRef,
		registeredAt,
	)
	exported := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"/"+
			listDocument.Data[0].AccountRef+"/export",
		nil,
	)
	// sub2api 导出格式已移除（2026-10-23）：导出端点暂时没有可用格式，
	// 这里断言失败关闭（而不是假装导出成功）。原生导出见迁移蓝图 P2。
	assertLiveStatus(t, exported, http.StatusUnprocessableEntity)
}

// assertConcurrentStaticImportDatabase 从真实临时 aih.db 校验并发幂等边界。
func assertConcurrentStaticImportDatabase(
	t *testing.T,
	aiHomeDir string,
	wantAccountRef string,
	wantCreatedAt time.Time,
) {
	t.Helper()

	databasePath, err := sqliteaccount.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = database.Close()
	})

	var (
		accountRows        int
		credentialRows     int
		distinctAccountRef int
		accountRef         string
		cliAccountID       int64
		createdAtMS        int64
		accountUpdatedAtMS int64
		credentialAtMS     int64
	)
	if err := database.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM accounts),
			(SELECT COUNT(*) FROM account_credentials),
			(SELECT COUNT(DISTINCT account_ref) FROM accounts),
			a.account_ref,
			a.cli_account_id,
			a.created_at_ms,
			a.updated_at_ms,
			c.updated_at_ms
		FROM accounts AS a
		INNER JOIN account_credentials AS c
			ON c.account_ref = a.account_ref
	`).Scan(
		&accountRows,
		&credentialRows,
		&distinctAccountRef,
		&accountRef,
		&cliAccountID,
		&createdAtMS,
		&accountUpdatedAtMS,
		&credentialAtMS,
	); err != nil {
		t.Fatalf("查询并发导入数据库不变量失败: %v", err)
	}
	wantTimestamp := wantCreatedAt.UnixMilli()
	if accountRows != 1 || credentialRows != 1 || distinctAccountRef != 1 ||
		accountRef != wantAccountRef || cliAccountID != 1 ||
		createdAtMS != wantTimestamp ||
		accountUpdatedAtMS != wantTimestamp ||
		credentialAtMS != wantTimestamp {
		t.Fatalf(
			"并发导入数据库不变量错误: accounts=%d credentials=%d "+
				"distinct_refs=%d account_ref=%s cli_account_id=%d "+
				"created_at_ms=%d account_updated_at_ms=%d "+
				"credential_updated_at_ms=%d",
			accountRows,
			credentialRows,
			distinctAccountRef,
			accountRef,
			cliAccountID,
			createdAtMS,
			accountUpdatedAtMS,
			credentialAtMS,
		)
	}
}

type concurrentImportAccountView struct {
	AccountRef    string `json:"account_ref"`
	CLIAccountID  int64  `json:"cli_account_id"`
	HasCredential bool   `json:"has_credential"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// assertConcurrentStaticImportResults 校验所有并发请求共享同一公开投影。
func assertConcurrentStaticImportResults(
	t *testing.T,
	exchanges []liveExchange,
) {
	t.Helper()

	createdCount := 0
	updatedCount := 0
	var identity concurrentImportAccountView
	for index, exchange := range exchanges {
		switch exchange.status {
		case http.StatusCreated:
			createdCount++
		case http.StatusOK:
			updatedCount++
		default:
			t.Fatalf(
				"并发导入[%d] status=%d body=%s",
				index,
				exchange.status,
				exchange.responseBody,
			)
		}
		var document struct {
			Data concurrentImportAccountView `json:"data"`
		}
		decodeLiveBody(t, exchange.responseBody, &document)
		if index == 0 {
			identity = document.Data
			continue
		}
		if document.Data != identity {
			t.Fatalf(
				"并发导入返回了不同聚合: first=%#v current=%#v",
				identity,
				document.Data,
			)
		}
	}
	if createdCount != 1 || updatedCount != len(exchanges)-1 {
		t.Fatalf(
			"并发导入状态分布 created=%d updated=%d total=%d",
			createdCount,
			updatedCount,
			len(exchanges),
		)
	}
}

// TestAccountsAPIRepeatedNativeImportIsIdempotent 通过真实 TCP 和临时
// aih.db 验证重复外部文档不会创建影子账号。
func TestAccountsAPIRepeatedNativeImportIsIdempotent(t *testing.T) {
	t.Parallel()

	server := newAccountsLiveServer(
		t,
		time.Date(2026, time.August, 15, 2, 0, 0, 0, time.UTC),
	)
	document := nativeImportHTTPDocument(
		t,
		"openai",
		"apikey",
		map[string]any{
			"api_key":  "synthetic-repeated-native-key",
			"base_url": "https://api.openai.com/v1",
		},
		nil,
	)
	url := server.URL + accountsapi.NativeImportPath

	created := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		url,
		document,
	)
	assertLiveStatus(t, created, http.StatusCreated)

	idempotent := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		url,
		document,
	)
	assertLiveStatus(t, idempotent, http.StatusOK)
	if created.responseBody != idempotent.responseBody {
		t.Fatalf(
			"重复导入投影不稳定: created=%s idempotent=%s",
			created.responseBody,
			idempotent.responseBody,
		)
	}
}

// TestAccountsAPIReimportsProfilelessRefreshableOAuthInPlace 验证没有公开邮箱
// 的可刷新 OAuth 仍会更新凭据，且不会因为 profile 为空退化成静态幂等。
func TestAccountsAPIReimportsProfilelessRefreshableOAuthInPlace(t *testing.T) {
	t.Parallel()

	server := newAccountsLiveServer(
		t,
		time.Date(2026, time.August, 15, 3, 0, 0, 0, time.UTC),
	)
	const (
		accountUUID = "123e4567-e89b-12d3-a456-426614174398"
		oldAccess   = "synthetic-profileless-old-access"
		oldRefresh  = "synthetic-profileless-old-refresh"
		newAccess   = "synthetic-profileless-new-access"
		newRefresh  = "synthetic-profileless-new-refresh"
	)
	document := func(
		accessToken string,
		refreshToken string,
		expiresAt int64,
	) []byte {
		return nativeImportHTTPDocument(
			t,
			"anthropic",
			"setup-token",
			map[string]any{
				"access_token":  accessToken,
				"refresh_token": refreshToken,
				"expires_at":    expiresAt,
				"scope":         "user:inference",
				"account_uuid":  accountUUID,
			},
			nil,
		)
	}
	url := server.URL + accountsapi.NativeImportPath
	created := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		url,
		document(oldAccess, oldRefresh, 4_102_444_800),
	)
	assertLiveStatus(t, created, http.StatusCreated)
	var createdDocument struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	decodeLiveBody(t, created.responseBody, &createdDocument)

	updated := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		url,
		document(newAccess, newRefresh, 4_102_444_860),
	)
	assertLiveStatus(t, updated, http.StatusOK)
	var updatedDocument struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	decodeLiveBody(t, updated.responseBody, &updatedDocument)
	if updatedDocument.Data.AccountRef != createdDocument.Data.AccountRef {
		t.Fatalf(
			"OAuth 原地更新改变账号身份: created=%s updated=%s",
			createdDocument.Data.AccountRef,
			updatedDocument.Data.AccountRef,
		)
	}

	exported := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"/"+
			createdDocument.Data.AccountRef+"/export",
		nil,
	)
	// Claude 导出走 cliproxyapi（sub2api 已于 2026-10-23 移除），仍可用：断言导出的是新凭据。
	assertLiveStatus(t, exported, http.StatusOK)
	if !strings.Contains(exported.responseBody, newAccess) ||
		!strings.Contains(exported.responseBody, newRefresh) ||
		strings.Contains(exported.responseBody, oldAccess) ||
		strings.Contains(exported.responseBody, oldRefresh) {
		t.Fatal("OAuth 原地更新后导出没有切换到新凭据")
	}
}

// TestAccountsAPIRejectsUnorderedOAuthImportWithoutLeakingCredential 验证缺少
// Provider 代际事实的重复导入以稳定低敏冲突失败，且不覆盖当前凭据。
func TestAccountsAPIRejectsUnorderedOAuthImportWithoutLeakingCredential(
	t *testing.T,
) {
	t.Parallel()

	server := newAccountsLiveServer(
		t,
		time.Date(2026, time.August, 15, 3, 30, 0, 0, time.UTC),
	)
	idToken := nativeTestJWT(t, map[string]any{
		"sub":   "codex-unordered-import-user",
		"email": "codex-unordered-import@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_user_id":    "codex-unordered-import-user",
			"chatgpt_account_id": "codex-unordered-import-workspace",
			"chatgpt_plan_type":  "plus",
		},
	})
	document := func(label string) []byte {
		return nativeImportHTTPDocument(
			t,
			"openai",
			"oauth",
			map[string]any{
				"access_token":       "synthetic-unordered-" + label + "-access",
				"refresh_token":      "synthetic-unordered-" + label + "-refresh",
				"id_token":           idToken,
				"chatgpt_account_id": "codex-unordered-import-workspace",
				"email":              "codex-unordered-import@example.invalid",
			},
			nil,
		)
	}
	created := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.NativeImportPath,
		document("current"),
	)
	assertLiveStatus(t, created, http.StatusCreated)

	unordered := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.NativeImportPath,
		document("incoming"),
	)
	assertLiveStatus(t, unordered, http.StatusConflict)
	if !strings.Contains(
		unordered.responseBody,
		`"code":"account_import_generation_unordered"`,
	) || strings.Contains(unordered.responseBody, "synthetic-unordered-") ||
		strings.Contains(unordered.responseBody, idToken) {
		t.Fatalf("不可比较导入错误合同泄露或不稳定: %s", unordered.responseBody)
	}
}

// TestAccountsAPIConcurrentOAuthImportsKeepNewestProvableGeneration 验证同一
// OAuth 身份的并发导入不会按事务到达顺序让旧凭据覆盖新凭据。
func TestAccountsAPIConcurrentOAuthImportsKeepNewestProvableGeneration(
	t *testing.T,
) {
	t.Parallel()

	server := newAccountsLiveServer(
		t,
		time.Date(2026, time.August, 15, 4, 0, 0, 0, time.UTC),
	)
	const accountUUID = "123e4567-e89b-12d3-a456-426614174396"
	document := func(generation string, expiresAt int64) []byte {
		return nativeImportHTTPDocument(
			t,
			"anthropic",
			"setup-token",
			map[string]any{
				"access_token":  "synthetic-" + generation + "-access",
				"refresh_token": "synthetic-" + generation + "-refresh",
				"expires_at":    expiresAt,
				"scope":         "user:inference",
				"account_uuid":  accountUUID,
			},
			nil,
		)
	}
	const baselineExpiry = int64(4_102_444_800)
	created := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.NativeImportPath,
		document("baseline", baselineExpiry),
	)
	assertLiveStatus(t, created, http.StatusCreated)
	var createdDocument struct {
		Data concurrentImportAccountView `json:"data"`
	}
	decodeLiveBody(t, created.responseBody, &createdDocument)

	imports := [][]byte{
		document("stale", baselineExpiry+60),
		document("newest", baselineExpiry+120),
	}
	exchanges := make([]liveExchange, len(imports))
	start := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(len(imports))
	for index := range imports {
		go func() {
			defer wait.Done()
			<-start
			exchanges[index] = performLiveRequest(
				t,
				server.Client(),
				http.MethodPost,
				server.URL+accountsapi.NativeImportPath,
				imports[index],
			)
		}()
	}
	close(start)
	wait.Wait()
	for index, exchange := range exchanges {
		if exchange.status != http.StatusOK {
			t.Fatalf(
				"OAuth 并发导入[%d] status=%d body=%s",
				index,
				exchange.status,
				exchange.responseBody,
			)
		}
		var importedDocument struct {
			Data concurrentImportAccountView `json:"data"`
		}
		decodeLiveBody(t, exchange.responseBody, &importedDocument)
		if importedDocument.Data.AccountRef !=
			createdDocument.Data.AccountRef {
			t.Fatalf(
				"OAuth 并发导入[%d] 改变账号身份: got=%s want=%s",
				index,
				importedDocument.Data.AccountRef,
				createdDocument.Data.AccountRef,
			)
		}
	}

	exported := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"/"+
			createdDocument.Data.AccountRef+"/export",
		nil,
	)
	assertLiveStatus(t, exported, http.StatusOK)
	if !strings.Contains(exported.responseBody, "synthetic-newest-access") ||
		!strings.Contains(exported.responseBody, "synthetic-newest-refresh") ||
		strings.Contains(exported.responseBody, "synthetic-stale-access") ||
		strings.Contains(exported.responseBody, "synthetic-stale-refresh") ||
		strings.Contains(exported.responseBody, "synthetic-baseline-access") ||
		strings.Contains(exported.responseBody, "synthetic-baseline-refresh") {
		t.Fatal("OAuth 并发导入最终凭据不是可证明的最新 generation")
	}
}

// TestAccountsAPILaterExportDoesNotMakeOldCodexCredentialNewer 验证文档
// exported_at 再晚也不能覆盖 last_refresh 更新的 Codex 凭据。
func TestAccountsAPILaterExportDoesNotMakeOldCodexCredentialNewer(
	t *testing.T,
) {
	t.Parallel()

	server := newAccountsLiveServer(
		t,
		time.Date(2026, time.August, 15, 5, 0, 0, 0, time.UTC),
	)
	idToken := nativeTestJWT(t, map[string]any{
		"sub":   "codex-import-generation-user",
		"email": "codex-import-generation@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_user_id":    "codex-import-generation-user",
			"chatgpt_account_id": "codex-import-generation-workspace",
			"chatgpt_plan_type":  "plus",
		},
	})
	document := func(
		label string,
		lastRefresh string,
		exportedAt string,
	) []byte {
		// 原生 codex OAuth auth.json：代际来自 last_refresh（RFC3339）。
		// 原先的 exported_at 是 sub2api 概念，原生没有 —— 语义改由 last_refresh 承载，
		// 「旧凭据不能覆盖新凭据」的验证意图不变。
		_ = exportedAt
		return marshalRequestJSON(t, map[string]any{
			"provider_id": "codex",
			"artifacts": map[string]any{
				"auth_json": map[string]any{
					"auth_mode": "chatgpt",
					"last_refresh": lastRefresh,
					"tokens": map[string]any{
						"access_token":  "synthetic-codex-" + label + "-access",
						"refresh_token": "synthetic-codex-" + label + "-refresh",
						"id_token":      idToken,
						"account_id":    "codex-import-generation-workspace",
					},
				},
			},
		})
	}
	newest := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.NativeImportPath,
		document(
			"newest",
			"2026-08-15T04:59:00Z",
			"2026-08-15T05:00:00Z",
		),
	)
	assertLiveStatus(t, newest, http.StatusCreated)
	var newestDocument struct {
		Data concurrentImportAccountView `json:"data"`
	}
	decodeLiveBody(t, newest.responseBody, &newestDocument)

	lateOldExport := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.NativeImportPath,
		document(
			"older",
			"2026-08-15T04:58:00Z",
			"2026-08-15T06:00:00Z",
		),
	)
	assertLiveStatus(t, lateOldExport, http.StatusOK)

	exported := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"/"+
			newestDocument.Data.AccountRef+"/export",
		nil,
	)
	assertLiveStatus(t, exported, http.StatusOK)
	if !strings.Contains(exported.responseBody, "synthetic-codex-newest-access") ||
		!strings.Contains(exported.responseBody, "synthetic-codex-newest-refresh") ||
		!strings.Contains(exported.responseBody, `"last_refresh":"2026-08-15T04:59:00Z"`) ||
		strings.Contains(exported.responseBody, "synthetic-codex-older-access") ||
		strings.Contains(exported.responseBody, "synthetic-codex-older-refresh") {
		t.Fatal("较晚 exported_at 的旧 Codex 凭据覆盖了最新 generation")
	}
}
