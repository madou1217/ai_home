package webuimodelsapi

import (
	"context"
	"sort"
	"strings"

	pricingcontract "github.com/madou1217/ai_home/contracts/modelpricing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelcatalogsettings"
	"github.com/madou1217/ai_home/application/modelsnapshot"
)

// 本文件是本包的「可选事实源」层：把 modelcatalogsettings / 快照端口 /
// accountrefmap 合成一个按账号查询的只读视图，并由它决定 filled_fields / unfilled_fields。
//
// 原则：外部事实源缺失时整块不填，绝不返回空对象冒充已知；哪些键被真正填上由实际
// 读到的源决定，因此两个字段清单永远互为补集。

// SettingsReader 读 app-state.db 的 model-catalog-settings 文档。
type SettingsReader interface {
	ReadSettings(ctx context.Context) (modelcatalogsettings.Settings, error)
}

// AccountRefResolver 把 Go account_ref 翻译成 Node 账号引用。
//
// accountrefmap.Resolver 直接满足本接口；没有链接时它按恒等回落，与本包零值行为一致。
type AccountRefResolver interface {
	NodeRef(goRef string) string
}

// identityRefs 是没有同步链接表时的翻译器：两侧引用本来就是同一个值。
type identityRefs struct{}

func (identityRefs) NodeRef(goRef string) string { return strings.TrimSpace(goRef) }

// unavailable_sources 的取值：只放稳定的源名字，不回显错误文本（可能含路径）。
const (
	unavailableSettings = "model_catalog_settings"
	unavailableSnapshot = "webui_models_snapshot"
)

// modelView 是单个模型在某个账号下的可证实事实。
//
// 只放有真值来源的键：label 由快照按 provider 提供（见顶层 labels），context_limit 来自
// 快照的 contextLimits，setting 来自设置文档里该 (账号, 模型) 的记录。缺失就是缺失，
// 不用默认值填充。
type modelView struct {
	ModelID      string                    `json:"model_id"`
	ContextLimit int                       `json:"context_limit,omitempty"`
	Setting      *modelSettingView         `json:"setting,omitempty"`
	Metadata     *pricingcontract.Metadata `json:"metadata,omitempty"`
}

// modelSettingView 是一条 (账号, 模型) 设置记录。
//
// custom_pricing 直接复用持久化文档的类型：它的 JSON 键（cacheRead/cacheWrite）就是
// app-state 里的既有形状，翻译一层只会引入偏差。
type modelSettingView struct {
	Enabled       bool                                `json:"enabled"`
	Manual        bool                                `json:"manual"`
	DefaultModel  bool                                `json:"default_model"`
	Description   string                              `json:"description,omitempty"`
	CustomPricing *modelcatalogsettings.CustomPricing `json:"custom_pricing,omitempty"`
	UpdatedAtMS   int64                               `json:"updated_at_ms"`
}

// enricher 是本次请求的可选事实源快照（构造后只读）。
type enricher struct {
	ctx         context.Context
	metadata    pricingcontract.Resolver
	hasMetadata bool
	refs        AccountRefResolver
	settings    modelcatalogsettings.Settings
	hasSettings bool
	snapshot    *modelsnapshot.Snapshot
	hasSnapshot bool
	unavailable []string

	// settingsByKey 以 (Node 账号引用, 小写模型 id) 为身份，与 Node
	// findAccountModelSetting 的口径一致：provider 不参与身份。
	settingsByKey map[string]modelcatalogsettings.AccountModel
}

// newEnricher 读取可选事实源。任一源失败都只降级为空并记入 unavailable，不影响主数据。
func newEnricher(
	ctx context.Context,
	refs AccountRefResolver,
	settingsReader SettingsReader,
	snapshotReader modelsnapshot.Reader,
	metadataReader pricingcontract.Resolver,
) *enricher {
	enrich := &enricher{ctx: ctx, refs: refs, metadata: metadataReader}
	if enrich.refs == nil {
		enrich.refs = identityRefs{}
	}
	if settingsReader != nil {
		// 键缺失与文档为空都返回空设置：没有记录时不算「有设置事实」，
		// 否则会用一堆空值把 settings_* 伪装成已知。
		settings, err := settingsReader.ReadSettings(ctx)
		switch {
		case err != nil:
			enrich.unavailable = append(enrich.unavailable, unavailableSettings)
		case len(settings.AccountModels) > 0 || settings.UpdatedAtMS > 0:
			enrich.settings = settings
			enrich.hasSettings = true
			enrich.settingsByKey = indexAccountSettings(settings.AccountModels)
		}
	}
	if snapshotReader != nil {
		snapshot, err := snapshotReader.Read(ctx)
		switch {
		case err != nil || snapshot == nil || !snapshot.Available:
			enrich.unavailable = append(enrich.unavailable, unavailableSnapshot)
		default:
			enrich.snapshot = snapshot
			enrich.hasSnapshot = true
		}
	}
	sort.Strings(enrich.unavailable)
	return enrich
}

func indexAccountSettings(records []modelcatalogsettings.AccountModel) map[string]modelcatalogsettings.AccountModel {
	index := make(map[string]modelcatalogsettings.AccountModel, len(records))
	for _, record := range records {
		key := settingKey(record.AccountRef, record.ID)
		if key == "" {
			continue
		}
		if _, exists := index[key]; exists {
			continue
		}
		index[key] = record
	}
	return index
}

// settingKey 复刻 Node 的设置身份：(规范账号引用, 小写模型 id)。
func settingKey(accountRef string, modelID string) string {
	ref := strings.TrimSpace(accountRef)
	model := strings.ToLower(strings.TrimSpace(modelID))
	if ref == "" || model == "" {
		return ""
	}
	return ref + "\x00" + model
}

func (enrich *enricher) nodeRef(goRef string) string {
	if enrich == nil {
		return strings.TrimSpace(goRef)
	}
	return strings.TrimSpace(enrich.refs.NodeRef(goRef))
}

func (enrich *enricher) setting(nodeRef string, modelID string) (modelcatalogsettings.AccountModel, bool) {
	if enrich == nil || !enrich.hasSettings {
		return modelcatalogsettings.AccountModel{}, false
	}
	key := settingKey(nodeRef, modelID)
	if key == "" {
		return modelcatalogsettings.AccountModel{}, false
	}
	record, ok := enrich.settingsByKey[key]
	return record, ok
}

func (enrich *enricher) contextLimit(nodeRef string, modelID string) (int, bool) {
	if enrich == nil || !enrich.hasSnapshot {
		return 0, false
	}
	return enrich.snapshot.ContextLimit(nodeRef, modelID)
}

func (enrich *enricher) probedAtMS(nodeRef string) int64 {
	if enrich == nil || !enrich.hasSnapshot {
		return 0
	}
	probedAt, ok := enrich.snapshot.ProbedAt(nodeRef)
	if !ok {
		return 0
	}
	return probedAt.UnixMilli()
}

func (enrich *enricher) settingsUpdatedAtMS() int64 {
	if enrich == nil || !enrich.hasSettings {
		return 0
	}
	return enrich.settings.UpdatedAtMS
}

func (enrich *enricher) snapshotUpdatedAtMS() int64 {
	if enrich == nil || !enrich.hasSnapshot {
		return 0
	}
	return enrich.snapshot.UpdatedAtMS
}

func (enrich *enricher) unavailableSources() []string {
	sources := make([]string, 0, 4)
	if enrich == nil {
		return sources
	}
	return append(sources, enrich.unavailable...)
}

// modelDetails 返回账号下每个模型的可证实事实；两个源都没有时返回 nil（键整体省略）。
func (enrich *enricher) modelDetails(providerID, nodeRef string, models []accountapp.AccountModel) []modelView {
	if enrich == nil || (!enrich.hasSettings && !enrich.hasSnapshot) {
		return nil
	}
	details := make([]modelView, 0, len(models))
	for _, model := range models {
		modelID := model.ModelID().String()
		detail := modelView{ModelID: modelID}
		if tokens, ok := enrich.contextLimit(nodeRef, modelID); ok {
			detail.ContextLimit = tokens
		}
		if record, ok := enrich.setting(nodeRef, modelID); ok {
			detail.Setting = newModelSettingView(record)
		}
		if metadata, ok := enrich.resolveMetadata(providerID, modelID); ok {
			detail.Metadata = metadata
		}
		details = append(details, detail)
	}
	sort.Slice(details, func(left, right int) bool {
		return details[left].ModelID < details[right].ModelID
	})
	return details
}

func newModelSettingView(record modelcatalogsettings.AccountModel) *modelSettingView {
	return &modelSettingView{
		Enabled:       record.Enabled,
		Manual:        record.Manual,
		DefaultModel:  record.DefaultModel,
		Description:   record.Description,
		CustomPricing: record.CustomPricing,
		UpdatedAtMS:   record.UpdatedAtMS,
	}
}

// resolveMetadata 通过插件契约读取模型展示元数据；未知与失败都返回未命中，
// 不伪造来源，也不在核心代码里绑定任何具体插件实现。
func (enrich *enricher) resolveMetadata(providerID, modelID string) (*pricingcontract.Metadata, bool) {
	if enrich == nil || enrich.metadata == nil || providerID == "" || modelID == "" {
		return nil, false
	}
	ctx := enrich.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	resolved, err := enrich.metadata.ResolveMetadata(ctx, pricingcontract.MetadataRequest{
		SchemaVersion: pricingcontract.WireSchemaVersion,
		Kind:          "metadata",
		ModelRef: pricingcontract.ModelRef{
			Provider: providerID,
			Model:    modelID,
		},
	})
	if err != nil || resolved.MetadataStatus != pricingcontract.MetadataResolved {
		return nil, false
	}
	enrich.hasMetadata = true
	copy := resolved
	return &copy, true
}

// labels 只投影本次响应里出现过的 provider：快照可能残留已删除 Provider 的显示名，
// 原样输出会让调用方以为还有账号。
func (enrich *enricher) labels(providerIDs []string) *labelsView {
	if enrich == nil || !enrich.hasSnapshot {
		return nil
	}
	view := labelsView{}
	for _, providerID := range providerIDs {
		byModel := enrich.snapshot.Labels[providerID]
		if len(byModel) == 0 {
			continue
		}
		copied := make(map[string]string, len(byModel))
		for modelID, label := range byModel {
			copied[modelID] = label
		}
		view[providerID] = copied
	}
	return &view
}

// 字段清单分组。filled_fields 与 unfilled_fields 都由这些组派生，
// 因此新增字段时只需改分组，不会出现两边都写或两边都漏。
var (
	// alwaysFieldKeys 只依赖 Go 账号模型事实表，永远填充。
	alwaysFieldKeys = []string{
		"generation",
		"catalog_updated_at_ms",
		"providers",
		"provider_id",
		"accounts",
		"account_ref",
		"model_ids",
		"effective_model_ids",
		"last_attempt_at_ms",
		"last_error_code",
		"last_error_message",
		"last_source",
		"last_model_count",
		"unavailable_sources",
	}
	// settingsFieldKeys 需要 model-catalog-settings 文档。
	settingsFieldKeys = []string{
		"settings_updated_at_ms",
		"setting",
		"enabled",
		"manual",
		"default_model",
		"description",
		"custom_pricing",
		"updated_at_ms",
	}
	// snapshotFieldKeys 需要 WebUI 模型快照。
	snapshotFieldKeys = []string{
		"snapshot_updated_at_ms",
		"labels",
		"probed_at_ms",
		"context_limit",
	}
	// metadataFieldKeys 需要 model.metadata 插件返回 resolved 元数据。
	metadataFieldKeys = []string{"metadata"}
	// detailFieldKeys 需要两个源之一：model_details 容器本身没有任何单一源独占。
	detailFieldKeys = []string{
		"model_details",
		"model_id",
	}
)

// legacyUnfilledFieldKeys 是 Node 契约里有、Go 侧没有任何真值来源的键。
//
// 它们不出现在本响应的 JSON 里，但必须始终列进 unfilled_fields：那正是本接口
// 「不伪造全量形状」的承诺（原因见 handler.go 的 unfilled 说明）。
var legacyUnfilledFieldKeys = []string{
	"models",
	"selectableByAccountRef",
	"defaultByAccountRef",
	"errorsByAccountRef",
	"cached",
	"source",
	"sources",
	"scannedAccounts",
	"firstError",
	"accountScope",
	"managedData",
}

// dataFieldKeys 是本响应 JSON 里可能出现的全部数据键
// （不含 ok/derived_by/data_source 与两个字段清单本身）。
var dataFieldKeys = buildDataFieldKeys()

func buildDataFieldKeys() []string {
	keys := make([]string, 0, 32)
	for _, group := range [][]string{alwaysFieldKeys, settingsFieldKeys, snapshotFieldKeys, detailFieldKeys, metadataFieldKeys} {
		keys = append(keys, group...)
	}
	return keys
}

// fieldCoverage 按本次实际读到的源切分 filled_fields / unfilled_fields。
// 两个清单是 dataFieldKeys 的一个划分：不重叠、不缺项。
func (enrich *enricher) fieldCoverage() (filled []string, unfilled []string) {
	present := make(map[string]bool, len(dataFieldKeys))
	for _, key := range alwaysFieldKeys {
		present[key] = true
	}
	if enrich != nil && enrich.hasSettings {
		for _, key := range settingsFieldKeys {
			present[key] = true
		}
	}
	if enrich != nil && enrich.hasSnapshot {
		for _, key := range snapshotFieldKeys {
			present[key] = true
		}
	}
	if enrich != nil && (enrich.hasSettings || enrich.hasSnapshot) {
		for _, key := range detailFieldKeys {
			present[key] = true
		}
	}
	if enrich != nil && enrich.hasMetadata {
		present["metadata"] = true
	}
	filled = make([]string, 0, len(dataFieldKeys))
	unfilled = make([]string, 0, len(dataFieldKeys)+len(legacyUnfilledFieldKeys))
	unfilled = append(unfilled, legacyUnfilledFieldKeys...)
	for _, key := range dataFieldKeys {
		if present[key] {
			filled = append(filled, key)
			continue
		}
		unfilled = append(unfilled, key)
	}
	return filled, unfilled
}
