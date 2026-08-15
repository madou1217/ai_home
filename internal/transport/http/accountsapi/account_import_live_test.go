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
	document := sub2APIHTTPDocument(
		t,
		"openai",
		"apikey",
		map[string]any{
			"api_key":  "synthetic-concurrent-sub2api-key",
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
				server.URL+accountsapi.Sub2APIImportPath,
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
	assertLiveStatus(t, exported, http.StatusOK)
	if strings.Count(exported.responseBody, "synthetic-concurrent-sub2api-key") != 1 {
		t.Fatal("并发导入后的单账号导出没有且仅有一份静态凭据")
	}
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

// TestAccountsAPIRepeatedSub2APIImportIsIdempotent 通过真实 TCP 和临时
// aih.db 验证重复外部文档不会创建影子账号。
func TestAccountsAPIRepeatedSub2APIImportIsIdempotent(t *testing.T) {
	t.Parallel()

	server := newAccountsLiveServer(
		t,
		time.Date(2026, time.August, 15, 2, 0, 0, 0, time.UTC),
	)
	document := sub2APIHTTPDocument(
		t,
		"openai",
		"apikey",
		map[string]any{
			"api_key":  "synthetic-repeated-sub2api-key",
			"base_url": "https://api.openai.com/v1",
		},
		nil,
	)
	url := server.URL + accountsapi.Sub2APIImportPath

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
		return sub2APIHTTPDocument(
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
	url := server.URL + accountsapi.Sub2APIImportPath
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
		return sub2APIHTTPDocument(
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
		server.URL+accountsapi.Sub2APIImportPath,
		document("current"),
	)
	assertLiveStatus(t, created, http.StatusCreated)

	unordered := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.Sub2APIImportPath,
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
		return sub2APIHTTPDocument(
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
		server.URL+accountsapi.Sub2APIImportPath,
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
				server.URL+accountsapi.Sub2APIImportPath,
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
		return marshalRequestJSON(t, map[string]any{
			"type":        "sub2api-data",
			"exported_at": exportedAt,
			"proxies":     []any{},
			"accounts": []any{map[string]any{
				"name":     "codex-import-generation",
				"platform": "openai",
				"type":     "oauth",
				"credentials": map[string]any{
					"access_token":       "synthetic-codex-" + label + "-access",
					"refresh_token":      "synthetic-codex-" + label + "-refresh",
					"id_token":           idToken,
					"last_refresh":       lastRefresh,
					"chatgpt_account_id": "codex-import-generation-workspace",
					"plan_type":          "plus",
					"email":              "codex-import-generation@example.invalid",
				},
				"concurrency": 0,
				"priority":    0,
			}},
		})
	}
	newest := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountsapi.Sub2APIImportPath,
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
		server.URL+accountsapi.Sub2APIImportPath,
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
