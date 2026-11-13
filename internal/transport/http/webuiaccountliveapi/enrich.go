package webuiaccountliveapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/runtime/windowactivation"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimobileaccountapi"
)

const aliasPoolKeyPrefix = "account:alias-pool:"

var builtinActivityCatalog = accountactivity.BuiltinCatalog()

type activityActionView struct {
	ID                 string `json:"id"`
	Label              string `json:"label"`
	Description        string `json:"description"`
	Schedulable        bool   `json:"schedulable"`
	ScheduleDebounceMS int64  `json:"scheduleDebounceMs,omitempty"`
	SupportsProbe      bool   `json:"supportsProbe,omitempty"`
}

type appStateExtras struct {
	participates map[string]bool
	rules        map[string][]any
	groupIDs     map[string][]any
}

// enrichExtras 补齐之前由 Node 侧装配的账号展示与调度字段。
func (hub *Hub) enrichExtras(ctx context.Context, rows []webuiaccountsapi.Row) {
	if len(rows) == 0 {
		return
	}
	desktopAccountRef := webuimobileaccountapi.ReadDesktopAccountRef(hub.aiHomeDir)
	extras := loadAppStateExtras(ctx, hub.aiHomeDir)

	needsKiroLoginType := false
	for index := range rows {
		if strings.EqualFold(rows[index].Provider, "kiro") && strings.TrimSpace(rows[index].LoginType) == "" {
			needsKiroLoginType = true
			break
		}
	}
	var kiroLoginTypes map[string]string
	if needsKiroLoginType {
		kiroLoginTypes = loadKiroLoginTypes(ctx, hub.aiHomeDir)
	}

	activityCache := make(map[string][]any, 8)
	for index := range rows {
		row := &rows[index]
		ref := strings.TrimSpace(row.AccountRef)
		provider := strings.ToLower(strings.TrimSpace(row.Provider))

		row.CustomUpstream = isCustomUpstreamAccount(provider, row.APIKeyMode, row.BaseURL)
		_, row.WindowActivationSupported = windowactivation.GetProbeSpec(provider)
		row.GatewayTargetSupported = gatewayTargetSupported(hub.catalog, provider)

		actions, cached := activityCache[provider]
		if !cached {
			actions = buildActivityActionViews(provider)
			activityCache[provider] = actions
		}
		row.ActivityActions = actions

		if participates, found := extras.participates[ref]; found {
			row.AliasPoolParticipates = participates
		} else {
			row.AliasPoolParticipates = true
		}

		if rules := extras.rules[ref]; len(rules) > 0 {
			row.UpstreamErrorRules = rules
		} else if row.UpstreamErrorRules == nil {
			row.UpstreamErrorRules = []any{}
		}
		if groupIDs := extras.groupIDs[ref]; len(groupIDs) > 0 {
			row.UpstreamErrorGroupIDs = groupIDs
		} else if row.UpstreamErrorGroupIDs == nil {
			row.UpstreamErrorGroupIDs = []any{}
		}

		if provider == "codex" && desktopAccountRef != "" && ref == desktopAccountRef {
			row.IsMobile = true
		}
		if provider == "kimi" && strings.TrimSpace(row.Region) == "" {
			row.Region = readKimiDesktopRegion(hub.aiHomeDir, ref)
		}
		if provider == "kiro" && strings.TrimSpace(row.LoginType) == "" {
			if loginType := kiroLoginTypes[ref]; loginType != "" {
				row.LoginType = loginType
			}
		}
		if row.Configured && !row.APIKeyMode && strings.TrimSpace(row.PlanName) == "" {
			row.PlanName = readPlanNameFromSnapshot(row.UsageSnapshot)
		}
	}
}

func buildActivityActionViews(provider string) []any {
	actions := builtinActivityCatalog.Actions(provider)
	if len(actions) == 0 {
		return []any{}
	}
	out := make([]any, 0, len(actions))
	for _, action := range actions {
		view := activityActionView{
			ID:            action.ID,
			Label:         action.Label,
			Description:   action.Description,
			Schedulable:   action.Schedulable,
			SupportsProbe: action.SupportsProbe,
		}
		if action.ScheduleDebounce > 0 {
			view.ScheduleDebounceMS = action.ScheduleDebounce.Milliseconds()
		}
		out = append(out, view)
	}
	return out
}

func gatewayTargetSupported(catalog *providers.Catalog, provider string) bool {
	if catalog == nil || provider == "" {
		return false
	}
	def, ok := catalog.Get(provider)
	if !ok {
		return false
	}
	return def.RelayHosts[providers.RelayHostGo].Supported || def.RelayHosts[providers.RelayHostNode].Supported
}

func isCustomUpstreamAccount(provider string, apiKeyMode bool, baseURL string) bool {
	if !apiKeyMode {
		return false
	}
	if len(runtimeegress.ListOfficialUpstreamHosts(provider)) == 0 {
		return false
	}
	trimmed := strings.TrimSpace(baseURL)
	if trimmed == "" {
		return false
	}
	host := runtimeegress.ReadUpstreamHost(trimmed)
	if host == "" || isLoopbackHost(host) {
		return true
	}
	return !runtimeegress.IsOfficialUpstreamHost(provider, host)
}

func isLoopbackHost(host string) bool {
	normalized := strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return normalized == "localhost" ||
		normalized == "::1" ||
		normalized == "0.0.0.0" ||
		strings.HasPrefix(normalized, "127.")
}

func readKimiDesktopRegion(aiHomeDir, accountRef string) string {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" || accountRef == "" {
		return ""
	}
	regionPath := filepath.Join(
		root, "run", "auth-projections", "kimi", accountRef,
		"electron-user-data", "bridge-store", "region.json",
	)
	data, err := os.ReadFile(regionPath)
	if err != nil {
		return ""
	}
	var parsed struct {
		LastEffective string `json:"lastEffective"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return ""
	}
	region := strings.ToLower(strings.TrimSpace(parsed.LastEffective))
	if region == "china" || region == "overseas" {
		return region
	}
	return ""
}

func readPlanNameFromSnapshot(snapshot any) string {
	root, ok := snapshot.(map[string]any)
	if !ok || root == nil {
		return ""
	}
	if account, ok := root["account"].(map[string]any); ok && account != nil {
		if planName, ok := account["planName"].(string); ok && strings.TrimSpace(planName) != "" {
			return strings.TrimSpace(planName)
		}
	}
	if planName, ok := root["planName"].(string); ok {
		return strings.TrimSpace(planName)
	}
	return ""
}

func loadAppStateExtras(ctx context.Context, aiHomeDir string) appStateExtras {
	extras := appStateExtras{
		participates: map[string]bool{},
		rules:        map[string][]any{},
		groupIDs:     map[string][]any{},
	}
	if strings.TrimSpace(aiHomeDir) == "" {
		return extras
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return extras
	}
	if _, statErr := os.Stat(dbPath); statErr != nil {
		return extras
	}
	db, err := appstate.OpenReadOnly(ctx, dbPath)
	if err != nil {
		return extras
	}
	defer func() { _ = db.Close() }()

	if rows, qErr := db.QueryContext(ctx, "SELECT key, value FROM app_kv WHERE key LIKE ?", aliasPoolKeyPrefix+"%"); qErr == nil {
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var key, value string
			if err := rows.Scan(&key, &value); err != nil {
				continue
			}
			ref := strings.TrimSpace(strings.TrimPrefix(key, aliasPoolKeyPrefix))
			if ref == "" {
				continue
			}
			var cfg struct {
				Participates *bool `json:"participates"`
			}
			if err := json.Unmarshal([]byte(value), &cfg); err == nil && cfg.Participates != nil {
				extras.participates[ref] = *cfg.Participates
			}
		}
	}

	if rows, qErr := db.QueryContext(ctx, "SELECT account_ref, env_json FROM account_credentials WHERE env_json != ''"); qErr == nil {
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var ref, rawEnv string
			if err := rows.Scan(&ref, &rawEnv); err != nil {
				continue
			}
			ref = strings.TrimSpace(ref)
			if ref == "" {
				continue
			}
			var env map[string]json.RawMessage
			if err := json.Unmarshal([]byte(rawEnv), &env); err != nil || env == nil {
				continue
			}
			if rules := decodeEnvAnySlice(env[rulesenv.RulesEnvKey]); len(rules) > 0 {
				extras.rules[ref] = rules
			}
			if groupIDs := decodeEnvAnySlice(env[rulesenv.GroupIDsEnvKey]); len(groupIDs) > 0 {
				extras.groupIDs[ref] = groupIDs
			}
		}
	}
	return extras
}

func decodeEnvAnySlice(raw json.RawMessage) []any {
	if len(raw) == 0 {
		return nil
	}
	// env_json 里通常是 JSON 字符串形式的数组；若直接存成 JSON 数组也一并兼容。
	var payload []byte
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err == nil {
		payload = []byte(strings.TrimSpace(encoded))
	} else {
		payload = raw
	}
	if len(payload) == 0 {
		return nil
	}
	var list []any
	if err := json.Unmarshal(payload, &list); err != nil || len(list) == 0 {
		return nil
	}
	return list
}

func loadKiroLoginTypes(ctx context.Context, aiHomeDir string) map[string]string {
	result := map[string]string{}
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return result
	}
	dbPath := filepath.Join(root, "aih.db")
	if _, statErr := os.Stat(dbPath); statErr != nil {
		return result
	}
	db, err := appstate.OpenReadOnly(ctx, dbPath)
	if err != nil {
		return result
	}
	defer func() { _ = db.Close() }()

	rows, err := db.QueryContext(
		ctx,
		`SELECT c.account_ref, COALESCE(json_extract(c.credential_json, '$.native_auth_json'), '')
		 FROM account_credentials AS c
		 INNER JOIN accounts AS a ON a.account_ref = c.account_ref
		 WHERE a.provider_id = 'kiro' AND json_valid(c.credential_json)`,
	)
	if err != nil {
		return result
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref, rawNative string
		if err := rows.Scan(&ref, &rawNative); err != nil {
			continue
		}
		ref = strings.TrimSpace(ref)
		if ref == "" || strings.TrimSpace(rawNative) == "" {
			continue
		}
		if loginType := resolveKiroLoginType([]byte(rawNative)); loginType != "" {
			result[ref] = loginType
		}
	}
	return result
}

func resolveKiroLoginType(rawNative []byte) string {
	var doc map[string]any
	if err := json.Unmarshal(rawNative, &doc); err != nil || doc == nil {
		return ""
	}
	auth, _ := doc["auth"].(map[string]any)
	flavor := normalizeKiroFlavour(anyString(doc["flavor"]), anyString(doc["tokenFlavour"]))
	if flavor == "" {
		reg, _ := doc["registration"].(map[string]any)
		if anyString(reg["clientId"], reg["client_id"]) != "" && anyString(reg["clientSecret"], reg["client_secret"]) != "" {
			flavor = "oidc"
		} else if hasKiroDesktopMarkers(auth) {
			flavor = "desktop"
		} else {
			flavor = "oidc"
		}
	}
	if flavor == "desktop" {
		social := strings.ToLower(anyString(auth["provider"], auth["authMethod"], auth["auth_method"]))
		if social == "google" || social == "github" {
			return social
		}
		return "desktop"
	}
	if anyString(auth["start_url"], auth["startUrl"]) != "" {
		return "idc"
	}
	return "builder"
}

func normalizeKiroFlavour(values ...string) string {
	for _, value := range values {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "oidc":
			return "oidc"
		case "desktop", "social", "external-idp", "external_idp":
			return "desktop"
		}
	}
	return ""
}

func hasKiroDesktopMarkers(auth map[string]any) bool {
	if auth == nil {
		return false
	}
	return anyString(
		auth["authMethod"], auth["auth_method"],
		auth["provider"],
		auth["profileArn"], auth["profile_arn"],
	) != ""
}

func anyString(values ...any) string {
	for _, value := range values {
		if s, ok := value.(string); ok {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}
