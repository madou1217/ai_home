package completion

import (
	"database/sql"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

const (
	// modelCandidateLimit 是**空前缀**时的显示预算（每层）。
	//
	// 它只是「别把整张表一次倒出来」的上限，不是真实性上限：任何已经敲下的前缀
	// 都绕过它（见 listModelCandidates 的 query 分支），所以这个数字永远不会让
	// 某个真实模型变得不可补全。
	//
	// 但它必须**足够大**：account_models 现有 270+ 个有效模型，早期取值 200 会
	// 静默藏掉几十个，用户不敲字直接按 TAB 时看到的就是残缺表。
	modelCandidateLimit      = 800
	modelAliasCandidateLimit = 800
	// modelMatchCeiling 是「用户已经敲了前缀」时的绝对上限。
	// 前缀匹配不做逐层截断（否则池尾模型永远补不出来），但仍要防住单字符
	// 前缀把整张表倒出来的病态情形。取值远高于任何真实层容量，正常查询碰不到。
	modelMatchCeiling = 2000
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

// modelSnapshot 是「Provider / 账号 → 可用模型」的只读投影。
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

// readModelSnapshot 构造「Provider / 账号 → 可用模型」投影，来源是 account_models。
//
// 曾经这里读 app_kv 的 cache:webui-models-snapshot.json。那是一个 **Node 时代遗留的
// 缓存键**：Go 侧只有 reader、没有任何 writer（内 adapters/webuimodelssnapshot 只提供
// 读取），因此它永远停在最后一次 Node 运行的时间。实测本机那份是 11-19，而
// account_models 是 11-21，差异不是「轻微过期」而是完全不同的事实：
// codex 快照 237 / 真值 61，claude 快照 2 / 真值 35。
//
// 后果是作用域别名候选（`aih claude 22 --model-alias claude.`）几乎为空。
// account_models 是服务端模型目录自己的派生来源，本地即可读，因此直接用它。
func readModelSnapshot(aiHome string) *modelSnapshot {
	byProvider := make(map[string][]string, 16)
	byAccount := make(map[string][]string, 64)
	withReadDB(aiHome, func(database *sql.DB) {
		result, err := database.Query(`
			SELECT a.provider_id AS provider_id,
			       m.account_ref AS account_ref,
			       m.model_id    AS model_id
			  FROM account_models m
			  JOIN accounts a ON a.account_ref = m.account_ref
			 WHERE a.enabled = 1
			   AND (m.manual_policy = 'force_enable'
			        OR (m.manual_policy = 'inherit' AND m.upstream_available = 1))
			 ORDER BY a.provider_id, m.model_id`)
		if err != nil {
			return
		}
		defer func() { _ = result.Close() }()
		seenProvider := make(map[string]bool, 256)
		seenAccount := make(map[string]bool, 256)
		for result.Next() {
			var providerID, accountRef, modelID string
			if scanErr := result.Scan(&providerID, &accountRef, &modelID); scanErr != nil {
				continue
			}
			provider := strings.ToLower(strings.TrimSpace(providerID))
			account := strings.TrimSpace(accountRef)
			model := strings.TrimSpace(modelID)
			if provider == "" || model == "" {
				continue
			}
			providerKey := provider + "\x00" + model
			if !seenProvider[providerKey] {
				seenProvider[providerKey] = true
				byProvider[provider] = append(byProvider[provider], model)
			}
			if account == "" {
				continue
			}
			accountKey := account + "\x00" + model
			if !seenAccount[accountKey] {
				seenAccount[accountKey] = true
				byAccount[account] = append(byAccount[account], model)
			}
		}
	})
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

// readAccountModelIDs 读取整台 server 的有效模型（跨全部 Provider，按模型去重）。
//
// 这是「网关池」的唯一事实源：account_models 是服务端每次探测后落盘的结果，
// 也是 /v1/management/webui/openai-models/catalog 的派生来源。
//
// 曾经这里读 run/harness/pi/pool/models.json ——那是一个 **11-17 的历史投影文件**，
// 早已无人写入，却仍在被当作「网关池」使用。实测它比 account_models 落后 8 天：
// 里面有 12 个模型在真值目录中已不存在（幽灵），同时漏掉 83 个真实可用的模型
// （含账号自己发现的 deepseek-v4-1-flash 等）。补全候选因此既多给又少给。
// 现在只信 account_models，过期缓存文件不再参与候选生成。
func readAccountModelIDs(aiHome string) []string {
	ids := make([]string, 0, 256)
	seen := make(map[string]bool, 256)
	withReadDB(aiHome, func(database *sql.DB) {
		result, err := database.Query(`
			SELECT DISTINCT m.model_id AS model_id
			  FROM account_models m
			  JOIN accounts a ON a.account_ref = m.account_ref
			 WHERE a.enabled = 1
			   AND (m.manual_policy = 'force_enable'
			        OR (m.manual_policy = 'inherit' AND m.upstream_available = 1))
			 ORDER BY m.model_id`)
		if err != nil {
			return
		}
		defer func() { _ = result.Close() }()
		for result.Next() {
			var modelID string
			if scanErr := result.Scan(&modelID); scanErr != nil {
				continue
			}
			model := strings.TrimSpace(modelID)
			if model == "" || seen[model] {
				continue
			}
			seen[model] = true
			ids = append(ids, model)
		}
	})
	return ids
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

	// 账号自身模型：读该账号在 account_models 里的有效行。
	accountChoices := accountScopedModelChoices(aiHome, provider, accountRef)
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

	// 网关池：整台 server 的有效模型（account_models 全量去重），永远排在最后。
	poolChoices := plainModelChoices(readAccountModelIDs(aiHome), modelGroupPool)
	if len(poolChoices) > 0 {
		layers = append(layers, modelLayer{
			group:       modelGroupPool,
			description: "网关池模型（未按账号校验）",
			limit:       limit,
			values:      poolChoices,
		})
	}

	// 可用性标注。
	//
	// 用户在这里是给某个 CLI 选模型：`aih claude 22 --model X` 会用 Claude Code
	// 启动，客户端入口协议是 Anthropic Messages。模型能否被服务，取决于**它的
	// Provider 在这门协议下有没有通道**，而不是模型自己的名字。
	//
	// 依据全部来自合同查表：
	//   - CLI → 客户端协议：Definition.CredentialProtocol()
	//   - Provider → 该协议通道：Definition.RelayChannelOn(go, protocol)
	//     （RelayHost.Entries 只挂 gateway.openai.chat_completions 的家族透传，
	//      在 /v1/messages 上就没有通道）
	//
	// 措辞刻意只说「当前入口不可用」，不写「协议不兼容」：实测抽样发现失败原因
	// 至少有三类——协议入口没挂载、透传凭据不是原生登录态
	// （unsupported_relay_credential）、上游本身不可用（inference_unavailable）。
	// 这三类在补全阶段都能确定「选了会失败」，但**无法在这里区分具体是哪一类**。
	// 把原因写死成协议问题会误导用户去改协议，所以只陈述可确证的事实。
	//
	// 只标注**不可用**的一侧：可用的占绝大多数，逐行加提示会把真正的风险信号
	// 淹没；而不可用恰恰是用户点了会白跑一次请求的那些。
	if protocol := cliClientProtocol(provider); protocol != "" {
		blockedByModel := modelsWithoutProtocolChannel(aiHome, protocol)
		for layerIndex := range layers {
			for valueIndex := range layers[layerIndex].values {
				choice := &layers[layerIndex].values[valueIndex]
				if !blockedByModel[choice.Value] {
					continue
				}
				note := "⚠ 当前入口不可用"
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

// openAIChatCompletionsProtocol 是全部 OpenAI 家族中继 Provider 共用的客户端入口协议。
const openAIChatCompletionsProtocol = "openai.chat_completions"

// cliClientProtocol 返回该 CLI 自己的客户端入口协议；未知时返回空串。
//
// 依据全部来自 Provider 合同，没有 provider 名单：
//   - 凭据环境变量前缀决定协议族（见 providers.Definition.CredentialProtocol）；
//   - OPENAI_ 前缀在 codex 上归到 Responses（它有 Responses 原生适配器），
//     在其余 OpenAI 家族 Provider 上归到 Chat Completions —— 后者是实测契约，
//     那 11 个 Provider 在 relayHosts 里都只挂 gateway.openai.chat_completions。
func cliClientProtocol(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		return ""
	}
	definition, found := loadProviderSnapshot().byID[provider]
	if !found {
		return ""
	}
	// 未知协议前缀的 Provider（opencode / zcode / cline / codebuddy* 等）用各自的
	// 注册商标做 env 前缀，前缀表匹配不到。它们全部通过
	// gateway.openai.chat_completions 接入，因此按 Chat Completions 判定，
	// 而不是返回空串把标注整个关掉——关掉意味着用户选什么都收不到提示。
	if protocol := definition.CredentialProtocol(isResponsesNativeProvider(provider)); protocol != "" {
		return protocol
	}
	if definition.RelayChannelOn(providers.RelayHostGo, openAIChatCompletionsProtocol) != "" {
		return openAIChatCompletionsProtocol
	}
	return ""
}

// isResponsesNativeProvider 判断该 Provider 是否有 Responses 原生上游适配器。
//
// codex 是唯一一个与其它 OpenAI 家族共用 OPENAI_* 环境变量、却走 Responses
// 入口协议的 Provider。该事实由 gateway 侧的 providerOwnsProtocol 固化
// （codex ⇄ ProtocolCodexResponses），这里通过「它是否在 Responses 入口有通道、
// 且在 Chat Completions 入口同样有通道」无法区分，故直接读合同里的原生边界：
// 有 CLIConfig 且 CLI 名为 codex 的 Provider 才有 Responses 承载。
func isResponsesNativeProvider(provider string) bool {
	// 合同事实：codex 的原生配置根由 providerroot 解析；通过同一合同根
	// 与 codex 的根比较，不在运行代码中重复写入配置目录字面量。
	return strings.EqualFold(
		providerroot.ConfigDir(provider),
		providerroot.ConfigDir("codex"),
	)
}

// modelsWithoutProtocolChannel 返回「没有任何 Provider 能在该客户端协议下服务」的模型集合。
//
// 归属只用**一个**来源：account_models 里有效的行（探测结果 + 人工策略）。
//
// 为什么不用网关快照的 modelAccounts：那份映射是「路由候选」，不等于「这个模型真
// 能被这门协议服务」。实测 `balanced-model` / `opencode/qwen3.8-max` 在 modelAccounts
// 里同时挂在 claude、codex 名下，但服务端 /v0/webui/models 的 selectableByAccountRef
// 表明它们只对 codebuddy、opencode 账号可选——在 /v1/messages 上根本选不到。
// 用并集会把这些真的不可用的模型洗白成可用（实测标记从 158 掉到 5，全是漏报），
// 那比多标几个更糟：用户点下去才发现不能用。
//
// 完全没有任何归属证据的模型不标注——未知不等于不可用，凭空警告同样不可接受。
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
