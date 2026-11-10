package webuiopenaimodelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
)

const (
	// 设置文档与快照由 Node 写入，账号引用是 Node ref；映射表把它们翻成下面的 Go 引用。
	nodeClaudeRef = "acct_aaaaaaaaaaaaaaaaaaaa"
	nodeCodexRef  = "acct_bbbbbbbbbbbbbbbbbbbb"
	// 没有链接的 Node 引用按恒等回落：它代表一个只存在于手动设置里的账号。
	nodeDetachedRef = "acct_cccccccccccccccccccc"

	settingsUpdatedAtMS = int64(1700000009000)
)

type fakeSettings struct {
	settings modelcatalogsettings.Settings
	err      error
}

func (source fakeSettings) ReadSettings(context.Context) (modelcatalogsettings.Settings, error) {
	return source.settings, source.err
}

type fakeSnapshot struct {
	snapshot *webuimodelssnapshot.Snapshot
	err      error
}

func (source fakeSnapshot) ReadSnapshot(context.Context) (*webuimodelssnapshot.Snapshot, error) {
	if source.err != nil {
		return nil, source.err
	}
	if source.snapshot == nil {
		return &webuimodelssnapshot.Snapshot{}, nil
	}
	return source.snapshot, nil
}

func mustResolver(t *testing.T, links map[string]string) accountrefmap.Resolver {
	t.Helper()
	document := map[string]any{"links": map[string]any{}}
	encodedLinks := document["links"].(map[string]any)
	for nodeRef, goRef := range links {
		encodedLinks[nodeRef] = map[string]any{"goRef": goRef}
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("序列化链接表失败: %v", err)
	}
	table, err := accountrefmap.Parse(string(encoded))
	if err != nil {
		t.Fatalf("解析链接表失败: %v", err)
	}
	return accountrefmap.NewResolver(true, table)
}

// testSettings 覆盖四种事实：停用、默认模型、仅存在于设置里的手动模型、
// 只存在于设置里的账号（含链接与无链接两种），以及一条无账号归属的 legacy 手动模型。
func testSettings(t *testing.T) modelcatalogsettings.Settings {
	t.Helper()
	return modelcatalogsettings.Settings{
		Version: modelcatalogsettings.SettingsVersion,
		AccountModels: []modelcatalogsettings.AccountModel{
			{
				ID:          "claude-opus-4",
				Provider:    "claude",
				AccountRef:  nodeClaudeRef,
				Enabled:     false,
				Manual:      true,
				Description: "停用示例",
				UpdatedAtMS: 1700000001000,
				CreatedAtMS: 1700000000000,
			},
			{
				ID:           "claude-sonnet-4",
				Provider:     "claude",
				AccountRef:   nodeClaudeRef,
				Enabled:      true,
				DefaultModel: true,
				UpdatedAtMS:  1700000002000,
				CreatedAtMS:  1700000000000,
			},
			{
				ID:          "manual-only-model",
				Provider:    "claude",
				AccountRef:  nodeClaudeRef,
				Enabled:     true,
				Manual:      true,
				Description: "手工添加",
				UpdatedAtMS: 1700000003000,
				CreatedAtMS: 1700000003000,
			},
			{
				ID:          "detached-model",
				Provider:    "claude",
				AccountRef:  nodeDetachedRef,
				Enabled:     true,
				Manual:      true,
				UpdatedAtMS: 1700000004000,
				CreatedAtMS: 1700000004000,
			},
		},
		LegacyModels: []modelcatalogsettings.LegacyModel{
			{
				ID:          "legacy-manual",
				Provider:    "codex",
				Enabled:     true,
				Manual:      true,
				UpdatedAtMS: 1700000005000,
				CreatedAtMS: 1700000005000,
			},
		},
		UpdatedAtMS: settingsUpdatedAtMS,
	}
}

func testSnapshot(t *testing.T) *webuimodelssnapshot.Snapshot {
	t.Helper()
	// zcode 只出现在快照里：它必须被过滤掉，否则调用方会以为还有该 Provider 的账号。
	return webuimodelssnapshot.Parse([]byte(`{
		"updatedAt": 1700000006000,
		"labels": {
			"claude": {"claude-opus-4": "Claude Opus 4", "shared-model": "Shared Model"},
			"zcode": {"glm-5": "GLM 5"}
		}
	}`))
}

func newSourcedHandler(t *testing.T, reader Reader, dependencies Dependencies) *Handler {
	t.Helper()
	dependencies.Authorizer = stubAuthorizer(true)
	dependencies.Reader = reader
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func TestManagedDataMergesCatalogAndSettings(t *testing.T) {
	handler := newSourcedHandler(t, fakeReader{catalog: testCatalog(t)}, Dependencies{
		Settings: fakeSettings{settings: testSettings(t)},
		Snapshot: fakeSnapshot{snapshot: testSnapshot(t)},
		AccountRefs: mustResolver(t, map[string]string{
			nodeClaudeRef: claudeAccountRef,
			nodeCodexRef:  codexAccountRef,
		}),
	})
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	body := decodeResponse(t, recorder)
	if body.SettingsUpdatedAtMS != settingsUpdatedAtMS {
		t.Fatalf("settings_updated_at_ms = %d, want %d", body.SettingsUpdatedAtMS, settingsUpdatedAtMS)
	}
	if len(body.ManagedData) != 9 {
		t.Fatalf("managed_data = %+v", body.ManagedData)
	}
	// 排序口径与 Node 一致：provider → 账号引用 → 模型 id；无账号归属的 legacy 条目
	// 排在 provider 未加链接的账号之前。
	assertManagedOrder(t, body.ManagedData)

	// 设置文档里的 Node 引用必须翻成 Go account_ref，否则停用状态会挂在另一个账号上。
	opus := findManaged(t, body.ManagedData, claudeAccountRef, "claude-opus-4")
	if opus.Enabled || !opus.Manual || !slices.Equal(opus.Providers, []string{"claude"}) {
		t.Fatalf("claude-opus-4 = %+v", opus)
	}
	if opus.Description != "停用示例" || opus.UpdatedAtMS != 1700000001000 || opus.Source != "manual" {
		t.Fatalf("claude-opus-4 setting = %+v", opus)
	}

	sonnet := findManaged(t, body.ManagedData, claudeAccountRef, "claude-sonnet-4")
	if !sonnet.Enabled || sonnet.Manual || !sonnet.DefaultModel || sonnet.Source != "discovered" {
		t.Fatalf("claude-sonnet-4 = %+v", sonnet)
	}

	// 目录里没有的手动模型仍然出现，source=manual，enabled 来自设置。
	manual := findManaged(t, body.ManagedData, claudeAccountRef, "manual-only-model")
	if !manual.Manual || manual.Source != "manual" || !manual.Enabled || manual.Description != "手工添加" {
		t.Fatalf("manual-only-model = %+v", manual)
	}

	// 无链接的 Node 引用按恒等回落：账号确实不同，不能被并进 acct_1111。
	detached := findManaged(t, body.ManagedData, nodeDetachedRef, "detached-model")
	if !detached.Manual || !detached.Enabled {
		t.Fatalf("detached-model = %+v", detached)
	}

	// legacy 手动记录没有账号归属：account_ref 为空，但仍然是一条可管理条目。
	legacy := findManaged(t, body.ManagedData, "", "legacy-manual")
	if legacy.Provider != "codex" || !legacy.Manual || legacy.Source != "manual" || !legacy.Enabled {
		t.Fatalf("legacy-manual = %+v", legacy)
	}
	if legacy.Providers == nil || len(legacy.Providers) != 1 {
		t.Fatalf("legacy providers = %#v, want 单元素数组", legacy.Providers)
	}

	// 没有设置记录的发现条目沿用 Node 的默认：启用、非手动、source=discovered。
	shared := findManaged(t, body.ManagedData, claudeAccountRef, "shared-model")
	if !shared.Enabled || shared.Manual || shared.Source != "discovered" || shared.DefaultModel {
		t.Fatalf("shared-model = %+v", shared)
	}
	if shared.CustomPricing != nil {
		t.Fatalf("shared-model custom_pricing = %+v, want nil", shared.CustomPricing)
	}
}

func TestLabelsOnlyCoverProvidersInResponse(t *testing.T) {
	handler := newSourcedHandler(t, fakeReader{catalog: testCatalog(t)}, Dependencies{
		Settings: fakeSettings{settings: testSettings(t)},
		Snapshot: fakeSnapshot{snapshot: testSnapshot(t)},
	})
	body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
	if body.Labels == nil {
		t.Fatal("labels 缺失")
	}
	claude := (*body.Labels)["claude"]
	if claude["claude-opus-4"] != "Claude Opus 4" || claude["shared-model"] != "Shared Model" {
		t.Fatalf("claude labels = %+v", claude)
	}
	if _, found := (*body.Labels)["zcode"]; found {
		t.Fatalf("labels 不应包含本次响应之外的 provider: %+v", *body.Labels)
	}
}

// TestOptionalSourcesStayUnfilled 锁住「源缺失就整块不填」：没有设置文档时不推断
// enabled，没有快照时不给空 labels 对象。
func TestOptionalSourcesStayUnfilled(t *testing.T) {
	handler := newTestHandler(t, fakeReader{catalog: testCatalog(t)}, true)
	recorder := doRequest(handler, http.MethodGet, Path)
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解码响应失败: %v", err)
	}
	for _, key := range []string{"managed_data", "labels", "settings_updated_at_ms"} {
		if _, found := raw[key]; found {
			t.Fatalf("未接线的源不应输出 %q: %s", key, recorder.Body.String())
		}
	}
	unfilled := stringsOf(t, raw["unfilled_fields"])
	for _, key := range []string{"managedData", "labels", "settingsUpdatedAt", "managedData.metadata", "data"} {
		if !slices.Contains(unfilled, key) {
			t.Fatalf("unfilled_fields 缺少 %q: %v", key, unfilled)
		}
	}
	filled := stringsOf(t, raw["filled_fields"])
	for _, key := range []string{"managed_data", "labels", "settings_updated_at_ms"} {
		if slices.Contains(filled, key) {
			t.Fatalf("filled_fields 不应包含 %q: %v", key, filled)
		}
	}
}

// TestEmptySettingsDocumentIsNotAFact 区分「读到空文档」与「读到设置」：
// 空文档里没有任何 enabled/manual 证据，managed_data 必须继续算缺口。
func TestEmptySettingsDocumentIsNotAFact(t *testing.T) {
	handler := newSourcedHandler(t, fakeReader{catalog: testCatalog(t)}, Dependencies{
		Settings: fakeSettings{settings: modelcatalogsettings.Normalize(nil)},
	})
	body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
	if body.ManagedData != nil || body.SettingsUpdatedAtMS != 0 {
		t.Fatalf("空设置不应产生管理目录: %+v", body)
	}
	if !slices.Contains(body.UnfilledFields, "managedData") || !slices.Contains(body.UnfilledFields, "settingsUpdatedAt") {
		t.Fatalf("unfilled_fields = %v", body.UnfilledFields)
	}
}

// TestSourceFailuresAreReported 读失败要显式降级：既不 500（aih.db 事实仍然有效），
// 也不能把失败说成「没有事实」。
func TestSourceFailuresAreReported(t *testing.T) {
	handler := newSourcedHandler(t, fakeReader{catalog: testCatalog(t)}, Dependencies{
		Settings: fakeSettings{err: errors.New("app-state.db locked")},
		Snapshot: fakeSnapshot{err: errors.New("kv read failed")},
	})
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	body := decodeResponse(t, recorder)
	if !slices.Equal(body.UnavailableSources, []string{unavailableSettings, unavailableSnapshot}) {
		t.Fatalf("unavailable_sources = %v", body.UnavailableSources)
	}
	if body.ManagedData != nil || body.Labels != nil {
		t.Fatalf("读失败不应产出可选块: %+v", body)
	}
	if strings.Contains(recorder.Body.String(), "locked") {
		t.Fatal("错误文本可能含路径，不应回显")
	}
	if !slices.Contains(body.UnfilledFields, "managedData") || !slices.Contains(body.UnfilledFields, "labels") {
		t.Fatalf("unfilled_fields = %v", body.UnfilledFields)
	}
}

// TestSnapshotOnlyStillPublishesLabels 快照与设置是两个独立源：只有快照时只填 labels。
func TestSnapshotOnlyStillPublishesLabels(t *testing.T) {
	handler := newSourcedHandler(t, fakeReader{catalog: testCatalog(t)}, Dependencies{
		Snapshot: fakeSnapshot{snapshot: testSnapshot(t)},
	})
	body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
	if body.Labels == nil {
		t.Fatal("labels 缺失")
	}
	if body.ManagedData != nil {
		t.Fatalf("没有设置文档时不应有 managed_data: %+v", body.ManagedData)
	}
	if !slices.Contains(body.FilledFields, "labels") || !slices.Contains(body.UnfilledFields, "managedData") {
		t.Fatalf("filled=%v unfilled=%v", body.FilledFields, body.UnfilledFields)
	}
}

// TestFieldCoveragePartitionsEveryResponse 防止新增字段时忘了归类：
// 每个键必须且只能出现在 filled_fields / unfilled_fields 之一。
func TestFieldCoveragePartitionsEveryResponse(t *testing.T) {
	// 目录层：容器键 + 两个视图的全部 JSON 字段。
	expectedCatalog := []string{"generation", "catalog_updated_at_ms", "models", "account_models", "unavailable_sources"}
	expectedCatalog = append(expectedCatalog, jsonFieldNames(reflect.TypeOf(modelView{}))...)
	expectedCatalog = append(expectedCatalog, jsonFieldNames(reflect.TypeOf(accountModelView{}))...)
	assertKeySet(t, "catalogFieldKeys", catalogFieldKeys, expectedCatalog)

	// 设置层：容器 + 设置时间戳 + managed_data 条目的全部 JSON 字段。
	expectedSettings := []string{"managed_data", "settings_updated_at_ms"}
	for _, name := range jsonFieldNames(reflect.TypeOf(managedModelView{})) {
		expectedSettings = append(expectedSettings, "managed_data."+name)
	}
	assertKeySet(t, "settingsFieldKeys", settingsFieldKeys, expectedSettings)

	assertKeySet(t, "snapshotFieldKeys", snapshotFieldKeys, []string{"labels"})

	configurations := []struct {
		name     string
		enrich   *enrichment
		hasSets  bool
		hasSnaps bool
	}{
		{name: "none"},
		{name: "settings", enrich: &enrichment{hasSettings: true, settings: testSettings(t)}, hasSets: true},
		{name: "snapshot", enrich: &enrichment{hasSnapshot: true, snapshot: testSnapshot(t)}, hasSnaps: true},
		{
			name:     "both",
			enrich:   &enrichment{hasSettings: true, settings: testSettings(t), hasSnapshot: true, snapshot: testSnapshot(t)},
			hasSets:  true,
			hasSnaps: true,
		},
	}
	for _, configuration := range configurations {
		t.Run(configuration.name, func(t *testing.T) {
			filled, unfilled := fieldCoverage(configuration.enrich)
			for _, keys := range [][]string{filled, unfilled} {
				if len(keys) == 0 {
					t.Fatal("字段清单不能为空")
				}
				seen := make(map[string]bool, len(keys))
				for _, key := range keys {
					if key == "" || seen[key] {
						t.Fatalf("字段清单存在空值或重复项: %v", keys)
					}
					seen[key] = true
				}
			}
			overlap := make(map[string]bool, len(filled))
			for _, key := range filled {
				overlap[key] = true
			}
			for _, key := range unfilled {
				if overlap[key] {
					t.Fatalf("字段 %q 同时出现在 filled 与 unfilled", key)
				}
			}
			if got := slices.Contains(filled, "managed_data"); got != configuration.hasSets {
				t.Fatalf("managed_data filled = %v, want %v", got, configuration.hasSets)
			}
			if got := slices.Contains(filled, "labels"); got != configuration.hasSnaps {
				t.Fatalf("labels filled = %v, want %v", got, configuration.hasSnaps)
			}
			if got := slices.Contains(unfilled, "managedData.metadata"); !got {
				t.Fatalf("managedData.metadata 必须始终是缺口: %v", unfilled)
			}
		})
	}
}

func assertKeySet(t *testing.T, label string, got []string, want []string) {
	t.Helper()
	sortedGot := append([]string(nil), got...)
	sortedWant := append([]string(nil), want...)
	slices.Sort(sortedGot)
	slices.Sort(sortedWant)
	if !slices.Equal(sortedGot, sortedWant) {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
}

func assertManagedOrder(t *testing.T, items []managedModelView) {
	t.Helper()
	ordered := slices.Clone(items)
	slices.SortFunc(ordered, func(left, right managedModelView) int {
		if left.Provider != right.Provider {
			return strings.Compare(left.Provider, right.Provider)
		}
		if left.AccountRef != right.AccountRef {
			return strings.Compare(left.AccountRef, right.AccountRef)
		}
		return strings.Compare(left.ID, right.ID)
	})
	identity := func(item managedModelView) string {
		return item.Provider + "\x00" + item.AccountRef + "\x00" + item.ID
	}
	if !slices.EqualFunc(items, ordered, func(left, right managedModelView) bool {
		return identity(left) == identity(right)
	}) {
		t.Fatalf("managed_data 未按 provider/account_ref/id 排序: %+v", items)
	}
}

func findManaged(t *testing.T, items []managedModelView, accountRef string, modelID string) managedModelView {
	t.Helper()
	for _, item := range items {
		if item.AccountRef == accountRef && item.ID == modelID {
			return item
		}
	}
	t.Fatalf("managed_data 缺少 (%q, %q): %+v", accountRef, modelID, items)
	return managedModelView{}
}

func stringsOf(t *testing.T, value any) []string {
	t.Helper()
	items, ok := value.([]any)
	if !ok {
		t.Fatalf("字段不是数组: %#v", value)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("数组元素不是字符串: %#v", item)
		}
		out = append(out, text)
	}
	return out
}
