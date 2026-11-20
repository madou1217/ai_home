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
	modelCandidateLimit      = 200
	modelAliasCandidateLimit = 800
	modelsSnapshotKey        = webuimodelssnapshot.CacheKey
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

// listModelCandidates 生成 --model / --model-alias 的取值候选。
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
	seen := make(map[string]struct{}, 64)
	choices := make([]modelChoice, 0, 64)
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

	// 先别名：--model-alias 的第一意图是「挑一个别名」。
	if mode == "alias" {
		aliases := readModelAliases(aiHome)
		for _, alias := range aliases {
			if alias.Alias == "" || !alias.Enabled {
				continue
			}
			if provider != "" && alias.Provider != "" && alias.Provider != "all" && alias.Provider != provider {
				continue
			}
			target := alias.Target
			if target == "" {
				target = "?"
			}
			push(alias.Alias, "别名 → "+target)
		}
		for _, alias := range aliases {
			if alias.Target == "" || !alias.Enabled {
				continue
			}
			push(alias.Target, "别名目标")
		}
	}

	// 命名空间写法：kiro.glm-5 / kiro.2.glm-5。
	if mode == "alias" && wantsScopedAliasTargets(request.Current) {
		for _, choice := range listScopedAliasCandidates(aiHome) {
			push(choice.Value, choice.Description)
		}
	}

	scopedKeys := []string{accountRef, accountToken}
	scopedProjection := readGatewayModelIDs(aiHome, scopedKeys)
	projected := scopedProjection
	projectedScope := "本账号"
	if len(projected) == 0 {
		projected = readGatewayModelIDs(aiHome, []string{"pool"})
		projectedScope = "网关池"
	}
	for _, id := range projected {
		push(id, projectedScope+"模型")
	}

	rows := readAccountModelRows(aiHome, provider)
	if len(rows) > 0 {
		scoped := make([]accountModelRow, 0, len(rows))
		if accountRef != "" {
			for _, row := range rows {
				if row.AccountRef == accountRef {
					scoped = append(scoped, row)
				}
			}
		}
		pool := rows
		scopeLabel := "同 provider 模型"
		if len(scoped) > 0 {
			pool = scoped
			scopeLabel = "本账号模型"
		}
		for _, row := range pool {
			push(row.ModelID, scopeLabel)
		}
	}

	limit := modelCandidateLimit
	if mode == "alias" {
		limit = modelAliasCandidateLimit
	}
	if len(choices) > limit {
		choices = choices[:limit]
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
