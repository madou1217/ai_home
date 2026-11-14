package chatruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
	"github.com/madou1217/ai_home/internal/transport/http/webuislashcommandsapi"
)

const (
	// ChatCompletionsEntryID 与 JS capability-routed-driver.js 的入口标识一致。
	ChatCompletionsEntryID = "gateway.openai.chat_completions"

	RouteTargetGo       = "go"
	RouteTargetFallback = "fallback"
)

var queueCatalogCommandTypes = []string{
	"queue.add",
	"queue.edit",
	"queue.remove",
	"queue.move",
	"queue.dispatch",
}

// CommandCatalogEntry 描述 GET /sessions/{id}/commands/catalog 返回的单个命令项。
type CommandCatalogEntry struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Mode    string `json:"mode,omitempty"`
	Name    string `json:"name,omitempty"`
	Command string `json:"command,omitempty"`
}

// CommandCatalog 按会话能力快照与分支能力生成可执行命令目录。
type CommandCatalog interface {
	List(ctx context.Context, session *Session, supportsHistoryBranch bool) []CommandCatalogEntry
}

// CapabilityCommandCatalog 是默认的基于 capabilitySnapshot 的命令目录实现。
type CapabilityCommandCatalog struct{}

// NewCapabilityCommandCatalog 创建能力命令目录。
func NewCapabilityCommandCatalog() *CapabilityCommandCatalog {
	return &CapabilityCommandCatalog{}
}

// List 按能力快照列出会话当前支持的全部命令（对齐 JS capability-command-catalog.js）。
func (c *CapabilityCommandCatalog) List(_ context.Context, session *Session, supportsHistoryBranch bool) []CommandCatalogEntry {
	var snap map[string]any
	if session != nil {
		snap = session.CapabilitySnapshot
	}
	commands := []CommandCatalogEntry{
		{ID: "turn.submit", Type: "turn.submit"},
		{ID: "turn.retry", Type: "turn.retry"},
	}
	if IsChatSession(session) || supportsHistoryBranch {
		commands = append(commands,
			CommandCatalogEntry{ID: "session.fork", Type: "session.fork"},
			CommandCatalogEntry{ID: "turn.regenerate", Type: "turn.regenerate"},
		)
	}
	if capabilitySupported(snap, "turn.interrupt") {
		commands = append(commands, CommandCatalogEntry{ID: "turn.interrupt", Type: "turn.interrupt"})
	}
	if snap != nil {
		for _, mode := range uniqueCatalogStrings(snap["turnInterveneModes"]) {
			commands = append(commands, CommandCatalogEntry{
				ID:   "turn.intervene:" + mode,
				Type: "turn.intervene",
				Mode: mode,
			})
		}
	}
	if capabilitySupported(snap, "turn.queue") {
		for _, qType := range queueCatalogCommandTypes {
			commands = append(commands, CommandCatalogEntry{ID: qType, Type: qType})
		}
	}
	if capabilitySupported(snap, "session.goal") {
		for _, gType := range []string{"session.goal.set", "session.goal.get", "session.goal.clear"} {
			commands = append(commands, CommandCatalogEntry{ID: gType, Type: gType})
		}
	}
	if snap != nil {
		for _, name := range uniqueCatalogStrings(snap["slashCommands"]) {
			commands = append(commands, CommandCatalogEntry{
				ID:      "slash:" + name,
				Type:    "slash.execute",
				Name:    name,
				Command: "/" + name,
			})
		}
	}
	return commands
}

func capabilitySupported(snapshot map[string]any, capability string) bool {
	if snapshot == nil {
		return false
	}
	caps, _ := snapshot["capabilities"].(map[string]any)
	if caps == nil {
		return false
	}
	desc, _ := caps[capability].(map[string]any)
	if desc == nil {
		return false
	}
	support := stringField(desc, "support")
	return support == "native" || support == "emulated"
}

func uniqueCatalogStrings(raw any) []string {
	items, ok := raw.([]any)
	if !ok {
		if strSlice, ok2 := raw.([]string); ok2 {
			seen := make(map[string]struct{}, len(strSlice))
			out := make([]string, 0, len(strSlice))
			for _, v := range strSlice {
				trimmed := strings.TrimSpace(v)
				if trimmed == "" {
					continue
				}
				if _, dup := seen[trimmed]; !dup {
					seen[trimmed] = struct{}{}
					out = append(out, trimmed)
				}
			}
			return out
		}
		return nil
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, entry := range items {
		str, _ := entry.(string)
		trimmed := strings.TrimSpace(str)
		if trimmed == "" {
			continue
		}
		if _, dup := seen[trimmed]; !dup {
			seen[trimmed] = struct{}{}
			out = append(out, trimmed)
		}
	}
	return out
}

// SlashPassthroughAuthorizer 允许进程内复用的 webuislashcommandsapi handler 免外部网络鉴权。
type slashLoopbackAuthorizer struct{}

func (slashLoopbackAuthorizer) Authorized(*http.Request) bool { return true }

// ProviderSlashCommandNames 返回指定 provider 可用于工作区输入框的 slash 命令名（无前导 `/`）。
func ProviderSlashCommandNames(hostHomeDir, provider string) []string {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if normalized == "" || strings.TrimSpace(hostHomeDir) == "" {
		return []string{}
	}
	handler, err := webuislashcommandsapi.NewHandler(webuislashcommandsapi.Dependencies{
		Authorizer:  slashLoopbackAuthorizer{},
		HostHomeDir: hostHomeDir,
	})
	if err != nil {
		return []string{}
	}
	req := httptest.NewRequest(http.MethodGet, webuislashcommandsapi.Path+"?provider="+url.QueryEscape(normalized), nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		return []string{}
	}
	var payload struct {
		Commands []webuislashcommandsapi.Command `json:"commands"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &payload) != nil {
		return []string{}
	}
	out := make([]string, 0, len(payload.Commands))
	seen := make(map[string]struct{}, len(payload.Commands))
	for _, cmd := range payload.Commands {
		name := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(cmd.Command, "/")))
		if name == "" {
			continue
		}
		if _, dup := seen[name]; !dup {
			seen[name] = struct{}{}
			out = append(out, name)
		}
	}
	return out
}

// ComposerModelEntry 描述前端模型选择器中的单条模型选项。
type ComposerModelEntry struct {
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	SupportedEfforts []string `json:"supportedEfforts"`
	DefaultEffort    string   `json:"defaultEffort"`
}

// ComposerCatalog 描述 GET /sessions/{id}/composer/catalog 的 catalog 对象。
type ComposerCatalog struct {
	SessionID    string               `json:"sessionId,omitempty"`
	Models       []ComposerModelEntry `json:"models"`
	DefaultModel string               `json:"defaultModel"`
}

// ModelEntry 描述网关/工作区目录内单个模型的详细信息。
type ModelEntry struct {
	Model                     string
	DisplayName               string
	IsDefault                 bool
	SupportedReasoningEfforts []string
	DefaultReasoningEffort    string
	ContextWindow             int
}

// TurnModelSettings 表示经过目录校验和推理强度对齐后的轮次模型设置。
type TurnModelSettings struct {
	Model           string
	ReasoningEffort string
	ThreadConfig    map[string]any
}

// AccountPoolReader 提供账号概览与账号模型读端口（通常由 sqliteaccount.Store 满足）。
type AccountPoolReader interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
	ListAccountOverviews(ctx context.Context, query accountapp.OverviewQuery) ([]accountapp.AccountOverview, error)
}

// AccountModelCarrier 表示能够承载某个模型的账号及其 Provider。
type AccountModelCarrier struct {
	AccountRef string
	Provider   string
}

// AccountModelIndex 汇总当前启用模型与账号/Provider 的倒排关系。
type AccountModelIndex struct {
	BuiltAt          int64
	AccountProvider  map[string]string
	ModelsByAccount  map[string][]string
	AccountsByModel  map[string][]AccountModelCarrier
	GlobalModels     []string
	ContextByAccount map[string]map[string]int
}

// ModelCatalogResolver 负责从 Go 账号库、app-state 设置/快照与 models.dev 构建模型目录并对齐推理强度。
type ModelCatalogResolver struct {
	AIHomeDir     string
	Catalog       *providers.Catalog
	AccountStore  AccountPoolReader
	MetadataIndex *modelsdev.Index
}

// BuildAccountModelIndex 构建模型-账号索引及启用的全局/账号模型视图。
func (r *ModelCatalogResolver) BuildAccountModelIndex(ctx context.Context) (*AccountModelIndex, error) {
	idx := &AccountModelIndex{
		BuiltAt:          1, // non-zero sentinel; overwritten below
		AccountProvider:  map[string]string{},
		ModelsByAccount:  map[string][]string{},
		AccountsByModel:  map[string][]AccountModelCarrier{},
		ContextByAccount: map[string]map[string]int{},
	}
	var overviews []accountapp.AccountOverview
	var accountModels accountapp.AccountModelCatalog
	if r != nil && r.AccountStore != nil {
		// 首页查询也必须带合法 limit：OverviewQuery 的零值 limit=0，会被
		// ListAccountOverviews 判成 ErrInvalidOverview，纯聊天 composer 目录
		// 会因此直接 500（账号管理投影无效）。
		after, queryErr := accountapp.NewOverviewQuery("", accountapp.DefaultOverviewLimit)
		if queryErr != nil {
			return nil, queryErr
		}
		for {
			page, pageErr := r.AccountStore.ListAccountOverviews(ctx, after)
			if pageErr != nil {
				return nil, pageErr
			}
			if len(page) == 0 {
				break
			}
			overviews = append(overviews, page...)
			if len(page) < accountapp.DefaultOverviewLimit {
				break
			}
			next, nextErr := accountapp.NewOverviewQuery(page[len(page)-1].Account().Ref(), accountapp.DefaultOverviewLimit)
			if nextErr != nil {
				break
			}
			after = next
		}
		var err error
		accountModels, err = r.AccountStore.ListAllAccountModels(ctx)
		if err != nil {
			return nil, err
		}
	}

	resolver := loadAccountRefResolver(ctx, r.aiHomeDirSafe())
	dbPath := resolveAppStateDBPathSafe(r.aiHomeDirSafe())
	settings := loadCatalogSettingsSafe(ctx, dbPath)
	snapshot := loadWebUISnapshotSafe(ctx, dbPath)

	for _, overview := range overviews {
		ref := overview.Account().Ref().String()
		prov := strings.ToLower(strings.TrimSpace(overview.Account().ProviderID()))
		if ref != "" && prov != "" {
			idx.AccountProvider[ref] = prov
		}
	}
	for _, set := range accountModels.Sets {
		ref := set.AccountRef.String()
		prov := strings.ToLower(strings.TrimSpace(set.ProviderID))
		if ref != "" && prov != "" && idx.AccountProvider[ref] == "" {
			idx.AccountProvider[ref] = prov
		}
	}

	settingEnabled := buildSettingEnabledIndex(settings.AccountModels, resolver)

	addModelForAccount := func(ref, prov, modelID string) {
		trimmedModel := strings.TrimSpace(modelID)
		trimmedRef := strings.TrimSpace(ref)
		trimmedProv := strings.ToLower(strings.TrimSpace(prov))
		if trimmedRef == "" || trimmedProv == "" || trimmedModel == "" {
			return
		}
		if idx.AccountProvider[trimmedRef] == "" {
			idx.AccountProvider[trimmedRef] = trimmedProv
		}
		if !slices.Contains(idx.ModelsByAccount[trimmedRef], trimmedModel) {
			idx.ModelsByAccount[trimmedRef] = append(idx.ModelsByAccount[trimmedRef], trimmedModel)
		}
		key := trimmedRef + "\x00" + trimmedModel
		exists := false
		for _, c := range idx.AccountsByModel[trimmedModel] {
			if c.AccountRef+"\x00"+trimmedModel == key {
				exists = true
				break
			}
		}
		if !exists {
			idx.AccountsByModel[trimmedModel] = append(idx.AccountsByModel[trimmedModel], AccountModelCarrier{
				AccountRef: trimmedRef,
				Provider:   trimmedProv,
			})
		}
	}

	// 1. SQLite account_models (only selectable & enabled models)
	for _, set := range accountModels.Sets {
		ref := set.AccountRef.String()
		prov := strings.ToLower(strings.TrimSpace(set.ProviderID))
		if prov == "" {
			prov = idx.AccountProvider[ref]
		}
		for _, m := range set.Models {
			id := m.ModelID().String()
			if m.ManualPolicy() == accountapp.ModelPolicyForceDisable {
				continue
			}
			if enabled, has := lookupSettingEnabled(settingEnabled, resolver, ref, id); has && !enabled {
				continue
			}
			if m.UpstreamAvailable() || m.ManualPolicy() == accountapp.ModelPolicyForceEnable {
				addModelForAccount(ref, prov, id)
			}
		}
	}

	// 2. app-state WebUI snapshot fallback / supplement
	if snapshot != nil && snapshot.Available {
		for snapKey, snapModels := range snapshot.ByAccount {
			ref := mapAccountRefKey(snapKey, idx.AccountProvider, resolver)
			prov := idx.AccountProvider[ref]
			for _, modelID := range snapModels {
				trimmed := strings.TrimSpace(modelID)
				if trimmed == "" {
					continue
				}
				if enabled, has := lookupSettingEnabled(settingEnabled, resolver, ref, trimmed); has && !enabled {
					continue
				}
				addModelForAccount(ref, prov, trimmed)
			}
		}
		for snapKey, limitMap := range snapshot.ContextLimits {
			ref := mapAccountRefKey(snapKey, idx.AccountProvider, resolver)
			if ref == "" {
				continue
			}
			if idx.ContextByAccount[ref] == nil {
				idx.ContextByAccount[ref] = map[string]int{}
			}
			for m, ctxLen := range limitMap {
				if ctxLen > 0 {
					idx.ContextByAccount[ref][m] = ctxLen
				}
			}
		}
	}

	// 3. 手工登记且启用的模型
	for _, rec := range settings.AccountModels {
		if !rec.Manual || !rec.Enabled {
			continue
		}
		ref := mapAccountRefKey(rec.AccountRef, idx.AccountProvider, resolver)
		if ref == "" {
			ref = strings.TrimSpace(rec.AccountRef)
		}
		prov := strings.ToLower(strings.TrimSpace(rec.Provider))
		if prov == "" {
			prov = idx.AccountProvider[ref]
		}
		addModelForAccount(ref, prov, rec.ID)
	}

	globalSet := make(map[string]struct{})
	for ref, models := range idx.ModelsByAccount {
		sort.Strings(models)
		idx.ModelsByAccount[ref] = models
		for _, m := range models {
			globalSet[m] = struct{}{}
		}
	}
	idx.GlobalModels = make([]string, 0, len(globalSet))
	for m := range globalSet {
		idx.GlobalModels = append(idx.GlobalModels, m)
	}
	sort.Strings(idx.GlobalModels)
	return idx, nil
}

// ListGatewayModels 列出某个对话/账号作用域下可选的模型及元数据。
func (r *ModelCatalogResolver) ListGatewayModels(ctx context.Context, session *Session) ([]ModelEntry, error) {
	if session == nil {
		return nil, NewError("chat_harness_account_models_unavailable", 422, nil)
	}
	idx, err := r.BuildAccountModelIndex(ctx)
	if err != nil {
		return nil, err
	}
	var ids []string
	if IsGatewayRuntimeScope(session.ExecutionAccountRef) {
		ids = idx.GlobalModels
	} else {
		resolver := loadAccountRefResolver(ctx, r.aiHomeDirSafe())
		goRef := strings.TrimSpace(resolver.GoRef(session.ExecutionAccountRef))
		candidates := []string{session.ExecutionAccountRef}
		if goRef != "" && goRef != session.ExecutionAccountRef {
			candidates = append(candidates, goRef)
		}
		matchedAccount := false
		for _, c := range candidates {
			if _, ok := idx.AccountProvider[c]; ok {
				matchedAccount = true
			}
			if list := idx.ModelsByAccount[c]; len(list) > 0 {
				for _, m := range list {
					if !slices.Contains(ids, m) {
						ids = append(ids, m)
					}
				}
			}
		}
		if len(ids) == 0 && !matchedAccount {
			// If account exists nowhere yet, treat as mismatch/unavailable per contract.
			if r.AccountStore != nil {
				return nil, NewError("chat_harness_account_models_unavailable", 422, nil)
			}
		}
	}
	if len(ids) == 0 {
		return nil, NewError("chat_harness_account_models_unavailable", 422, nil)
	}
	entries := make([]ModelEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, r.buildModelEntry(session.Provider, session.ExecutionAccountRef, id, idx))
	}
	return entries, nil
}

// ReadComposerCatalog 产出前端模型选择器的稳定响应视图。
func (r *ModelCatalogResolver) ReadComposerCatalog(ctx context.Context, session *Session) (ComposerCatalog, error) {
	models, err := r.ListGatewayModels(ctx, session)
	if err != nil {
		return ComposerCatalog{}, err
	}
	out := ComposerCatalog{
		SessionID: session.SessionID,
		Models:    make([]ComposerModelEntry, 0, len(models)),
	}
	defaultModel := ""
	for _, entry := range models {
		if entry.IsDefault && defaultModel == "" {
			defaultModel = entry.Model
		}
		efforts := entry.SupportedReasoningEfforts
		if efforts == nil {
			efforts = []string{}
		}
		out.Models = append(out.Models, ComposerModelEntry{
			ID:               entry.Model,
			Label:            entry.DisplayName,
			SupportedEfforts: efforts,
			DefaultEffort:    entry.DefaultReasoningEffort,
		})
	}
	if defaultModel == "" && len(models) > 0 {
		defaultModel = models[0].Model
	}
	out.DefaultModel = defaultModel
	return out, nil
}

// ResolveTurnSettings 解析并校验本轮使用的模型、推理强度阶梯和上下文窗口。
func (r *ModelCatalogResolver) ResolveTurnSettings(ctx context.Context, session *Session, requestedModel, requestedEffort string) (TurnModelSettings, error) {
	models, err := r.ListGatewayModels(ctx, session)
	if err != nil {
		return TurnModelSettings{}, err
	}
	reqModel := strings.TrimSpace(requestedModel)
	var selected *ModelEntry
	if reqModel == "" {
		selected = &models[0]
	} else {
		for i := range models {
			if models[i].Model == reqModel {
				selected = &models[i]
				break
			}
		}
	}
	if selected == nil {
		return TurnModelSettings{}, NewError("chat_harness_account_model_unavailable", 422, map[string]any{
			"model": reqModel,
		})
	}
	reqEffort := strings.ToLower(strings.TrimSpace(requestedEffort))
	ladder := make([]inference.ReasoningEffort, 0, len(selected.SupportedReasoningEfforts))
	for _, e := range selected.SupportedReasoningEfforts {
		ladder = append(ladder, inference.ReasoningEffort(e))
	}
	finalEffort := ""
	if reqEffort != "" {
		if len(ladder) == 0 {
			// 目标模型没有推理强度档位时去掉 reasoning 意图，保持与 reasoning-effort-ladder 一致。
			finalEffort = ""
		} else if aligned, ok := inference.AlignReasoningEffort(inference.ReasoningEffort(reqEffort), nil, ladder); ok {
			finalEffort = string(aligned)
		} else {
			return TurnModelSettings{}, NewError("chat_harness_reasoning_effort_unsupported", 422, map[string]any{
				"model":           selected.Model,
				"reasoningEffort": reqEffort,
			})
		}
	} else if selected.DefaultReasoningEffort != "" {
		finalEffort = selected.DefaultReasoningEffort
	}

	var threadCfg map[string]any
	if selected.ContextWindow > 0 {
		threadCfg = map[string]any{
			"model_context_window": selected.ContextWindow,
		}
	}
	return TurnModelSettings{
		Model:           selected.Model,
		ReasoningEffort: finalEffort,
		ThreadConfig:    threadCfg,
	}, nil
}

// ChatTurnRouteResult 表示一轮 pure-chat 对话的能力路由判定结论。
type ChatTurnRouteResult struct {
	Target    string
	Reason    string
	Providers []string
}

// ResolveChatTurnRoute 根据模型载体与 Provider Go Relay 声明判定走 GoChat 透传还是 Codex/Native。
func (r *ModelCatalogResolver) ResolveChatTurnRoute(
	ctx context.Context,
	session *Session,
	payload map[string]any,
	imagePaths []string,
) ChatTurnRouteResult {
	if rawAtts, ok := payload["attachmentIds"].([]any); ok && len(rawAtts) > 0 {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "attachments_require_node"}
	}
	if strAtts, ok := payload["attachmentIds"].([]string); ok && len(strAtts) > 0 {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "attachments_require_node"}
	}
	if len(imagePaths) > 0 {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "attachments_require_node"}
	}
	if strings.TrimSpace(stringField(payload, "name")) != "" {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "slash_requires_node"}
	}
	model := strings.TrimSpace(stringField(payload, "model"))
	if model == "" && session != nil {
		model = strings.TrimSpace(stringField(session.Policy, "model"))
	}
	if model == "" {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "model_missing"}
	}
	if r == nil || r.AccountStore == nil {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "model_account_index_unavailable"}
	}
	idx, err := r.BuildAccountModelIndex(ctx)
	if err != nil || idx == nil {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "model_account_index_unavailable"}
	}
	carriers := idx.AccountsByModel[model]
	if len(carriers) == 0 {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "model_carriers_unknown"}
	}
	provSet := make(map[string]struct{}, len(carriers))
	for _, c := range carriers {
		if c.Provider == "" {
			return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "model_carrier_provider_unknown"}
		}
		provSet[c.Provider] = struct{}{}
	}
	pinned := ""
	if session != nil {
		pinned = strings.TrimSpace(session.ExecutionAccountRef)
	}
	if pinned != "" && !IsGatewayRuntimeScope(pinned) {
		resolver := loadAccountRefResolver(ctx, r.aiHomeDirSafe())
		prov := idx.AccountProvider[pinned]
		if prov == "" {
			if goRef := strings.TrimSpace(resolver.GoRef(pinned)); goRef != "" {
				prov = idx.AccountProvider[goRef]
			}
		}
		if prov == "" {
			return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "pinned_provider_unknown"}
		}
		provSet[prov] = struct{}{}
	}
	catalog := r.catalogSafe()
	providerList := make([]string, 0, len(provSet))
	for prov := range provSet {
		providerList = append(providerList, prov)
		if !goSupportsChatRelay(catalog, prov) {
			return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "provider_not_relay:" + prov}
		}
	}
	sort.Strings(providerList)
	return ChatTurnRouteResult{
		Target:    RouteTargetGo,
		Reason:    "relay_chat_completions",
		Providers: providerList,
	}
}

func goSupportsChatRelay(catalog *providers.Catalog, providerID string) bool {
	if catalog == nil {
		return false
	}
	def, ok := catalog.Get(providerID)
	if !ok {
		return false
	}
	host, ok := def.RelayHosts[providers.RelayHostGo]
	if !ok || !host.Supported || host.Channel != providers.RelayChannelRelay {
		return false
	}
	if len(host.Entries) == 0 {
		return true
	}
	return slices.Contains(host.Entries, ChatCompletionsEntryID)
}

func (r *ModelCatalogResolver) buildModelEntry(providerID, accountRef, modelID string, idx *AccountModelIndex) ModelEntry {
	efforts := []string{}
	ctxWin := 0
	if r != nil && r.MetadataIndex != nil {
		if rawEfforts, ok := r.MetadataIndex.LookupReasoningEfforts(providerID, modelID); ok {
			for _, e := range rawEfforts {
				efforts = append(efforts, string(e))
			}
		}
		if w, ok := r.MetadataIndex.LookupContextWindow(providerID, modelID); ok && w > 0 {
			ctxWin = w
		}
	}
	if ctxWin == 0 && idx != nil {
		if perAcc := idx.ContextByAccount[accountRef]; perAcc != nil && perAcc[modelID] > 0 {
			ctxWin = perAcc[modelID]
		}
	}
	defaultEffort := ""
	if slices.Contains(efforts, string(inference.ReasoningEffortMedium)) {
		defaultEffort = string(inference.ReasoningEffortMedium)
	} else if len(efforts) > 0 {
		defaultEffort = efforts[0]
	}
	return ModelEntry{
		Model:                     modelID,
		DisplayName:               modelID,
		SupportedReasoningEfforts: efforts,
		DefaultReasoningEffort:    defaultEffort,
		ContextWindow:             ctxWin,
	}
}

func (r *ModelCatalogResolver) aiHomeDirSafe() string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(r.AIHomeDir)
}

func (r *ModelCatalogResolver) catalogSafe() *providers.Catalog {
	if r != nil && r.Catalog != nil {
		return r.Catalog
	}
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return cat
}

func resolveAppStateDBPathSafe(aiHomeDir string) string {
	if aiHomeDir == "" {
		return ""
	}
	p, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return ""
	}
	return p
}

func loadCatalogSettingsSafe(ctx context.Context, dbPath string) modelcatalogsettings.Settings {
	if dbPath == "" {
		return modelcatalogsettings.Settings{}
	}
	s, err := modelcatalogsettings.Load(ctx, dbPath)
	if err != nil {
		return modelcatalogsettings.Settings{}
	}
	return s
}

func loadWebUISnapshotSafe(ctx context.Context, dbPath string) *webuimodelssnapshot.Snapshot {
	if dbPath == "" {
		return &webuimodelssnapshot.Snapshot{}
	}
	reader, err := webuimodelssnapshot.NewReaderAt(dbPath)
	if err != nil {
		return &webuimodelssnapshot.Snapshot{}
	}
	snap, err := reader.Read(ctx)
	if err != nil || snap == nil {
		return &webuimodelssnapshot.Snapshot{}
	}
	return snap
}

func loadAccountRefResolver(ctx context.Context, aiHomeDir string) accountrefmap.Resolver {
	if aiHomeDir == "" {
		return accountrefmap.NewResolver(false, accountrefmap.Table{})
	}
	table, err := accountrefmap.Load(ctx, aiHomeDir)
	if err != nil {
		return accountrefmap.NewResolver(false, accountrefmap.Table{})
	}
	return accountrefmap.NewResolver(len(table.Links()) > 0, table)
}

func buildSettingEnabledIndex(items []modelcatalogsettings.AccountModel, resolver accountrefmap.Resolver) map[string]bool {
	out := make(map[string]bool, len(items)*2)
	for _, item := range items {
		ref := strings.TrimSpace(item.AccountRef)
		id := strings.ToLower(strings.TrimSpace(item.ID))
		if ref == "" || id == "" {
			continue
		}
		out[ref+"\x00"+id] = item.Enabled
		if goRef := strings.TrimSpace(resolver.GoRef(ref)); goRef != "" && goRef != ref {
			out[goRef+"\x00"+id] = item.Enabled
		}
		if nodeRef := strings.TrimSpace(resolver.NodeRef(ref)); nodeRef != "" && nodeRef != ref {
			out[nodeRef+"\x00"+id] = item.Enabled
		}
	}
	return out
}

func lookupSettingEnabled(index map[string]bool, resolver accountrefmap.Resolver, ref, modelID string) (bool, bool) {
	lowerID := strings.ToLower(strings.TrimSpace(modelID))
	if lowerID == "" {
		return false, false
	}
	if enabled, ok := index[ref+"\x00"+lowerID]; ok {
		return enabled, true
	}
	if nodeRef := strings.TrimSpace(resolver.NodeRef(ref)); nodeRef != "" {
		if enabled, ok := index[nodeRef+"\x00"+lowerID]; ok {
			return enabled, true
		}
	}
	return false, false
}

func mapAccountRefKey(rawRef string, providerByRef map[string]string, resolver accountrefmap.Resolver) string {
	trimmed := strings.TrimSpace(rawRef)
	if trimmed == "" {
		return ""
	}
	if providerByRef[trimmed] != "" {
		return trimmed
	}
	if goRef := strings.TrimSpace(resolver.GoRef(trimmed)); goRef != "" && providerByRef[goRef] != "" {
		return goRef
	}
	return trimmed
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	return asString(m[key])
}
