package webuiopenaimodelsapi

import (
	"context"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
)

// 本文件是本包的可选事实源层：把 modelcatalogsettings / webuimodelssnapshot /
// accountrefmap 合成 managed_data、labels 与设置时间戳，并由实际读到的源决定
// filled_fields / unfilled_fields。
//
// 三条原则：
//   - 源缺失时整块不填，绝不返回默认值冒充已知（例如没有设置文档时不推断 enabled）。
//   - 账号引用方向与 webuimodelsapi 相反：设置文档与快照由 Node 写入，用的是 Node
//     账号 ref，而本包的 account_ref 是 Go 的 acct_*，所以必须 Node→Go 翻译后才能对齐；
//     没有链接时 accountrefmap 按恒等回落，因此未同步账号仍然匹配。
//   - 读源失败只降级为空并记入 unavailable_sources，不影响 aih.db 的既有事实。

// SettingsReader 读 app-state.db 的 model-catalog-settings 文档。
type SettingsReader interface {
	ReadSettings(ctx context.Context) (modelcatalogsettings.Settings, error)
}

// SnapshotReader 读 WebUI 模型快照（cache:webui-models-snapshot.json）。
type SnapshotReader interface {
	ReadSnapshot(ctx context.Context) (*webuimodelssnapshot.Snapshot, error)
}

// AccountRefResolver 把 Node 账号引用翻译成 Go account_ref。
//
// accountrefmap.Resolver 直接满足本接口：没有链接时它按恒等回落，
// 与本包 identityRefs 的行为一致。
type AccountRefResolver interface {
	GoRef(nodeRef string) string
}

// SettingsFile 以 app-state.db 路径实现 SettingsReader。
type SettingsFile struct {
	DatabasePath string
}

// ReadSettings 读取并归一 model-catalog-settings。
func (file SettingsFile) ReadSettings(ctx context.Context) (modelcatalogsettings.Settings, error) {
	return modelcatalogsettings.Load(ctx, file.DatabasePath)
}

// SnapshotFile 以 app-state.db 路径实现 SnapshotReader。
type SnapshotFile struct {
	DatabasePath string
}

// ReadSnapshot 读取并归一模型快照。
func (file SnapshotFile) ReadSnapshot(ctx context.Context) (*webuimodelssnapshot.Snapshot, error) {
	reader, err := webuimodelssnapshot.NewReaderAt(file.DatabasePath)
	if err != nil {
		return nil, err
	}
	return reader.Read(ctx)
}

// identityRefs 是没有映射表时的翻译器：两侧引用本来就是同一个值。
type identityRefs struct{}

func (identityRefs) GoRef(nodeRef string) string { return strings.TrimSpace(nodeRef) }

// unavailable_sources 的取值：只放稳定的源名字，不回显错误文本（可能含路径）。
const (
	unavailableSettings = "model_catalog_settings"
	unavailableSnapshot = "webui_models_snapshot"
)

const (
	// managedSourceDiscovered 表示条目来自上游发现的模型目录。
	managedSourceDiscovered = "discovered"
	// managedSourceManual 表示条目来自人工添加的模型设置。
	managedSourceManual = "manual"
	// managedLegacyKeyPrefix 复刻 Node 对「无账号归属」记录的键前缀。
	managedLegacyKeyPrefix = "legacy"
)

// labelsView 是 provider → 模型 id → 上游显示名。
type labelsView map[string]map[string]string

// managedModelView 是一条 (账号, 模型) 维度的管理条目，对应 Node managedData 的一项。
//
// 只含有真值来源的键：enabled/manual/default_model/description/custom_pricing/updated_at_ms
// 来自设置文档，provider/account_ref 来自 Go 的账户模型或设置记录。Node 还会附加
// models.dev 的 metadata（价格、模态等），Go 没有该源，因此整体留在 unfilled_fields。
type managedModelView struct {
	ID            string                              `json:"id"`
	Provider      string                              `json:"provider"`
	AccountRef    string                              `json:"account_ref"`
	Enabled       bool                                `json:"enabled"`
	Manual        bool                                `json:"manual"`
	DefaultModel  bool                                `json:"default_model"`
	Source        string                              `json:"source"`
	Providers     []string                            `json:"providers"`
	Description   string                              `json:"description"`
	CustomPricing *modelcatalogsettings.CustomPricing `json:"custom_pricing,omitempty"`
	UpdatedAtMS   int64                               `json:"updated_at_ms"`
}

// enrichment 是本次请求的可选事实源快照（构造后只读）。
type enrichment struct {
	refs        AccountRefResolver
	settings    modelcatalogsettings.Settings
	hasSettings bool
	snapshot    *webuimodelssnapshot.Snapshot
	hasSnapshot bool
	unavailable []string

	// settingsByKey 以 (Go 账号引用, 小写模型 id) 为身份，与 Node
	// findAccountModelSetting 的口径一致：provider 不参与身份。
	settingsByKey map[string]modelcatalogsettings.AccountModel
	// legacyByModel 以小写模型 id 为键，保留文档顺序供「首个匹配」查询。
	legacyByModel map[string][]modelcatalogsettings.LegacyModel
}

// newEnrichment 读取可选事实源。任一源失败都只降级为空并记入 unavailable，不影响主数据。
func newEnrichment(
	ctx context.Context,
	refs AccountRefResolver,
	settingsReader SettingsReader,
	snapshotReader SnapshotReader,
) *enrichment {
	enrich := &enrichment{refs: refs}
	if enrich.refs == nil {
		enrich.refs = identityRefs{}
	}
	if settingsReader != nil {
		settings, err := settingsReader.ReadSettings(ctx)
		switch {
		case err != nil:
			enrich.unavailable = append(enrich.unavailable, unavailableSettings)
		case len(settings.AccountModels) > 0 || len(settings.LegacyModels) > 0 || settings.UpdatedAtMS > 0:
			// 键缺失与空文档都不算「有设置事实」：否则会用默认值把 managed_data 伪装成已知。
			enrich.settings = settings
			enrich.hasSettings = true
			enrich.settingsByKey = enrich.indexSettings(settings.AccountModels)
			enrich.legacyByModel = indexLegacyModels(settings.LegacyModels)
		}
	}
	if snapshotReader != nil {
		snapshot, err := snapshotReader.ReadSnapshot(ctx)
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

// indexSettings 把设置记录按 (Go 账号引用, 小写模型 id) 建索引；重复身份保留先出现者，
// 与 Node 的 find（返回首个匹配）一致。
func (enrich *enrichment) indexSettings(records []modelcatalogsettings.AccountModel) map[string]modelcatalogsettings.AccountModel {
	index := make(map[string]modelcatalogsettings.AccountModel, len(records))
	for _, record := range records {
		key := managedKey(enrich.goRef(record.AccountRef), record.ID)
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

func indexLegacyModels(records []modelcatalogsettings.LegacyModel) map[string][]modelcatalogsettings.LegacyModel {
	index := make(map[string][]modelcatalogsettings.LegacyModel, len(records))
	for _, record := range records {
		model := strings.ToLower(strings.TrimSpace(record.ID))
		if model == "" {
			continue
		}
		index[model] = append(index[model], record)
	}
	return index
}

// goRef 把设置/快照里的 Node 账号引用翻译成 Go account_ref。
func (enrich *enrichment) goRef(nodeRef string) string {
	if enrich == nil || enrich.refs == nil {
		return strings.TrimSpace(nodeRef)
	}
	return strings.TrimSpace(enrich.refs.GoRef(nodeRef))
}

// setting 返回 (Go 账号引用, 模型 id) 对应的设置记录。
func (enrich *enrichment) setting(accountRef string, modelID string) (modelcatalogsettings.AccountModel, bool) {
	if enrich == nil || !enrich.hasSettings {
		return modelcatalogsettings.AccountModel{}, false
	}
	key := managedKey(accountRef, modelID)
	if key == "" {
		return modelcatalogsettings.AccountModel{}, false
	}
	record, ok := enrich.settingsByKey[key]
	return record, ok
}

// legacyEnabled 复刻 Node isModelEnabled 的回落：无记录即启用，provider 为空表示通配。
func (enrich *enrichment) legacyEnabled(modelID string, provider string) bool {
	if enrich == nil || !enrich.hasSettings {
		return true
	}
	candidates := enrich.legacyByModel[strings.ToLower(strings.TrimSpace(modelID))]
	for _, record := range candidates {
		if record.Provider == "" || provider == "" || record.Provider == provider {
			return record.Enabled
		}
	}
	return true
}

// managedKey 复刻 Node 的管理条目身份：(账号引用, 小写模型 id)，无账号归属时用 legacy 前缀。
func managedKey(accountRef string, modelID string) string {
	model := strings.ToLower(strings.TrimSpace(modelID))
	if model == "" {
		return ""
	}
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return managedLegacyKeyPrefix + "\x00" + model
	}
	return ref + "\x00" + model
}

// managedRecord 是构造 managed_data 时的中间态（键已确定，设置字段稍后合并）。
type managedRecord struct {
	id         string
	provider   string
	accountRef string
	source     string
	manual     bool
}

// managedData 构造 Node managedData 的 Go 子集。
//
// 条目集合 = 账号模型目录的全部 (账号, 模型) ∪ 设置文档里的手动记录（含已离开运行池的
// 账号与无账号归属的 legacy 记录），按 Node 的口径去重、排序。这里是管理视图而不是路由
// 视图：被停用的模型仍然出现（enabled=false），否则管理员无法把它重新打开。
func (enrich *enrichment) managedData(catalog accountapp.AccountModelCatalog) []managedModelView {
	if enrich == nil || !enrich.hasSettings {
		return nil
	}
	records := make(map[string]*managedRecord, len(catalog.Sets))
	order := make([]string, 0, len(catalog.Sets))
	for _, set := range catalog.Sets {
		provider := strings.TrimSpace(set.ProviderID)
		accountRef := set.AccountRef.String()
		for _, model := range set.Models {
			modelID := model.ModelID().String()
			key := managedKey(accountRef, modelID)
			if key == "" {
				continue
			}
			record, exists := records[key]
			if !exists {
				records[key] = &managedRecord{
					id:         modelID,
					provider:   provider,
					accountRef: accountRef,
					source:     managedSourceDiscovered,
				}
				order = append(order, key)
				continue
			}
			if record.provider == "" {
				record.provider = provider
			}
		}
	}
	enrich.addManualRecords(records, &order)

	views := make([]managedModelView, 0, len(order))
	for _, key := range order {
		views = append(views, enrich.newManagedModelView(records[key]))
	}
	sort.Slice(views, func(left, right int) bool {
		if views[left].Provider != views[right].Provider {
			return views[left].Provider < views[right].Provider
		}
		if views[left].AccountRef != views[right].AccountRef {
			return views[left].AccountRef < views[right].AccountRef
		}
		return views[left].ID < views[right].ID
	})
	return views
}

// addManualRecords 合入设置文档里的手动记录：已存在的条目只升级 provider/source/manual，
// 与 Node buildManagedModelItems 的 addEntry 同语义。
func (enrich *enrichment) addManualRecords(records map[string]*managedRecord, order *[]string) {
	add := func(accountRef string, modelID string, provider string) {
		key := managedKey(accountRef, modelID)
		if key == "" {
			return
		}
		if existing, ok := records[key]; ok {
			if provider != "" {
				existing.provider = provider
			}
			existing.source = managedSourceManual
			existing.manual = true
			return
		}
		records[key] = &managedRecord{
			id:         modelID,
			provider:   provider,
			accountRef: accountRef,
			source:     managedSourceManual,
			manual:     true,
		}
		*order = append(*order, key)
	}
	for _, record := range enrich.settings.AccountModels {
		if !record.Manual {
			continue
		}
		add(enrich.goRef(record.AccountRef), record.ID, record.Provider)
	}
	for _, record := range enrich.settings.LegacyModels {
		if !record.Manual {
			continue
		}
		add("", record.ID, record.Provider)
	}
}

// newManagedModelView 把中间态与设置记录合成一条管理条目。
func (enrich *enrichment) newManagedModelView(record *managedRecord) managedModelView {
	view := managedModelView{
		ID:         record.id,
		Provider:   record.provider,
		AccountRef: record.accountRef,
		// 没有设置记录时沿用 Node 的默认：上游发现的模型默认启用。
		Enabled:   true,
		Manual:    record.manual,
		Source:    record.source,
		Providers: providerList(record.provider),
	}
	setting, hasSetting := enrich.setting(record.accountRef, record.id)
	if !hasSetting {
		view.Enabled = enrich.legacyEnabled(record.id, record.provider)
		return view
	}
	view.Enabled = setting.Enabled
	view.Manual = record.manual || setting.Manual
	view.DefaultModel = setting.DefaultModel
	view.Description = setting.Description
	view.CustomPricing = setting.CustomPricing
	view.UpdatedAtMS = setting.UpdatedAtMS
	if setting.Manual {
		view.Source = managedSourceManual
	}
	return view
}

func providerList(provider string) []string {
	if provider == "" {
		return []string{}
	}
	return []string{provider}
}

// labelProjection 只投影本次响应里出现过的 provider：快照可能残留已删除 Provider 的
// 显示名，原样输出会让调用方以为还有账号。
func (enrich *enrichment) labelProjection(providerIDs []string) *labelsView {
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

// settingsUpdatedAtMS 只在真正读到设置事实时才返回。
func (enrich *enrichment) settingsUpdatedAtMS() (int64, bool) {
	if enrich == nil || !enrich.hasSettings {
		return 0, false
	}
	return enrich.settings.UpdatedAtMS, true
}

func (enrich *enrichment) unavailableSources() []string {
	sources := make([]string, 0, 2)
	if enrich == nil {
		return sources
	}
	return append(sources, enrich.unavailable...)
}
