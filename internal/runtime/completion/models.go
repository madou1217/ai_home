package completion

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
)

const (
	// modelCandidateLimit 是**空前缀**时的显示预算（每层）。
	//
	// 它只是「别把整张表一次倒出来」的上限，不是真实性上限：任何已经敲下的前缀
	// 都绕过它（见 listModelCandidates 的 query 分支），所以这个数字永远不会让
	// 某个真实模型变得不可补全。
	//
	// 但它必须**足够大**：网关池当前 231 个模型，早期取值 200 会静默藏掉 31 个，
	// 用户不敲字直接按 TAB 时看到的就是残缺表。取 800 覆盖现有全部来源的总量。
	modelCandidateLimit      = 800
	modelAliasCandidateLimit = 800
	// modelMatchCeiling 是「用户已经敲了前缀」时的绝对上限。
	// 前缀匹配不做逐层截断（否则池尾模型永远补不出来），但仍要防住单字符
	// 前缀把整张表倒出来的病态情形。取值远高于任何真实层容量，正常查询碰不到。
	modelMatchCeiling = 2000
	modelsSnapshotKey = webuimodelssnapshot.CacheKey
	// gatewayModelsSnapshotKey 是服务端网关模型快照（含 modelAccounts：
	// 模型 → 参与路由的账号）。它是「哪些模型真的能路由」的另一处事实源，
	// 与 account_models 并用。
	gatewayModelsSnapshotKey = "cache:gateway-models-snapshot.json"
)

type modelAliasRow struct {
	Alias    string
	Target   string
	Provider string
	Enabled  bool
}

// accountModelRow 是 account_models 与 accounts 连接后的一行。
type accountModelRow struct {
	AccountRef string
	ModelID    string
}

// modelSnapshot 是 `app_kv` 里缓存的模型目录投影。
type modelSnapshot struct {
	byProvider map[string][]string
	byAccount  map[string][]string
}

// readModelAliases 读取 model_alias（Go 唯一别名表）；表缺失时返回空。
func readModelAliases(aiHome string) []modelAliasRow {
	rows := make([]modelAliasRow, 0, 16)
	withReadDB(aiHome, func(database *sql.DB) {
		result, err := database.Query(`
			SELECT alias, target, provider, enabled
			  FROM model_alias
			 ORDER BY position, id`)
		if err != nil {
			return
		}
		defer func() { _ = result.Close() }()
		for result.Next() {
			var alias, target, provider string
			var enabled sql.NullInt64
			if scanErr := result.Scan(&alias, &target, &provider, &enabled); scanErr != nil {
				continue
			}
			scope := strings.ToLower(strings.TrimSpace(provider))
			if scope != "" && scope != "all" && !knownProvider(scope) {
				// Node normalizeAliasScopeProvider 把未知作用域归一到 all。
				scope = "all"
			}
			rows = append(rows, modelAliasRow{
				Alias:    strings.TrimSpace(alias),
				Target:   strings.TrimSpace(target),
				Provider: scope,
				Enabled:  enabled.Valid && enabled.Int64 != 0,
			})
		}
	})
	return rows
}

// readModelSnapshot 读取服务端探测快照；同时兼容 Node 的 byAccount 与 Go 的 byAccountRef。
func readModelSnapshot(aiHome string) *modelSnapshot {
	path, err := appstate.DatabasePath(aiHome)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), completionDBTimeout)
	defer cancel()
	raw, found, err := appstate.ReadKV(ctx, path, modelsSnapshotKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return nil
	}
	var document struct {
		ByProvider   map[string][]string `json:"byProvider"`
		ByAccount    map[string][]string `json:"byAccount"`
		ByAccountRef map[string][]string `json:"byAccountRef"`
	}
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return nil
	}
	byProvider := document.ByProvider
	if byProvider == nil {
		byProvider = map[string][]string{}
	}
	byAccount := make(map[string][]string, len(document.ByAccount)+len(document.ByAccountRef))
	for key, value := range document.ByAccount {
		byAccount[key] = value
	}
	for key, value := range document.ByAccountRef {
		if _, exists := byAccount[key]; !exists {
			byAccount[key] = value
		}
	}
	return &modelSnapshot{byProvider: byProvider, byAccount: byAccount}
}

// readAccountModelRows 读取账号库里的模型行（上游发现结果 + 人工覆盖）。
func readAccountModelRows(aiHome, provider string) []accountModelRow {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if normalizedProvider == "" {
		return nil
	}
	rows := make([]accountModelRow, 0, 32)
	withReadDB(aiHome, func(database *sql.DB) {
		result, err := database.Query(`
			SELECT m.account_ref AS account_ref, m.model_id AS model_id
			  FROM account_models m
			  JOIN accounts a ON a.account_ref = m.account_ref
			 WHERE a.provider_id = ?
			   AND (m.manual_policy = 'force_enable'
			        OR (m.manual_policy = 'inherit' AND m.upstream_available = 1))
			 ORDER BY m.model_id`, normalizedProvider)
		if err != nil {
			return
		}
		defer func() { _ = result.Close() }()
		for result.Next() {
			var accountRef, modelID string
			if scanErr := result.Scan(&accountRef, &modelID); scanErr != nil {
				continue
			}
			model := strings.TrimSpace(modelID)
			if model == "" {
				continue
			}
			rows = append(rows, accountModelRow{AccountRef: strings.TrimSpace(accountRef), ModelID: model})
		}
	})
	return rows
}

// readGatewayModelIDs 读取网关模型投影 run/harness/pi/<key>/models.json。
func readGatewayModelIDs(aiHome string, keys []string) []string {
	for _, key := range keys {
		if key == "" {
			continue
		}
		file := filepath.Join(aiHome, "run", "harness", "pi", key, "models.json")
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var document struct {
			Providers map[string]struct {
				Models []struct {
					ID string `json:"id"`
				} `json:"models"`
			} `json:"providers"`
		}
		if json.Unmarshal(raw, &document) != nil {
			continue
		}
		profile, found := document.Providers["aih"]
		if !found || len(profile.Models) == 0 {
			continue
		}
		ids := make([]string, 0, len(profile.Models))
		for _, model := range profile.Models {
			if id := strings.TrimSpace(model.ID); id != "" {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			return ids
		}
	}
	return nil
}

// 模型候选的分组名：zsh 按组分节显示，组顺序即优先级顺序。
// 用户已经指定账号时，那个账号自己的模型必须排在最前，且永远不会被截断。
const (
	modelGroupAccount  = "本账号模型"
	modelGroupProvider = "同 provider 模型"
	modelGroupPool     = "网关池模型"
	modelGroupAlias    = "别名"
)

// listModelCandidates 生成 --model / --model-alias 的取值候选。
//
// 优先级是分层的，不是一条流水线：
//  1. 指定了账号 → 该账号在 account_models 里的模型（唯一确定「这个账号真能用」的证据）；
//  2. 没指定账号，或该账号没有行 → 同 provider 其它账号的模型；
//  3. 最后才是网关池投影（整个 server 的模型，可能与该账号/协议不匹配）。
//
// 每一层单独限额，所以池子再大也不会把前面几层挤掉；同名值保留第一次出现，
// 于是「本账号模型」天然覆盖后面同名的池子条目。
func listModelCandidates(aiHome string, request modelRequest) []modelChoice {
	aiHome = strings.TrimSpace(aiHome)
	if aiHome == "" {
		return nil
	}
	mode := strings.ToLower(strings.TrimSpace(request.Mode))
	if mode == "" {
		mode = "model"
	}
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	accountRef := strings.TrimSpace(request.AccountRef)
	accountToken := strings.TrimSpace(request.AccountToken)
	limit := modelCandidateLimit
	if mode == "alias" {
		limit = modelAliasCandidateLimit
	}

	layers := make([]modelLayer, 0, 4)
	seen := make(map[string]struct{}, 64)

	// 先别名：--model-alias 的第一意图是「挑一个别名」。
	if mode == "alias" {
		aliases := readModelAliases(aiHome)
		aliasLayer := modelLayer{group: modelGroupAlias, description: "别名", limit: limit}
		for _, alias := range aliases {
			if alias.Alias == "" || !alias.Enabled {
				continue
			}
			if provider != "" && alias.Provider != "" && alias.Provider != "all" && alias.Provider != provider {
				continue
			}
			aliasLayer.values = append(aliasLayer.values, aliasChoice(alias))
		}
		for _, alias := range aliases {
			if alias.Target == "" || !alias.Enabled {
				continue
			}
			aliasLayer.values = append(aliasLayer.values, modelChoice{Value: alias.Target, Description: "别名目标"})
		}
		layers = append(layers, aliasLayer)
	}

	// 命名空间写法：kiro.glm-5 / kiro.2.glm-5。
	if mode == "alias" && wantsScopedAliasTargets(request.Current) {
		layers = append(layers, modelLayer{
			group:       modelGroupAlias,
			description: "钉 Provider / 账号的别名目标",
			limit:       limit,
			values:      listScopedAliasCandidates(aiHome),
		})
	}

	// 账号自身模型：先读库里的账号行，读不到再看该账号的网关投影。
	accountChoices := accountScopedModelChoices(aiHome, provider, accountRef)
	if len(accountChoices) == 0 {
		accountChoices = plainModelChoices(readGatewayModelIDs(aiHome, []string{accountRef, accountToken}), modelGroupAccount)
	}
	if len(accountChoices) > 0 {
		layers = append(layers, modelLayer{
			group:       modelGroupAccount,
			description: "该账号已发现/已启用的模型",
			limit:       limit,
			values:      accountChoices,
		})
	}

	// 同 provider 的其它账号模型：只有本账号没有行时才作为主层，否则作为补充。
	rows := readAccountModelRows(aiHome, provider)
	siblingChoices := providerSiblingModelChoices(rows, accountRef)
	if len(siblingChoices) > 0 {
		layers = append(layers, modelLayer{
			group:       modelGroupProvider,
			description: "同 provider 其它账号的模型",
			limit:       limit,
			values:      siblingChoices,
		})
	}

	// 网关池：整台 server 的模型投影，永远排在最后。
	poolChoices := plainModelChoices(readGatewayModelIDs(aiHome, []string{"pool"}), modelGroupPool)
	if len(poolChoices) > 0 {
		layers = append(layers, modelLayer{
			group:       modelGroupPool,
			description: "网关池模型（未按账号校验）",
			limit:       limit,
			values:      poolChoices,
		})
	}

	// 客户端协议兼容标注。
	//
	// 用户在这里是给某个 CLI 选模型：`aih claude 22 --model X` 会用 Claude Code
	// 启动，客户端入口协议是 Anthropic Messages。模型能否被服务，取决于**它的
	// Provider 在这门协议下有没有通道**，而不是模型自己的名字。
	//
	// 依据全部来自合同查表：
	//   - CLI → 客户端协议：Definition.CredentialProtocol()（claude 读写 ANTHROPIC_*）
	//   - Provider → 该协议通道：Definition.RelayChannelOn(go, protocol)
	//     （RelayHost.Entries 只挂 gateway.openai.chat_completions 的家族透传，
	//      在 /v1/messages 上就是不可用——这正是「协议不兼容」）
	//
	// 只标注**不兼容**的一侧：可用的占绝大多数，逐行加提示会把真正的风险信号
	// 淹没；而不可用恰恰是用户点了会白跑一次请求的那些。
	if protocol := cliClientProtocol(provider); protocol != "" {
		blockedByModel := modelsWithoutProtocolChannel(aiHome, protocol)
		for layerIndex := range layers {
			for valueIndex := range layers[layerIndex].values {
				choice := &layers[layerIndex].values[valueIndex]
				if !blockedByModel[choice.Value] {
					continue
				}
				note := "⚠ 无 " + protocolDisplayName(protocol) + " 通道"
				if strings.TrimSpace(choice.Description) == "" {
					choice.Description = note
				} else {
					choice.Description = note + " · " + choice.Description
				}
			}
		}
	}

	// 每层各自限额后再合并；层内的第一次出现优先，因此靠前的层覆盖同名值。
	//
	// 关键顺序：**先按用户已输入的前缀过滤，再限额**。
	// 反过来（先截断再交给 collector 过滤）会让池尾的模型永远补不出来——
	// 候选在生成阶段就被砍掉了，用户敲什么前缀都救不回来。实测网关池 231 个
	// 模型里有 18 个（opencode/qwen3.8-max、primary-model 等）从未出现在候选里。
	// 限额的目的只是「空前缀时别把整张表倒出来」，不该影响任何已经敲下的查询。
	query := strings.TrimSpace(request.Current)
	choices := make([]modelChoice, 0, 64)
	for _, layer := range layers {
		added := 0
		for _, choice := range layer.values {
			if choice.Value == "" {
				continue
			}
			if _, exists := seen[choice.Value]; exists {
				continue
			}
			// 空前缀：限额生效（保持 TAB 输出可控）。
			// 有前缀：只保留命中项，且不因限额丢弃——用户已经缩小范围了。
			if query != "" {
				if !modelMatchesQuery(choice.Value, query) {
					continue
				}
			} else if added >= layer.limit {
				break
			}
			seen[choice.Value] = struct{}{}
			description := strings.TrimSpace(choice.Description)
			if description == "" {
				description = layer.description
			}
			choices = append(choices, modelChoice{
				Value:       choice.Value,
				Description: description,
				Group:       layer.group,
			})
			added++
		}
	}
	if len(choices) > modelMatchCeiling {
		choices = choices[:modelMatchCeiling]
	}
	return choices
}

// cliClientProtocol 返回该 CLI 自己的客户端入口协议；未知时返回空串。
//
// 唯一依据是 Provider 合同里声明的凭据环境变量前缀（见
// providers.Definition.CredentialProtocol），因此这里不需要任何 provider 名单。
func cliClientProtocol(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		return ""
	}
	definition, found := loadProviderSnapshot().byID[provider]
	if !found {
		return ""
	}
	return definition.CredentialProtocol()
}

func protocolDisplayName(protocol string) string {
	switch protocol {
	case "anthropic.messages":
		return "Anthropic 格式"
	case "openai.responses":
		return "OpenAI Responses 格式"
	case "openai.chat_completions":
		return "OpenAI Chat 格式"
	case "gemini.generate_content":
		return "Gemini 格式"
	}
	return protocol
}

// modelsWithoutProtocolChannel 返回「没有任何 Provider 能在该客户端协议下服务」的模型集合。
//
// 判定走 provider 合同（RelayChannelOn），归属取**两个来源的并集**：
//
//  1. account_models（探测结果 + 人工策略）——账号自己声明它能用哪些模型；
//  2. 网关快照的 modelAccounts——服务端实际纳入路由的模型→账号映射。
//
// 为什么必须并集：两者会不一致。实测 `balanced-model` 在 account_models 里只挂在
// codebuddy（在 /v1/messages 上不可用），但服务端路由同时把它挂在 claude/codex 上。
// 只看表会误报「不可用」，而那是一个真能用的模型。并集只会让「可用」更容易成立，
// 与「未知不警告」的原则一致：宁可不提示，也不要把能用的模型标成坏的。
//
// 完全没有任何归属证据的模型不标注——未知不等于不可用。
func modelsWithoutProtocolChannel(aiHome, protocol string) map[string]bool {
	owners := make(map[string]map[string]bool, 256)
	addOwner := func(model, provider string) {
		model = strings.TrimSpace(model)
		provider = strings.ToLower(strings.TrimSpace(provider))
		if model == "" || provider == "" {
			return
		}
		if owners[model] == nil {
			owners[model] = make(map[string]bool, 2)
		}
		owners[model][provider] = true
	}
	withReadDB(aiHome, func(database *sql.DB) {
		result, err := database.Query(`
			SELECT DISTINCT m.model_id AS model_id, a.provider_id AS provider_id
			  FROM account_models m
			  JOIN accounts a ON a.account_ref = m.account_ref
			 WHERE a.enabled = 1
			   AND (m.manual_policy = 'force_enable'
			        OR (m.manual_policy = 'inherit' AND m.upstream_available = 1))`)
		if err != nil {
			return
		}
		defer func() { _ = result.Close() }()
		for result.Next() {
			var modelID, providerID string
			if scanErr := result.Scan(&modelID, &providerID); scanErr != nil {
				continue
			}
			addOwner(modelID, providerID)
		}
	})
	// 服务端路由映射：模型 → 账号 → Provider。
	for model, providers := range readGatewayModelProviderOwners(aiHome) {
		for provider := range providers {
			addOwner(model, provider)
		}
	}
	snapshot := loadProviderSnapshot()
	blocked := make(map[string]bool, 64)
	for model, providers := range owners {
		if len(providers) == 0 {
			continue
		}
		if !anyProviderHasChannel(snapshot, providers, protocol) {
			blocked[model] = true
		}
	}
	return blocked
}

// readGatewayModelProviderOwners 读网关快照的 modelAccounts，把「模型 → 账号」还原成
// 「模型 → Provider」。快照缺失或损坏时返回空表（调用方按并集继续用账号表判定）。
func readGatewayModelProviderOwners(aiHome string) map[string]map[string]bool {
	result := make(map[string]map[string]bool, 256)
	path, err := appstate.DatabasePath(aiHome)
	if err != nil {
		return result
	}
	ctx, cancel := context.WithTimeout(context.Background(), completionDBTimeout)
	defer cancel()
	raw, found, err := appstate.ReadKV(ctx, path, gatewayModelsSnapshotKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return result
	}
	var document struct {
		ModelAccounts map[string][]string `json:"modelAccounts"`
	}
	if json.Unmarshal([]byte(raw), &document) != nil || len(document.ModelAccounts) == 0 {
		return result
	}
	refProvider := make(map[string]string, 128)
	refs := make([]string, 0, 128)
	for _, accounts := range document.ModelAccounts {
		refs = append(refs, accounts...)
	}
	refProvider = readAccountProviders(aiHome, refs)
	for model, accounts := range document.ModelAccounts {
		for _, account := range accounts {
			provider := refProvider[strings.TrimSpace(account)]
			if provider == "" {
				continue
			}
			if result[model] == nil {
				result[model] = make(map[string]bool, 2)
			}
			result[model][provider] = true
		}
	}
	return result
}

// readAccountProviders 批量解析 accountRef → provider_id。
func readAccountProviders(aiHome string, refs []string) map[string]string {
	result := make(map[string]string, len(refs))
	if len(refs) == 0 {
		return result
	}
	withReadDB(aiHome, func(database *sql.DB) {
		unique := make([]any, 0, len(refs))
		seen := make(map[string]bool, len(refs))
		for _, ref := range refs {
			ref = strings.TrimSpace(ref)
			if ref == "" || seen[ref] {
				continue
			}
			seen[ref] = true
			unique = append(unique, ref)
		}
		if len(unique) == 0 {
			return
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(unique)), ",")
		rows, err := database.Query(
			`SELECT account_ref, provider_id FROM accounts WHERE account_ref IN (`+placeholders+`)`,
			unique...,
		)
		if err != nil {
			return
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var ref, provider string
			if scanErr := rows.Scan(&ref, &provider); scanErr != nil {
				continue
			}
			result[strings.TrimSpace(ref)] = strings.ToLower(strings.TrimSpace(provider))
		}
	})
	return result
}

func anyProviderHasChannel(snapshot providerSnapshot, owners map[string]bool, protocol string) bool {
	for provider := range owners {
		definition, found := snapshot.byID[provider]
		if !found {
			// 未知 Provider 没有合同依据，不能据此判定不可用。
			return true
		}
		if definition.RelayChannelOn(providers.RelayHostGo, protocol) != "" {
			return true
		}
	}
	return false
}

// modelMatchesQuery 与 collector.add 的匹配语义保持一致（前缀或包含，大小写不敏感），
// 否则这里留下的候选会在下游被再过滤一次，等于限额又提前生效了一回。
func modelMatchesQuery(value, query string) bool {
	if query == "" {
		return true
	}
	if strings.HasPrefix(value, query) || strings.HasPrefix(strings.ToLower(value), strings.ToLower(query)) {
		return true
	}
	return strings.Contains(strings.ToLower(value), strings.ToLower(query))
}

// modelLayer 是一层候选及其独立限额。
type modelLayer struct {
	group       string
	description string
	limit       int
	values      []modelChoice
}

func aliasChoice(alias modelAliasRow) modelChoice {
	target := alias.Target
	if target == "" {
		target = "?"
	}
	return modelChoice{Value: alias.Alias, Description: "别名 → " + target}
}

// accountScopedModelChoices 取该账号自己的模型行（没有指定账号时为空）。
func accountScopedModelChoices(aiHome, provider, accountRef string) []modelChoice {
	if accountRef == "" {
		return nil
	}
	choices := make([]modelChoice, 0, 32)
	for _, row := range readAccountModelRows(aiHome, provider) {
		if row.AccountRef != accountRef {
			continue
		}
		choices = append(choices, modelChoice{Value: row.ModelID})
	}
	return choices
}

// providerSiblingModelChoices 取同 provider 下其它账号的模型（去掉本账号已有的）。
func providerSiblingModelChoices(rows []accountModelRow, accountRef string) []modelChoice {
	choices := make([]modelChoice, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		if accountRef != "" && row.AccountRef == accountRef {
			continue
		}
		if _, exists := seen[row.ModelID]; exists {
			continue
		}
		seen[row.ModelID] = struct{}{}
		choices = append(choices, modelChoice{Value: row.ModelID})
	}
	return choices
}

func plainModelChoices(values []string, group string) []modelChoice {
	choices := make([]modelChoice, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			choices = append(choices, modelChoice{Value: trimmed, Group: group})
		}
	}
	return choices
}

// wantsScopedAliasTargets 只在用户已经写出命名空间时才给 provider.account.model 候选。
func wantsScopedAliasTargets(current string) bool {
	text := strings.TrimSpace(current)
	if text == "" {
		return false
	}
	if strings.Contains(text, ".") {
		return true
	}
	return knownProvider(strings.ToLower(text))
}

func listScopedAliasCandidates(aiHome string) []modelChoice {
	snapshot := readModelSnapshot(aiHome)
	if snapshot == nil {
		return nil
	}
	accounts := listRawCLIAccounts(aiHome)
	return buildScopedAliasCandidates(snapshot, accounts)
}

// buildScopedAliasCandidates 生成带命名空间的别名目标候选。
func buildScopedAliasCandidates(snapshot *modelSnapshot, accounts []accountRow) []modelChoice {
	if snapshot == nil || snapshot.byProvider == nil {
		return nil
	}
	choices := make([]modelChoice, 0, 64)
	seen := make(map[string]struct{}, 64)
	push := func(value, description string) {
		text := strings.TrimSpace(value)
		if text == "" {
			return
		}
		if _, exists := seen[text]; exists {
			return
		}
		seen[text] = struct{}{}
		choices = append(choices, modelChoice{Value: text, Description: description})
	}
	modelsFor := func(provider string) []string {
		list := snapshot.byProvider[provider]
		result := make([]string, 0, len(list))
		for _, id := range list {
			if trimmed := strings.TrimSpace(id); trimmed != "" {
				result = append(result, trimmed)
			}
		}
		return result
	}
	providers := make([]string, 0, len(snapshot.byProvider))
	for provider := range snapshot.byProvider {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	for _, provider := range providers {
		label := providerLabelOrID(provider)
		for _, model := range modelsFor(provider) {
			push(provider+"."+model, label+" · "+model+"｜钉 Provider，账号由池子选")
		}
	}
	for _, account := range accounts {
		provider := strings.ToLower(strings.TrimSpace(account.Provider))
		cliAccountID := strings.TrimSpace(account.CLIAccountID)
		accountRef := strings.TrimSpace(account.AccountRef)
		if provider == "" || cliAccountID == "" || accountRef == "" {
			continue
		}
		label := providerLabelOrID(provider)
		models := snapshot.byAccount[accountRef]
		if len(models) == 0 {
			models = modelsFor(provider)
		}
		for _, model := range models {
			trimmed := strings.TrimSpace(model)
			if trimmed == "" {
				continue
			}
			push(provider+"."+cliAccountID+"."+trimmed, label+" 账号 "+cliAccountID+" · "+trimmed+"｜钉 Provider + 账号")
		}
	}
	return choices
}
