package completion

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

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
