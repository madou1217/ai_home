package webuimodelsyncapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
)

const (
	testRefCodex  = "acct_0123456789abcdef0123"
	testRefClaude = "acct_fedcba9876543210fedc"
	testRefQoder  = "acct_11112222333344445555"
	testNodeRef   = "node-codex-legacy-ref"
)

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

type policyCall struct {
	ref     accountcore.AccountRef
	modelID runtimecore.ModelID
	policy  accountapp.ModelManualPolicy
}

type fakeStore struct {
	mu          sync.Mutex
	catalog     accountapp.AccountModelCatalog
	overviews   []accountapp.AccountOverview
	aliases     []modelalias.Record
	policyCalls []policyCall
}

func (fake *fakeStore) ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	sets := make([]accountapp.AccountModelSet, len(fake.catalog.Sets))
	for i, set := range fake.catalog.Sets {
		modelsCopy := append([]accountapp.AccountModel(nil), set.Models...)
		set.Models = modelsCopy
		sets[i] = set
	}
	return accountapp.AccountModelCatalog{
		Sets:        sets,
		Generation:  fake.catalog.Generation,
		UpdatedAtMS: fake.catalog.UpdatedAtMS,
	}, nil
}

func (fake *fakeStore) ListAccountOverviews(_ context.Context, query accountapp.OverviewQuery) ([]accountapp.AccountOverview, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	var out []accountapp.AccountOverview
	for _, ov := range fake.overviews {
		if query.AfterRef() != "" && ov.Account().Ref() <= query.AfterRef() {
			continue
		}
		out = append(out, ov)
		if len(out) >= query.Limit() {
			break
		}
	}
	return out, nil
}

func (fake *fakeStore) GetAccountOverview(_ context.Context, ref accountcore.AccountRef) (accountapp.AccountOverview, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	for _, ov := range fake.overviews {
		if ov.Account().Ref() == ref {
			return ov, nil
		}
	}
	return accountapp.AccountOverview{}, accountapp.ErrAccountNotFound
}

func (fake *fakeStore) SetManualModelPolicy(
	_ context.Context,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
	policy accountapp.ModelManualPolicy,
	updatedAt time.Time,
) ([]accountapp.AccountModel, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.policyCalls = append(fake.policyCalls, policyCall{
		ref:     accountRef,
		modelID: modelID,
		policy:  policy,
	})
	for idx := range fake.catalog.Sets {
		set := &fake.catalog.Sets[idx]
		if set.AccountRef != accountRef {
			continue
		}
		found := false
		for mIdx, existing := range set.Models {
			if existing.ModelID() == modelID {
				updated, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
					AccountRef:        accountRef,
					ModelID:           modelID.String(),
					UpstreamAvailable: existing.UpstreamAvailable(),
					ManualPolicy:      policy,
					UpdatedAt:         updatedAt,
				})
				if err != nil {
					return nil, err
				}
				set.Models[mIdx] = updated
				found = true
				break
			}
		}
		if !found && policy != accountapp.ModelPolicyInherit {
			created, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
				AccountRef:        accountRef,
				ModelID:           modelID.String(),
				UpstreamAvailable: false,
				ManualPolicy:      policy,
				UpdatedAt:         updatedAt,
			})
			if err != nil {
				return nil, err
			}
			set.Models = append(set.Models, created)
		}
		fake.catalog.Generation++
		fake.catalog.UpdatedAtMS = updatedAt.UnixMilli()
		return append([]accountapp.AccountModel(nil), set.Models...), nil
	}
	return nil, accountapp.ErrAccountNotFound
}

func (fake *fakeStore) ListModelAliases(context.Context) ([]modelalias.Record, int64, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]modelalias.Record(nil), fake.aliases...), 1, nil
}

type fakeRefresher struct {
	mu      sync.Mutex
	calls   []accountcore.AccountRef
	blockCh chan struct{}
	errByID map[accountcore.AccountRef]error
	onCall  func(accountcore.AccountRef)
}

func (fake *fakeRefresher) RefreshAccountModels(ctx context.Context, ref accountcore.AccountRef) ([]accountapp.AccountModel, error) {
	fake.mu.Lock()
	fake.calls = append(fake.calls, ref)
	block := fake.blockCh
	err := fake.errByID[ref]
	onCall := fake.onCall
	fake.mu.Unlock()

	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if onCall != nil {
		onCall(ref)
	}
	if err != nil {
		return nil, err
	}
	return nil, nil
}

func mustOverview(t *testing.T, refText, providerID string, cliID int64, displayName, email, authKind, authMode string) accountapp.AccountOverview {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(refText)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q): %v", refText, err)
	}
	cli, err := accountcore.NewCLIAccountID(cliID)
	if err != nil {
		t.Fatalf("NewCLIAccountID: %v", err)
	}
	now := time.UnixMilli(1700000000000).UTC()
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}
	acc, err := accountcore.RestoreAccount(cat, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   providerID,
		CLIAccountID: cli,
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatalf("RestoreAccount: %v", err)
	}
	summary, err := accountapp.NewAccountModelSummary(accountapp.AccountModelSummaryInput{})
	if err != nil {
		t.Fatalf("NewAccountModelSummary: %v", err)
	}
	hasProfile := displayName != "" || email != ""
	var profileUpdatedAt time.Time
	var subscriptionKind string
	if hasProfile {
		profileUpdatedAt = now
		subscriptionKind = "free"
	}
	ov, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          acc,
		HasCredential:    true,
		AuthKind:         strings.ReplaceAll(authKind, "-", "_"),
		AuthMode:         strings.ReplaceAll(authMode, "-", "_"),
		HasProfile:       hasProfile,
		DisplayName:      displayName,
		Email:            email,
		SubscriptionKind: subscriptionKind,
		ProfileUpdatedAt: profileUpdatedAt,
		ModelSummary:     summary,
	})
	if err != nil {
		t.Fatalf("NewAccountOverview: %v", err)
	}
	return ov
}

func mustModel(t *testing.T, refText, modelID string, upstream bool, policy accountapp.ModelManualPolicy) accountapp.AccountModel {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(refText)
	if err != nil {
		t.Fatalf("ParseAccountRef: %v", err)
	}
	m, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        ref,
		ModelID:           modelID,
		UpstreamAvailable: upstream,
		ManualPolicy:      policy,
		UpdatedAt:         time.UnixMilli(1700000000000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountModel: %v", err)
	}
	return m
}

func setupTempAppState(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app-state.db")
	// 写入测试快照标签与 node->go 账号映射。
	err := appstate.UpdateKV(context.Background(), dbPath, accountrefmap.SyncStateKey, func(string, bool) (string, error) {
		return `{"links":{"` + testNodeRef + `":{"goRef":"` + testRefCodex + `","print":"p1"}},"validatorVersion":3}`, nil
	})
	if err != nil {
		t.Fatalf("seed accountrefmap failed: %v", err)
	}
	err = appstate.UpdateKV(context.Background(), dbPath, webuimodelssnapshot.CacheKey, func(string, bool) (string, error) {
		return `{"updatedAt":1700000000000,"labels":{"codex":{"gpt-5.3-codex":"GPT-5.3 Codex"}}}`, nil
	})
	if err != nil {
		t.Fatalf("seed snapshot labels failed: %v", err)
	}
	return dir
}

func newTestHandler(t *testing.T, store Store, refresher accountapp.AccountModelRefresher, aiHomeDir string, now time.Time) *Handler {
	t.Helper()
	h, err := NewHandler(Dependencies{
		Authorizer:     stubAuthorizer{allowed: true},
		Store:          store,
		AIHomeDir:      aiHomeDir,
		ModelRefresher: refresher,
		Now:            func() time.Time { return now },
		WatchKeepalive: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return h
}

func doReq(handler http.Handler, method, target, body string, headers ...[2]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for _, h := range headers {
		req.Header.Set(h[0], h[1])
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal failed: %v (%s)", err, rec.Body.String())
	}
	return out
}

func TestHandlerAuthAndRouting(t *testing.T) {
	store := &fakeStore{}
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: false},
		Store:      store,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	if rec := doReq(h, http.MethodGet, CatalogPath, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", rec.Code)
	}

	authed := newTestHandler(t, store, nil, "", time.UnixMilli(1760900000000))
	if rec := doReq(authed, http.MethodDelete, BasePath, ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE BasePath status = %d, want 405", rec.Code)
	}
	if rec := doReq(authed, http.MethodGet, BasePath+"/unknown", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown path status = %d, want 404", rec.Code)
	}
}

func TestHandlerCatalogGlobalScopedETagAndMetadata(t *testing.T) {
	aiHomeDir := setupTempAppState(t)
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	codexRef := mustParseAccountRef(testRefCodex)
	claudeRef := mustParseAccountRef(testRefClaude)
	qoderRef := mustParseAccountRef(testRefQoder)

	store := &fakeStore{
		overviews: []accountapp.AccountOverview{
			mustOverview(t, testRefCodex, "codex", 1, "Codex User", "codex@example.com", "oauth", "oauth-browser"),
			mustOverview(t, testRefClaude, "claude", 1, "Claude Key", "", "api-key", "api-key"),
			mustOverview(t, testRefQoder, "qoder", 1, "Qoder Empty", "", "oauth", ""),
		},
		catalog: accountapp.AccountModelCatalog{
			Generation:  7,
			UpdatedAtMS: now.UnixMilli(),
			Sets: []accountapp.AccountModelSet{
				{
					AccountRef:    codexRef,
					ProviderID:    "codex",
					LastAttemptAt: now,
					Models: []accountapp.AccountModel{
						mustModel(t, testRefCodex, "gpt-5.3-codex", true, accountapp.ModelPolicyInherit),
						mustModel(t, testRefCodex, "claude-sonnet-4-5", true, accountapp.ModelPolicyForceDisable),
						mustModel(t, testRefCodex, "custom-unknown-id", false, accountapp.ModelPolicyForceEnable),
					},
				},
				{
					AccountRef:       claudeRef,
					ProviderID:       "claude",
					LastAttemptAt:    now,
					LastErrorMessage: "rate limited",
					Models: []accountapp.AccountModel{
						mustModel(t, testRefClaude, "claude-sonnet-4-5", true, accountapp.ModelPolicyInherit),
					},
				},
				{
					AccountRef:    qoderRef,
					ProviderID:    "qoder",
					LastAttemptAt: now,
					// 探测过但模型为空：byAccountRef 必须带空数组，accountProbedAt 必须有时间戳。
					Models: nil,
				},
			},
		},
		aliases: []modelalias.Record{
			{ID: "a1", Alias: "claude-*", Target: "claude-sonnet-4-5", Provider: "all", TargetProvider: "auto"},
		},
	}

	h := newTestHandler(t, store, nil, aiHomeDir, now)

	rec := doReq(h, http.MethodGet, CatalogPath, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET catalog status = %d, body = %s", rec.Code, rec.Body.String())
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatalf("missing ETag header")
	}

	var catalog CatalogResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &catalog); err != nil {
		t.Fatalf("unmarshal CatalogResponse: %v", err)
	}
	if !catalog.OK || catalog.Endpoint != "/v1/models" || catalog.CatalogGeneration != 7 {
		t.Fatalf("unexpected catalog header: %+v", catalog)
	}
	if catalog.AccountScope != nil {
		t.Fatalf("expected global accountScope=nil, got %+v", catalog.AccountScope)
	}
	if catalog.Labels["codex"]["gpt-5.3-codex"] != "GPT-5.3 Codex" {
		t.Fatalf("missing snapshot label: %+v", catalog.Labels)
	}
	if len(catalog.ByAccountRef[testRefQoder]) != 0 || catalog.ByAccountRef[testRefQoder] == nil {
		t.Fatalf("expected non-nil empty array for probed empty account, got %#v", catalog.ByAccountRef[testRefQoder])
	}
	if catalog.AccountProbedAt[testRefQoder] != now.UnixMilli() {
		t.Fatalf("expected probed timestamp for empty account")
	}
	if catalog.ErrorsByAccountRef[testRefClaude] != "rate limited" || catalog.FirstError != "rate limited" {
		t.Fatalf("unexpected probe errors: %+v / %q", catalog.ErrorsByAccountRef, catalog.FirstError)
	}

	// claude-sonnet-4-5 跨账号聚合归属必须包含 codex 与 claude（即便 codex 停用它，归属也在去重前采集）。
	foundClaude := false
	foundWildcardExpanded := false
	for _, item := range catalog.Data {
		if item.ID == "claude-sonnet-4-5" {
			foundClaude = true
			if len(item.Providers) != 2 || item.Providers[0] != "claude" || item.Providers[1] != "codex" {
				t.Fatalf("expected providers [claude codex], got %v", item.Providers)
			}
		}
		if strings.HasPrefix(item.ID, "claude-") && item.ID != "claude-sonnet-4-5" {
			foundWildcardExpanded = true
		}
	}
	if !foundClaude || !foundWildcardExpanded {
		t.Fatalf("expected claude-sonnet-4-5 (%v) and wildcard expansion (%v)", foundClaude, foundWildcardExpanded)
	}
	if _, ok := catalog.Metadata["claude-sonnet-4-5"]; !ok {
		t.Fatalf("expected models.dev metadata for claude-sonnet-4-5")
	}
	if _, ok := catalog.Metadata["custom-unknown-id"]; ok {
		t.Fatalf("unknown model should not be in top-level metadata map")
	}

	// 验证 managedData 含未知模型 unknown 元数据与正确 enabled/manual 状态。
	foundUnknownManaged := false
	for _, item := range catalog.ManagedData {
		if item.ID == "custom-unknown-id" {
			foundUnknownManaged = true
			if !item.Manual || !item.Enabled || item.Metadata["metadataStatus"] != "unknown" {
				t.Fatalf("unexpected unknown managed item: %+v", item)
			}
		}
	}
	if !foundUnknownManaged {
		t.Fatalf("custom-unknown-id missing from managedData")
	}

	// ETag 304 校验
	notModified := doReq(h, http.MethodGet, CatalogPath, "", [2]string{"If-None-Match", etag})
	if notModified.Code != http.StatusNotModified {
		t.Fatalf("ETag status = %d, want 304", notModified.Code)
	}

	// 通过 NodeLegacyRef 查单账号作用域（走 accountrefmap 翻译）
	scopedRec := doReq(h, http.MethodGet, CatalogPath+"?accountRef="+testNodeRef, "")
	if scopedRec.Code != http.StatusOK {
		t.Fatalf("scoped GET status = %d, body = %s", scopedRec.Code, scopedRec.Body.String())
	}
	var scoped CatalogResponse
	if err := json.Unmarshal(scopedRec.Body.Bytes(), &scoped); err != nil {
		t.Fatalf("unmarshal scoped: %v", err)
	}
	if scoped.AccountScope == nil || scoped.AccountScope.AccountRef != testRefCodex {
		t.Fatalf("expected resolved accountScope %s, got %+v", testRefCodex, scoped.AccountScope)
	}
	// 单账号作用域不该混入其他账号的 firstError，也不该展开全局通配别名。
	if scoped.FirstError != "" {
		t.Fatalf("scoped firstError leaked: %q", scoped.FirstError)
	}
	for _, item := range scoped.Data {
		if strings.HasPrefix(item.ID, "claude-") {
			t.Fatalf("scoped data should not contain disabled model or global wildcard alias: %s", item.ID)
		}
	}

	// 不存在的账号返回 404
	missingRec := doReq(h, http.MethodGet, CatalogPath+"?accountRef=acct_00000000000000000000", "")
	if missingRec.Code != http.StatusNotFound {
		t.Fatalf("missing account status = %d, want 404", missingRec.Code)
	}
}

func TestHandlerCreatePatchDeleteAndCustomPricing(t *testing.T) {
	aiHomeDir := setupTempAppState(t)
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	codexRef := mustParseAccountRef(testRefCodex)
	claudeRef := mustParseAccountRef(testRefClaude)

	store := &fakeStore{
		overviews: []accountapp.AccountOverview{
			mustOverview(t, testRefCodex, "codex", 1, "Codex User", "codex@example.com", "oauth", "oauth-browser"),
			mustOverview(t, testRefClaude, "claude", 1, "Claude", "", "oauth", "oauth-browser"),
		},
		catalog: accountapp.AccountModelCatalog{
			Generation:  1,
			UpdatedAtMS: now.UnixMilli(),
			Sets: []accountapp.AccountModelSet{
				{
					AccountRef: codexRef,
					ProviderID: "codex",
					Models: []accountapp.AccountModel{
						mustModel(t, testRefCodex, "gpt-5.3-codex", true, accountapp.ModelPolicyInherit),
					},
				},
				{
					AccountRef: claudeRef,
					ProviderID: "claude",
					Models: []accountapp.AccountModel{
						mustModel(t, testRefClaude, "claude-sonnet-4-5", true, accountapp.ModelPolicyInherit),
					},
				},
			},
		},
	}

	h := newTestHandler(t, store, nil, aiHomeDir, now)

	// 校验 400/404
	if rec := doReq(h, http.MethodPost, BasePath, `{"id":"x"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing fields status = %d, want 400", rec.Code)
	}
	if rec := doReq(h, http.MethodPost, BasePath, `{"id":"gpt-x","provider":"codex","accountRef":"acct_00000000000000000000"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("missing account status = %d, want 404", rec.Code)
	}
	if rec := doReq(h, http.MethodPost, BasePath, `{"id":"gpt-x","provider":"codex","accountRef":"`+testRefCodex+`","customPricing":{"input":-1}}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("negative customPricing status = %d, want 400", rec.Code)
	}

	// 其他账号先设默认模型，验证后续同账号切换默认模型不会误清其他账号。
	otherDefault := doReq(h, http.MethodPatch, BasePath, `{"id":"claude-sonnet-4-5","provider":"claude","accountRef":"`+testRefClaude+`","defaultModel":true}`)
	if otherDefault.Code != http.StatusOK {
		t.Fatalf("set other account default failed: %d %s", otherDefault.Code, otherDefault.Body.String())
	}

	// 手动创建模型（含 customPricing input:0 与 defaultModel:true）
	createRec := doReq(h, http.MethodPost, BasePath, `{
		"id":"my-codex-model",
		"provider":"codex",
		"accountRef":"`+testRefCodex+`",
		"defaultModel":true,
		"description":"定制模型",
		"customPricing":{"input":0,"output":3.5}
	}`)
	if createRec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body = %s", createRec.Code, createRec.Body.String())
	}
	createPayload := decodeMap(t, createRec)
	createdModel := createPayload["model"].(map[string]any)
	if createdModel["manual"] != true || createdModel["defaultModel"] != true || createdModel["enabled"] != true {
		t.Fatalf("unexpected created model: %+v", createdModel)
	}
	pricing := createdModel["customPricing"].(map[string]any)
	if pricing["input"].(float64) != 0 || pricing["output"].(float64) != 3.5 {
		t.Fatalf("unexpected customPricing (zero must be kept): %+v", pricing)
	}

	// PATCH 切换默认模型到 gpt-5.3-codex，验证同账号旧默认被清掉且 customPricing 未传时保留原值
	patchDefault := doReq(h, http.MethodPatch, BasePath, `{"id":"gpt-5.3-codex","provider":"codex","accountRef":"`+testRefCodex+`","defaultModel":true}`)
	if patchDefault.Code != http.StatusOK {
		t.Fatalf("PATCH default status = %d, body = %s", patchDefault.Code, patchDefault.Body.String())
	}
	// PATCH 改备注但不传 customPricing -> 保留 my-codex-model 的 customPricing
	patchDesc := doReq(h, http.MethodPatch, BasePath, `{"id":"my-codex-model","provider":"codex","accountRef":"`+testRefCodex+`","description":"新备注"}`)
	if patchDesc.Code != http.StatusOK {
		t.Fatalf("PATCH desc status = %d, body = %s", patchDesc.Code, patchDesc.Body.String())
	}
	patchedModel := decodeMap(t, patchDesc)["model"].(map[string]any)
	if patchedModel["defaultModel"] != false || patchedModel["description"] != "新备注" || patchedModel["customPricing"] == nil {
		t.Fatalf("PATCH should clear old defaultModel on same account and preserve customPricing: %+v", patchedModel)
	}

	// PATCH 显式提交 customPricing:null -> 清空自定义价
	patchClear := doReq(h, http.MethodPatch, BasePath, `{"id":"my-codex-model","provider":"codex","accountRef":"`+testRefCodex+`","customPricing":null}`)
	if patchClear.Code != http.StatusOK {
		t.Fatalf("PATCH clear pricing status = %d", patchClear.Code)
	}
	clearedModel := decodeMap(t, patchClear)["model"].(map[string]any)
	if _, exists := clearedModel["customPricing"]; exists && clearedModel["customPricing"] != nil {
		t.Fatalf("expected customPricing cleared, got %+v", clearedModel["customPricing"])
	}

	// PATCH 停用发现模型 gpt-5.3-codex -> ForceDisable；再启用 -> Inherit
	disableRec := doReq(h, http.MethodPatch, BasePath, `{"id":"gpt-5.3-codex","provider":"codex","accountRef":"`+testRefCodex+`","enabled":false}`)
	if disableRec.Code != http.StatusOK {
		t.Fatalf("disable status = %d", disableRec.Code)
	}
	enableRec := doReq(h, http.MethodPatch, BasePath, `{"id":"gpt-5.3-codex","provider":"codex","accountRef":"`+testRefCodex+`","enabled":true}`)
	if enableRec.Code != http.StatusOK {
		t.Fatalf("enable status = %d", enableRec.Code)
	}
	lastCalls := store.policyCalls[len(store.policyCalls)-2:]
	if lastCalls[0].policy != accountapp.ModelPolicyForceDisable || lastCalls[1].policy != accountapp.ModelPolicyInherit {
		t.Fatalf("expected ForceDisable then Inherit, got %+v", lastCalls)
	}

	// 确认其他账号默认模型仍在
	dbPath, _ := appstate.DatabasePath(aiHomeDir)
	settings, err := modelcatalogsettings.Load(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("Load settings: %v", err)
	}
	foundOtherDefault := false
	for _, item := range settings.AccountModels {
		if item.AccountRef == testRefClaude && item.ID == "claude-sonnet-4-5" && item.DefaultModel {
			foundOtherDefault = true
		}
	}
	if !foundOtherDefault {
		t.Fatalf("other account defaultModel should not have been cleared: %+v", settings.AccountModels)
	}

	// POST /catalog/delete 删除 my-codex-model -> 同步 ModelPolicyInherit
	delRec := doReq(h, http.MethodPost, CatalogDeletePath, `{"id":"my-codex-model","provider":"codex","accountRef":"`+testRefCodex+`"}`)
	if delRec.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d, body = %s", delRec.Code, delRec.Body.String())
	}
	if store.policyCalls[len(store.policyCalls)-1].policy != accountapp.ModelPolicyInherit {
		t.Fatalf("expected ModelPolicyInherit on delete")
	}
}

func TestHandlerRefreshDedupeGlobalAndWatchSSE(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	codexRef := mustParseAccountRef(testRefCodex)
	claudeRef := mustParseAccountRef(testRefClaude)
	store := &fakeStore{
		overviews: []accountapp.AccountOverview{
			mustOverview(t, testRefCodex, "codex", 1, "Codex", "", "oauth", "oauth-browser"),
			mustOverview(t, testRefClaude, "claude", 1, "Claude", "", "oauth", "oauth-browser"),
		},
		catalog: accountapp.AccountModelCatalog{
			Generation:  2,
			UpdatedAtMS: now.UnixMilli(),
			Sets: []accountapp.AccountModelSet{
				{AccountRef: codexRef, ProviderID: "codex"},
				{AccountRef: claudeRef, ProviderID: "claude"},
			},
		},
	}

	// 未接线 refresher 返回 501
	noRefHandler := newTestHandler(t, store, nil, "", now)
	if rec := doReq(noRefHandler, http.MethodPost, CatalogRefreshPath, ""); rec.Code != http.StatusNotImplemented {
		t.Fatalf("unwired refresher status = %d, want 501", rec.Code)
	}

	block := make(chan struct{})
	refresher := &fakeRefresher{
		blockCh: block,
		errByID: map[accountcore.AccountRef]error{
			claudeRef: errors.New("upstream 503"),
		},
	}
	h := newTestHandler(t, store, refresher, "", now)

	// 启动真实 httptest Server 以验证 SSE 实时帧流
	srv := httptest.NewServer(h)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	watchReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+WatchPath, nil)
	watchResp, err := http.DefaultClient.Do(watchReq)
	if err != nil {
		t.Fatalf("open watch SSE: %v", err)
	}
	defer func() {
		_ = watchResp.Body.Close()
	}()
	if watchResp.StatusCode != http.StatusOK {
		t.Fatalf("watch status = %d", watchResp.StatusCode)
	}

	frames := make(chan map[string]any, 16)
	go func() {
		scanner := bufio.NewScanner(watchResp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var payload map[string]any
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload) == nil {
				frames <- payload
			}
		}
	}()

	nextFrame := func(wantType string) map[string]any {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case frame := <-frames:
				if frame["type"] == wantType {
					return frame
				}
			case <-deadline:
				t.Fatalf("timed out waiting for SSE frame type %q", wantType)
				return nil
			}
		}
	}

	nextFrame("connected")
	nextFrame("model-catalog-snapshot")

	// 单账号触发 + 并发去重
	ref1 := doReq(h, http.MethodPost, CatalogRefreshPath+"?accountRef="+testRefCodex, "")
	if ref1.Code != http.StatusAccepted {
		t.Fatalf("refresh1 status = %d, body = %s", ref1.Code, ref1.Body.String())
	}
	p1 := decodeMap(t, ref1)
	if p1["accepted"] != true || p1["alreadyRunning"] != false {
		t.Fatalf("expected accepted=true alreadyRunning=false, got %+v", p1)
	}
	job1 := p1["job"].(map[string]any)

	ref2 := doReq(h, http.MethodPost, CatalogRefreshPath+"?accountRef="+testRefCodex, "")
	if ref2.Code != http.StatusAccepted {
		t.Fatalf("refresh2 status = %d", ref2.Code)
	}
	p2 := decodeMap(t, ref2)
	if p2["accepted"] != false || p2["alreadyRunning"] != true || p2["job"].(map[string]any)["id"] != job1["id"] {
		t.Fatalf("expected dedupe same job, got %+v vs %+v", p2, p1)
	}

	// 放行 refresher，等待 succeeded 帧且携带 catalog
	close(block)
	for {
		f := nextFrame("model-catalog-job")
		job := f["job"].(map[string]any)
		if job["id"] == job1["id"] && job["status"] == "succeeded" {
			if job["catalog"] == nil {
				t.Fatalf("expected succeeded job to carry catalog")
			}
			break
		}
	}

	// 验证单账号失败会传播到 job.status=failed
	failRec := doReq(h, http.MethodPost, CatalogRefreshPath+"?accountRef="+testRefClaude, "")
	if failRec.Code != http.StatusAccepted {
		t.Fatalf("fail refresh status = %d", failRec.Code)
	}
	failJobID := decodeMap(t, failRec)["job"].(map[string]any)["id"]
	for {
		f := nextFrame("model-catalog-job")
		job := f["job"].(map[string]any)
		if job["id"] == failJobID && job["status"] == "failed" {
			if !strings.Contains(job["error"].(string), "upstream 503") {
				t.Fatalf("expected error in failed job, got %v", job["error"])
			}
			break
		}
	}

	// 验证全局刷新覆盖所有账号
	refresher.mu.Lock()
	refresher.blockCh = nil
	refresher.calls = nil
	refresher.mu.Unlock()

	globalRec := doReq(h, http.MethodPost, CatalogRefreshPath, "")
	if globalRec.Code != http.StatusAccepted {
		t.Fatalf("global refresh status = %d", globalRec.Code)
	}
	globalJobID := decodeMap(t, globalRec)["job"].(map[string]any)["id"]
	for {
		f := nextFrame("model-catalog-job")
		job := f["job"].(map[string]any)
		if job["id"] == globalJobID && job["status"] == "succeeded" {
			break
		}
	}
	refresher.mu.Lock()
	callCount := len(refresher.calls)
	refresher.mu.Unlock()
	if callCount != 2 {
		t.Fatalf("expected global refresh to probe 2 accounts, got %d", callCount)
	}

	// 不存在的账号 404
	if missing := doReq(h, http.MethodPost, CatalogRefreshPath+"?accountRef=acct_00000000000000000000", ""); missing.Code != http.StatusNotFound {
		t.Fatalf("missing refresh account status = %d, want 404", missing.Code)
	}
}
