package webuimodelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
)

const (
	// Go 侧账号引用（响应里对外暴露的 account_ref）。
	nodeClaudeRef = "acct_aaaaaaaaaaaaaaaaaaaa"
	nodeCodexRef  = "acct_bbbbbbbbbbbbbbbbbbbb"
	// 一个不在任何 Provider 里的 Node 引用：设置文档里的孤儿记录。
	orphanRef = "acct_cccccccccccccccccccc"

	settingsUpdatedAtMS = int64(1700000002000)
	snapshotUpdatedAtMS = int64(1700000003000)
	probedAtMS          = int64(1794900000000)
	settingUpdatedAtMS  = int64(1700000001000)
)

type stubResolver map[string]string

func (resolver stubResolver) NodeRef(goRef string) string {
	if nodeRef, ok := resolver[goRef]; ok {
		return nodeRef
	}
	// 与 accountrefmap 一致：没有链接就是恒等，不是「未映射」。
	return goRef
}

type fakeSettingsReader struct {
	settings modelcatalogsettings.Settings
	err      error
}

func (reader fakeSettingsReader) ReadSettings(context.Context) (modelcatalogsettings.Settings, error) {
	return reader.settings, reader.err
}

type fakeSnapshotReader struct {
	snapshot *webuimodelssnapshot.Snapshot
	err      error
}

func (reader fakeSnapshotReader) ReadSnapshot(context.Context) (*webuimodelssnapshot.Snapshot, error) {
	return reader.snapshot, reader.err
}

// testSettings 使用 Node 账号引用作为身份：设置文档由 Node 写，键是 Node 的账号 ref。
func testSettings(t *testing.T) modelcatalogsettings.Settings {
	t.Helper()
	input := 3.0
	output := 15.0
	return modelcatalogsettings.Settings{
		Version:     modelcatalogsettings.SettingsVersion,
		UpdatedAtMS: settingsUpdatedAtMS,
		AccountModels: []modelcatalogsettings.AccountModel{
			{
				ID:            "claude-sonnet",
				Provider:      "claude",
				AccountRef:    nodeClaudeRef,
				Enabled:       true,
				Manual:        true,
				DefaultModel:  true,
				Description:   "主模型",
				CustomPricing: &modelcatalogsettings.CustomPricing{Input: &input, Output: &output},
				CreatedAtMS:   settingUpdatedAtMS,
				UpdatedAtMS:   settingUpdatedAtMS,
			},
			{
				ID:          "claude-opus",
				Provider:    "claude",
				AccountRef:  nodeClaudeRef,
				Enabled:     false,
				UpdatedAtMS: settingUpdatedAtMS,
			},
			{
				// 孤儿记录：账号不在 Go 事实表里，必须被忽略而不是挂到别的账号上。
				ID:          "ghost-model",
				Provider:    "claude",
				AccountRef:  orphanRef,
				Enabled:     true,
				UpdatedAtMS: settingUpdatedAtMS,
			},
		},
	}
}

func testSnapshot(t *testing.T) *webuimodelssnapshot.Snapshot {
	t.Helper()
	raw := fmt.Sprintf(`{
		"updatedAt": %d,
		"accountProbeVersion": 2,
		"labels": {
			"claude": {"claude-sonnet": "Claude Sonnet", "claude-opus": "Claude Opus"},
			"ghost": {"ghost-model": "Ghost"}
		},
		"contextLimits": {"%s": {"claude-sonnet": 200000, "claude-opus": 0}},
		"byAccount": {"%s": ["claude-sonnet", "claude-opus"]},
		"errorsByAccount": {"%s": "upstream 500"},
		"accountUpdatedAt": {"%s": %d}
	}`, snapshotUpdatedAtMS, nodeClaudeRef, nodeClaudeRef, nodeCodexRef, nodeClaudeRef, probedAtMS)
	return webuimodelssnapshot.Parse([]byte(raw))
}

func newEnrichedHandler(t *testing.T, settings SettingsReader, snapshot SnapshotReader, refs AccountRefResolver) *Handler {
	t.Helper()
	return newTestHandlerWith(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Reader:     fakeReader{catalog: testCatalog(t)},
		Settings:   settings,
		Snapshot:   snapshot,
		Refs:       refs,
	})
}

func decodeRaw(t *testing.T, handler *Handler) map[string]any {
	t.Helper()
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	var raw map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解码原始响应失败: %v", err)
	}
	return raw
}

func findAccount(t *testing.T, body response, providerID, accountRef string) accountView {
	t.Helper()
	for _, provider := range body.Providers {
		if provider.ProviderID != providerID {
			continue
		}
		for _, account := range provider.Accounts {
			if account.AccountRef == accountRef {
				return account
			}
		}
	}
	t.Fatalf("未找到账号 %s/%s", providerID, accountRef)
	return accountView{}
}

func findModel(t *testing.T, account accountView, modelID string) modelView {
	t.Helper()
	for _, detail := range account.ModelDetails {
		if detail.ModelID == modelID {
			return detail
		}
	}
	t.Fatalf("账号 %s 的 model_details 缺少 %q: %+v", account.AccountRef, modelID, account.ModelDetails)
	return modelView{}
}

func TestEnrichmentFillsDerivableSettingsLabelsAndProbeFacts(t *testing.T) {
	handler := newEnrichedHandler(t,
		fakeSettingsReader{settings: testSettings(t)},
		fakeSnapshotReader{snapshot: testSnapshot(t)},
		stubResolver{claudeAccountRef: nodeClaudeRef, codexAccountRef: nodeCodexRef},
	)
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	body := decodeResponse(t, recorder)

	if body.SettingsUpdatedAtMS != settingsUpdatedAtMS || body.SnapshotUpdatedAtMS != snapshotUpdatedAtMS {
		t.Fatalf("源时间戳 = %d/%d", body.SettingsUpdatedAtMS, body.SnapshotUpdatedAtMS)
	}
	if body.Labels == nil {
		t.Fatal("labels 应已填充")
	}
	if got := (*body.Labels)["claude"]["claude-sonnet"]; got != "Claude Sonnet" {
		t.Fatalf("labels[claude][claude-sonnet] = %q", got)
	}
	// 快照里残留的 Provider 不应出现在响应里。
	if _, found := (*body.Labels)["ghost"]; found {
		t.Fatalf("labels 不应包含本次未输出的 provider: %v", *body.Labels)
	}
	if unlisted := body.UnavailableSources; len(unlisted) != 0 {
		t.Fatalf("unavailable_sources = %v, want []", unlisted)
	}

	claude := findAccount(t, body, "claude", claudeAccountRef)
	if claude.ProbedAtMS != probedAtMS {
		t.Fatalf("probed_at_ms = %d, want %d", claude.ProbedAtMS, probedAtMS)
	}
	var detailIDs []string
	for _, detail := range claude.ModelDetails {
		detailIDs = append(detailIDs, detail.ModelID)
	}
	assertStrings(t, "model_details", detailIDs, []string{"claude-haiku", "claude-opus", "claude-sonnet"})

	sonnet := findModel(t, claude, "claude-sonnet")
	if sonnet.ContextLimit != 200000 {
		t.Fatalf("context_limit = %d, want 200000", sonnet.ContextLimit)
	}
	if sonnet.Setting == nil {
		t.Fatal("claude-sonnet 缺少 setting")
	}
	if !sonnet.Setting.Enabled || !sonnet.Setting.Manual || !sonnet.Setting.DefaultModel {
		t.Fatalf("setting 标记 = %+v", *sonnet.Setting)
	}
	if sonnet.Setting.Description != "主模型" || sonnet.Setting.UpdatedAtMS != settingUpdatedAtMS {
		t.Fatalf("setting 文本 = %+v", *sonnet.Setting)
	}
	if sonnet.Setting.CustomPricing == nil || sonnet.Setting.CustomPricing.Input == nil ||
		*sonnet.Setting.CustomPricing.Input != 3 {
		t.Fatalf("custom_pricing = %+v", sonnet.Setting.CustomPricing)
	}

	opus := findModel(t, claude, "claude-opus")
	if opus.Setting == nil || opus.Setting.Enabled {
		t.Fatalf("claude-opus 应带 enabled=false 的记录: %+v", opus.Setting)
	}
	// contextLimits 里值为 0 表示未声明，必须留空而不是输出 0。
	if opus.ContextLimit != 0 {
		t.Fatalf("claude-opus context_limit = %d, want 0", opus.ContextLimit)
	}

	haiku := findModel(t, claude, "claude-haiku")
	if haiku.Setting != nil {
		t.Fatalf("没有设置记录的模型不应伪造 setting: %+v", haiku.Setting)
	}

	codex := findAccount(t, body, "codex", codexAccountRef)
	if codex.ProbedAtMS != 0 {
		t.Fatalf("codex probed_at_ms = %d, want 0", codex.ProbedAtMS)
	}
	if gpt := findModel(t, codex, "gpt-5"); gpt.Setting != nil || gpt.ContextLimit != 0 {
		t.Fatalf("codex/gpt-5 不应有设置或窗口: %+v", gpt)
	}

	empty := findAccount(t, body, "codex", emptyAccountRef)
	if len(empty.ModelDetails) != 0 {
		t.Fatalf("空账号 model_details = %+v", empty.ModelDetails)
	}

	for _, key := range []string{"labels", "model_details", "model_id", "context_limit", "setting",
		"enabled", "manual", "default_model", "description", "custom_pricing", "updated_at_ms",
		"probed_at_ms", "settings_updated_at_ms", "snapshot_updated_at_ms"} {
		if !containsString(body.FilledFields, key) {
			t.Errorf("filled_fields 缺少 %q: %v", key, body.FilledFields)
		}
	}
	// 这些仍无来源，必须留在 unfilled 里。
	for _, key := range []string{"models", "metadata", "selectableByAccountRef", "defaultByAccountRef",
		"errorsByAccountRef", "cached", "source", "sources", "scannedAccounts", "firstError",
		"accountScope", "managedData"} {
		if !containsString(body.UnfilledFields, key) {
			t.Errorf("unfilled_fields 缺少 %q: %v", key, body.UnfilledFields)
		}
	}
}

func TestEnrichmentWithoutSourcesKeepsFieldsUnfilled(t *testing.T) {
	handler := newTestHandler(t, fakeReader{catalog: testCatalog(t)}, true)
	raw := decodeRaw(t, handler)
	for _, key := range []string{"labels", "model_details", "probed_at_ms", "settings_updated_at_ms", "snapshot_updated_at_ms"} {
		if _, found := raw[key]; found {
			t.Errorf("无外部事实源时不应出现 %q，实际值 %v", key, raw[key])
		}
	}
	unfilled, _ := raw["unfilled_fields"].([]any)
	for _, key := range []string{"labels", "metadata", "model_details", "probed_at_ms", "setting",
		"selectableByAccountRef", "defaultByAccountRef"} {
		if !containsAny(unfilled, key) {
			t.Errorf("unfilled_fields 缺少 %q: %v", key, unfilled)
		}
	}
	unavailable, ok := raw["unavailable_sources"].([]any)
	if !ok || len(unavailable) != 0 {
		t.Fatalf("unavailable_sources = %#v, want []", raw["unavailable_sources"])
	}
}

func TestEnrichmentTranslatesGoAccountRefsToNodeRefs(t *testing.T) {
	t.Run("映射表命中", func(t *testing.T) {
		handler := newEnrichedHandler(t,
			fakeSettingsReader{settings: testSettings(t)},
			fakeSnapshotReader{snapshot: testSnapshot(t)},
			stubResolver{claudeAccountRef: nodeClaudeRef, codexAccountRef: nodeCodexRef},
		)
		body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
		claude := findAccount(t, body, "claude", claudeAccountRef)
		if sonnet := findModel(t, claude, "claude-sonnet"); sonnet.Setting == nil {
			t.Fatal("Node 引用经映射后应命中设置记录")
		}
	})

	t.Run("没有链接时恒等", func(t *testing.T) {
		// 关掉映射后 Go 引用本身就是 Node 引用，设置文档按 Go 引用键化。
		settings := testSettings(t)
		settings.AccountModels = []modelcatalogsettings.AccountModel{{
			ID:          "claude-sonnet",
			Provider:    "claude",
			AccountRef:  claudeAccountRef,
			Enabled:     true,
			UpdatedAtMS: settingUpdatedAtMS,
		}}
		handler := newEnrichedHandler(t, fakeSettingsReader{settings: settings}, nil, nil)
		body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
		claude := findAccount(t, body, "claude", claudeAccountRef)
		if sonnet := findModel(t, claude, "claude-sonnet"); sonnet.Setting == nil || !sonnet.Setting.Enabled {
			t.Fatalf("恒等回落未命中设置: %+v", sonnet.Setting)
		}
	})

	t.Run("映射到别的引用时不得误命中", func(t *testing.T) {
		handler := newEnrichedHandler(t,
			fakeSettingsReader{settings: testSettings(t)},
			nil,
			stubResolver{claudeAccountRef: orphanRef},
		)
		body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
		claude := findAccount(t, body, "claude", claudeAccountRef)
		for _, detail := range claude.ModelDetails {
			if detail.Setting != nil {
				t.Fatalf("映射到 %s 后不应命中 %s 的设置: %+v", orphanRef, detail.ModelID, detail.Setting)
			}
		}
	})
}

func TestEnrichmentMatchesModelIDsCaseInsensitively(t *testing.T) {
	settings := testSettings(t)
	settings.AccountModels = []modelcatalogsettings.AccountModel{{
		ID:          "Claude-Sonnet",
		Provider:    "claude",
		AccountRef:  nodeClaudeRef,
		Enabled:     false,
		UpdatedAtMS: settingUpdatedAtMS,
	}}
	handler := newEnrichedHandler(t, fakeSettingsReader{settings: settings}, nil, stubResolver{claudeAccountRef: nodeClaudeRef})
	body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
	claude := findAccount(t, body, "claude", claudeAccountRef)
	sonnet := findModel(t, claude, "claude-sonnet")
	if sonnet.Setting == nil || sonnet.Setting.Enabled {
		t.Fatalf("大小写不同的模型 id 应命中同一条设置: %+v", sonnet.Setting)
	}
}

func TestEnrichmentDegradesOnSourceFailure(t *testing.T) {
	handler := newEnrichedHandler(t,
		fakeSettingsReader{err: errors.New("settings db locked")},
		fakeSnapshotReader{err: errors.New("snapshot unreadable")},
		stubResolver{claudeAccountRef: nodeClaudeRef},
	)
	recorder := doRequest(handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("辅助源失败不应影响主数据: status = %d; body=%s", recorder.Code, recorder.Body.String())
	}
	body := decodeResponse(t, recorder)
	assertStrings(t, "unavailable_sources", body.UnavailableSources,
		[]string{unavailableSettings, unavailableSnapshot})
	if body.Labels != nil || body.SettingsUpdatedAtMS != 0 || body.SnapshotUpdatedAtMS != 0 {
		t.Fatalf("源失败时不应填充: labels=%v settings=%d snapshot=%d",
			body.Labels, body.SettingsUpdatedAtMS, body.SnapshotUpdatedAtMS)
	}
	for _, key := range []string{"labels", "setting", "context_limit", "probed_at_ms", "model_details"} {
		if !containsString(body.UnfilledFields, key) {
			t.Errorf("unfilled_fields 缺少 %q", key)
		}
	}
}

func TestEnrichmentDropsUntrustedProbeTimestamps(t *testing.T) {
	// accountProbeVersion=1 按整轮刷新打戳，会把没探测过的账号也标上，必须整表丢弃。
	raw := fmt.Sprintf(`{"accountProbeVersion": 1, "labels": {"claude": {"claude-sonnet": "Claude Sonnet"}},
		"accountUpdatedAt": {"%s": %d}}`, nodeClaudeRef, probedAtMS)
	snapshot := webuimodelssnapshot.Parse([]byte(raw))
	handler := newEnrichedHandler(t, nil, fakeSnapshotReader{snapshot: snapshot},
		stubResolver{claudeAccountRef: nodeClaudeRef})
	body := decodeResponse(t, doRequest(handler, http.MethodGet, Path))
	claude := findAccount(t, body, "claude", claudeAccountRef)
	if claude.ProbedAtMS != 0 {
		t.Fatalf("旧语义快照的 probed_at_ms = %d, want 0", claude.ProbedAtMS)
	}
	if body.Labels == nil {
		t.Fatal("旧语义只影响探测时刻，labels 仍应可用")
	}
}

func TestFieldCoverageIsPartitionForEverySourceCombination(t *testing.T) {
	cases := []struct {
		name     string
		settings bool
		snapshot bool
	}{
		{name: "无外部源"},
		{name: "只有设置", settings: true},
		{name: "只有快照", snapshot: true},
		{name: "两者都有", settings: true, snapshot: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var settingsReader SettingsReader
			var snapshotReader SnapshotReader
			if testCase.settings {
				settingsReader = fakeSettingsReader{settings: testSettings(t)}
			}
			if testCase.snapshot {
				snapshotReader = fakeSnapshotReader{snapshot: testSnapshot(t)}
			}
			enrich := newEnricher(context.Background(), nil, settingsReader, snapshotReader)
			filled, unfilled := enrich.fieldCoverage()

			filledKeys := make(map[string]bool, len(filled))
			for _, key := range filled {
				if key == "" || filledKeys[key] {
					t.Fatalf("filled_fields 存在空值或重复项: %v", filled)
				}
				if containsString(nodeOnlyFieldKeys, key) {
					t.Fatalf("无来源的 Node 键 %q 不应出现在 filled", key)
				}
				filledKeys[key] = true
			}
			unfilledKeys := make(map[string]bool, len(unfilled))
			for _, key := range unfilled {
				if key == "" || unfilledKeys[key] {
					t.Fatalf("unfilled_fields 存在空值或重复项: %v", unfilled)
				}
				unfilledKeys[key] = true
				if !containsString(dataFieldKeys, key) && !containsString(nodeOnlyFieldKeys, key) {
					t.Fatalf("unfilled_fields 出现未分类的键 %q", key)
				}
			}
			// 每个 schema 键必须且只能出现在一个清单里。
			for _, key := range dataFieldKeys {
				if filledKeys[key] == unfilledKeys[key] {
					t.Fatalf("键 %q 必须且只能出现在 filled / unfilled 之一", key)
				}
			}
			for _, key := range alwaysFieldKeys {
				if !filledKeys[key] {
					t.Errorf("基线键 %q 必须总是填充", key)
				}
			}
			for _, key := range nodeOnlyFieldKeys {
				if !unfilledKeys[key] {
					t.Errorf("无来源键 %q 必须留在 unfilled", key)
				}
			}
		})
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
