package translation

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// SettingsKVKey 是 app-state.db 中翻译偏好设置的持久化键。
	SettingsKVKey = "webui:translation-settings"

	DefaultTarget       = "zh-Hans"
	DefaultTargetPolicy = "saved"
	DefaultCopyScope    = "selection"
	DefaultReadingTheme = "plain"
	DefaultShortcut     = "⌘⌥T"
	DefaultChatShortcut = "⌘⌥C"
	MaxModelIDLength    = 200
)

var (
	validCopyScopes = map[string]struct{}{
		"selection": {},
		"page":      {},
		"all":       {},
	}
	validRouteOperations = map[string]struct{}{
		"selection": {},
		"batch":     {},
		"page":      {},
		"replace":   {},
	}
	validReadingThemes = map[string]struct{}{
		"plain":            {},
		"solid":            {},
		"dashed":           {},
		"dotted":           {},
		"underline-solid":  {},
		"underline-dashed": {},
		"underline-dotted": {},
		"underline-wavy":   {},
		"soft":             {},
		"hud":              {},
		"cyberpunk":        {},
	}
)

// SystemServerTarget 表示桌面客户端记住的远端 AIH Server 目标。
type SystemServerTarget struct {
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	Origin   string `json:"origin"`
	ServerID string `json:"serverId"`
}

// Route 表示一条翻译路由链项（有序回退）。
type Route struct {
	ID            string   `json:"id"`
	Provider      string   `json:"provider"`
	Model         string   `json:"model"`
	ModelProvider string   `json:"modelProvider,omitempty"`
	Enabled       bool     `json:"enabled"`
	Priority      int      `json:"priority"`
	Operations    []string `json:"operations"`
}

// Settings 表示 AI 翻译页与桌面悬浮窗共享的偏好设置。
type Settings struct {
	Source              string               `json:"source"`
	Target              string               `json:"target"`
	Model               string               `json:"model"`
	Provider            string               `json:"provider"`
	SystemEnabled       bool                 `json:"systemEnabled"`
	SystemServerTarget  *SystemServerTarget  `json:"systemServerTarget"`
	SystemServerTargets []SystemServerTarget `json:"systemServerTargets"`
	TargetPolicy        string               `json:"targetPolicy"`
	AutoCopy            bool                 `json:"autoCopy"`
	CopyScope           string               `json:"copyScope"`
	ReadingTheme        string               `json:"readingTheme"`
	ExecutionTarget     string               `json:"executionTarget"`
	Shortcut            string               `json:"shortcut"`
	ChatShortcut        string               `json:"chatShortcut"`
	ShortcutEnabled     bool                 `json:"shortcutEnabled"`
	ChatShortcutEnabled bool                 `json:"chatShortcutEnabled"`
	Routes              []Route              `json:"routes"`
	UpdatedAt           int64                `json:"updatedAt"`
}

// NormalizeModelID 裁剪并截断模型 ID 长度。
func NormalizeModelID(value string) string {
	trimmed := strings.TrimSpace(value)
	runes := []rune(trimmed)
	if len(runes) > MaxModelIDLength {
		return string(runes[:MaxModelIDLength])
	}
	return trimmed
}

// NormalizeProviderID 清洗 Provider 名称字符集。
func NormalizeProviderID(value string) string {
	lower := strings.ToLower(strings.TrimSpace(value))
	if lower == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(lower))
	for _, r := range lower {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max])
	}
	return value
}

func normalizeSystemServerTargetRaw(raw any) (SystemServerTarget, bool) {
	obj, ok := raw.(map[string]any)
	if !ok || obj == nil {
		return SystemServerTarget{}, false
	}
	origin := strings.TrimRight(strings.TrimSpace(asString(obj["origin"])), "/")
	if !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
		return SystemServerTarget{}, false
	}
	label := strings.TrimSpace(asString(obj["label"]))
	if label == "" {
		label = origin
	}
	return SystemServerTarget{
		Kind:     "aih-server",
		Label:    truncateRunes(label, 120),
		Origin:   origin,
		ServerID: truncateRunes(strings.TrimSpace(asString(obj["serverId"])), 200),
	}, true
}

func normalizeSystemServerTargetsRaw(raw any) []SystemServerTarget {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return []SystemServerTarget{}
	}
	seen := make(map[string]struct{}, len(list))
	out := make([]SystemServerTarget, 0, len(list))
	for _, item := range list {
		target, ok := normalizeSystemServerTargetRaw(item)
		if !ok {
			continue
		}
		key := target.ServerID
		if key == "" {
			key = target.Origin
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, target)
		if len(out) >= 32 {
			break
		}
	}
	return out
}

// NormalizeRoutesRaw 归一路由数组（与 translation-settings-store.js 保持逐字段语义一致）。
func NormalizeRoutesRaw(rawRoutes any, hasRoutes bool, legacyModel string, legacyProvider string) []Route {
	if !hasRoutes {
		accountProvider := NormalizeProviderID(legacyProvider)
		model := NormalizeModelID(legacyModel)
		if accountProvider != "" && model != "" {
			return []Route{{
				ID:            "aih-gateway:" + model + ":" + accountProvider,
				Provider:      "aih-gateway",
				Model:         model,
				ModelProvider: accountProvider,
				Enabled:       true,
				Priority:      0,
				Operations:    []string{"selection"},
			}}
		}
		return []Route{}
	}
	list, ok := rawRoutes.([]any)
	if !ok {
		return []Route{}
	}
	seenIDs := make(map[string]struct{}, len(list))
	out := make([]Route, 0, len(list))
	for _, entry := range list {
		obj, ok := entry.(map[string]any)
		if !ok || obj == nil {
			continue
		}
		provider := NormalizeProviderID(asString(obj["provider"]))
		model := NormalizeModelID(asString(obj["model"]))
		if provider == "" || model == "" {
			continue
		}
		ops := normalizeRouteOperationsRaw(obj["operations"])
		fallbackID := "route:" + provider + ":" + model
		id := truncateRunes(strings.TrimSpace(asString(obj["id"])), 200)
		if id == "" {
			id = fallbackID
		}
		if _, dup := seenIDs[id]; dup {
			continue
		}
		seenIDs[id] = struct{}{}
		enabled := true
		if rawEnabled, exists := obj["enabled"]; exists {
			if b, ok := rawEnabled.(bool); ok && !b {
				enabled = false
			}
		}
		out = append(out, Route{
			ID:            id,
			Provider:      provider,
			Model:         model,
			ModelProvider: NormalizeProviderID(asString(obj["modelProvider"])),
			Enabled:       enabled,
			Priority:      len(out),
			Operations:    ops,
		})
	}
	return out
}

func normalizeRouteOperationsRaw(raw any) []string {
	list, ok := raw.([]any)
	if !ok {
		return []string{"selection"}
	}
	seen := make(map[string]struct{}, len(list))
	out := make([]string, 0, len(list))
	for _, item := range list {
		op := strings.ToLower(strings.TrimSpace(asString(item)))
		if _, valid := validRouteOperations[op]; !valid {
			continue
		}
		if _, dup := seen[op]; dup {
			continue
		}
		seen[op] = struct{}{}
		out = append(out, op)
	}
	if len(out) == 0 {
		return []string{"selection"}
	}
	return out
}

func asString(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func asBool(value any, defaultValue bool) bool {
	if b, ok := value.(bool); ok {
		return b
	}
	return defaultValue
}

func asInt64(value any) int64 {
	switch v := value.(type) {
	case float64:
		if v > 0 {
			return int64(v)
		}
	case int64:
		if v > 0 {
			return v
		}
	case int:
		if v > 0 {
			return int64(v)
		}
	case json.Number:
		if n, err := v.Int64(); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

// NormalizeSettingsMap 从弱类型 map 归一翻译设置；坏字段一律安全回落默认。
func NormalizeSettingsMap(raw map[string]any) Settings {
	if raw == nil {
		raw = map[string]any{}
	}
	sourceCode := NormalizeLanguageCode(asString(raw["source"]))
	if sourceCode != AutoLanguage && !IsSupportedLanguage(sourceCode) {
		sourceCode = AutoLanguage
	}
	targetCode := NormalizeLanguageCode(asString(raw["target"]))
	if !IsSupportedLanguage(targetCode) {
		targetCode = DefaultTarget
	}
	model := NormalizeModelID(asString(raw["model"]))
	provider := NormalizeProviderID(asString(raw["provider"]))

	targetPolicy := strings.ToLower(strings.TrimSpace(asString(raw["targetPolicy"])))
	if _, ok := validTargetPolicies[targetPolicy]; !ok {
		targetPolicy = DefaultTargetPolicy
	}
	copyScope := strings.ToLower(strings.TrimSpace(asString(raw["copyScope"])))
	if _, ok := validCopyScopes[copyScope]; !ok {
		copyScope = DefaultCopyScope
	}
	readingTheme := strings.TrimSpace(asString(raw["readingTheme"]))
	if _, ok := validReadingThemes[readingTheme]; !ok {
		readingTheme = DefaultReadingTheme
	}
	executionTarget := strings.ToLower(strings.TrimSpace(asString(raw["executionTarget"])))
	if executionTarget != "direct-provider" {
		executionTarget = "aih-server"
	}
	shortcut := truncateRunes(strings.TrimSpace(asString(raw["shortcut"])), 80)
	if shortcut == "" {
		shortcut = DefaultShortcut
	}
	chatShortcut := truncateRunes(strings.TrimSpace(asString(raw["chatShortcut"])), 80)
	if chatShortcut == "" {
		chatShortcut = DefaultChatShortcut
	}

	var sysTarget *SystemServerTarget
	if t, ok := normalizeSystemServerTargetRaw(raw["systemServerTarget"]); ok {
		sysTarget = &t
	}
	rawRoutes, hasRoutes := raw["routes"]

	return Settings{
		Source:              sourceCode,
		Target:              targetCode,
		Model:               model,
		Provider:            provider,
		SystemEnabled:       asBool(raw["systemEnabled"], false) && raw["systemEnabled"] == true,
		SystemServerTarget:  sysTarget,
		SystemServerTargets: normalizeSystemServerTargetsRaw(raw["systemServerTargets"]),
		TargetPolicy:        targetPolicy,
		AutoCopy:            raw["autoCopy"] == true,
		CopyScope:           copyScope,
		ReadingTheme:        readingTheme,
		ExecutionTarget:     executionTarget,
		Shortcut:            shortcut,
		ChatShortcut:        chatShortcut,
		ShortcutEnabled:     asBool(raw["shortcutEnabled"], true),
		ChatShortcutEnabled: asBool(raw["chatShortcutEnabled"], true),
		Routes:              NormalizeRoutesRaw(rawRoutes, hasRoutes, model, provider),
		UpdatedAt:           asInt64(raw["updatedAt"]),
	}
}

// DefaultSettings 返回默认翻译偏好设置。
func DefaultSettings() Settings {
	return NormalizeSettingsMap(nil)
}

// NormalizeModelProvider 将历史 gemini 供应商写法归一到 agy 并按模型族补全缺省供应商。
func NormalizeModelProvider(settings Settings) Settings {
	familyProvider := InferModelFamilyProvider(settings.Model)
	configured := strings.ToLower(strings.TrimSpace(settings.Provider))
	effective := configured
	if configured == "gemini" {
		effective = "agy"
	} else if effective == "" {
		effective = familyProvider
	}
	out := settings
	if familyProvider != "" {
		out.Provider = effective
	}
	if len(settings.Routes) > 0 {
		routes := make([]Route, len(settings.Routes))
		copy(routes, settings.Routes)
		for i, r := range routes {
			routes[i] = NormalizeRouteProvider(r)
		}
		out.Routes = routes
	}
	return out
}

// NormalizeRouteProvider 对 aih-gateway 路由的 modelProvider 做同口径归一。
func NormalizeRouteProvider(route Route) Route {
	if route.Provider != "aih-gateway" {
		return route
	}
	declared := strings.ToLower(strings.TrimSpace(route.ModelProvider))
	if declared == "gemini" {
		route.ModelProvider = "agy"
	} else if declared == "" {
		route.ModelProvider = InferModelFamilyProvider(route.Model)
	} else {
		route.ModelProvider = declared
	}
	return route
}

// ResolveTranslationRoutesForRequest 处理历史单路由迁移投影并追加当前目录兜底。
func ResolveTranslationRoutesForRequest(
	routes []Route,
	configuredModel string,
	configuredProvider string,
	catalog ModelCatalog,
	operation string,
) []Route {
	if len(routes) == 0 {
		return nil
	}
	legacyCount := 0
	for _, r := range routes {
		if r.Provider == "aih-gateway" && strings.HasPrefix(r.ID, "aih-gateway:") {
			legacyCount++
		}
	}
	if legacyCount != len(routes) {
		out := make([]Route, len(routes))
		copy(out, routes)
		return out
	}

	normConfiguredModel := NormalizeModelID(configuredModel)
	normConfiguredProvider := NormalizeProviderID(configuredProvider)
	if normConfiguredModel == "" || normConfiguredProvider == "" {
		return nil
	}
	for _, r := range routes {
		if NormalizeModelID(r.Model) != normConfiguredModel || NormalizeProviderID(r.ModelProvider) != normConfiguredProvider {
			return nil
		}
	}

	var catalogEntry *ModelEntry
	for i := range catalog.Models {
		m := &catalog.Models[i]
		if NormalizeModelID(m.ID) == normConfiguredModel &&
			(normConfiguredProvider == "" || NormalizeProviderID(m.Provider) == normConfiguredProvider) {
			catalogEntry = m
			break
		}
	}
	savedRouteUsable := len(catalog.Models) == 0 || (catalogEntry != nil && catalogEntry.AvailableAccountCount > 0)

	op := strings.ToLower(strings.TrimSpace(operation))
	if _, valid := validRouteOperations[op]; !valid {
		op = "selection"
	}

	projected := make([]Route, len(routes))
	for i, r := range routes {
		cp := r
		hasOp := false
		ops := make([]string, 0, len(r.Operations)+1)
		for _, existingOp := range r.Operations {
			ops = append(ops, existingOp)
			if existingOp == op {
				hasOp = true
			}
		}
		if !hasOp {
			ops = append(ops, op)
		}
		cp.Operations = ops
		projected[i] = cp
	}

	fallbackModel := NormalizeModelID(catalog.DefaultModel)
	fallbackProvider := NormalizeProviderID(catalog.DefaultProvider)
	if fallbackModel == "" || fallbackProvider == "" {
		if savedRouteUsable {
			return projected
		}
		return nil
	}
	for _, r := range projected {
		if r.Provider == "aih-gateway" && r.Model == fallbackModel && NormalizeProviderID(r.ModelProvider) == fallbackProvider {
			return projected
		}
	}

	var fallbackEntry *ModelEntry
	for i := range catalog.Models {
		m := &catalog.Models[i]
		if NormalizeModelID(m.ID) == fallbackModel && NormalizeProviderID(m.Provider) == fallbackProvider {
			fallbackEntry = m
			break
		}
	}
	if len(catalog.Models) > 0 && (fallbackEntry == nil || fallbackEntry.AvailableAccountCount <= 0) {
		if savedRouteUsable {
			return projected
		}
		return nil
	}

	return append(projected, Route{
		ID:            "catalog-fallback:" + fallbackModel + ":" + fallbackProvider,
		Provider:      "aih-gateway",
		Model:         fallbackModel,
		ModelProvider: fallbackProvider,
		Enabled:       true,
		Priority:      len(projected),
		Operations:    []string{op},
	})
}

// ReadSettings 从 app-state.db 读取翻译设置；缺失或损坏返回 found=false, nil。
func ReadSettings(ctx context.Context, databasePath string) (*Settings, error) {
	path := strings.TrimSpace(databasePath)
	if path == "" {
		return nil, nil
	}
	raw, found, err := appstate.ReadKV(ctx, path, SettingsKVKey)
	if err != nil {
		return nil, err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, nil
	}
	normalized := NormalizeModelProvider(NormalizeSettingsMap(parsed))
	return &normalized, nil
}

// WriteSettingsPatch 验证允许修改的字段、合并现状后写入 app-state.db。
func WriteSettingsPatch(
	ctx context.Context,
	databasePath string,
	patchRaw map[string]any,
	now time.Time,
) (Settings, error) {
	path := strings.TrimSpace(databasePath)
	if path == "" {
		return Settings{}, &ConfigError{
			StatusCode: 503,
			Code:       "translation_home_dir_unavailable",
			Detail:     "数据目录不可用",
		}
	}

	baseMap := map[string]any{}
	if existingRaw, found, err := appstate.ReadKV(ctx, path, SettingsKVKey); err == nil && found && strings.TrimSpace(existingRaw) != "" {
		var parsed map[string]any
		if json.Unmarshal([]byte(existingRaw), &parsed) == nil && parsed != nil {
			normalizedCurrent := NormalizeModelProvider(NormalizeSettingsMap(parsed))
			if encoded, err := json.Marshal(normalizedCurrent); err == nil {
				_ = json.Unmarshal(encoded, &baseMap)
			}
		}
	} else if defBytes, err := json.Marshal(DefaultSettings()); err == nil {
		_ = json.Unmarshal(defBytes, &baseMap)
	}

	if v, ok := patchRaw["source"]; ok {
		code := NormalizeLanguageCode(asString(v))
		if code != AutoLanguage && !IsSupportedLanguage(code) {
			return Settings{}, &ConfigError{
				StatusCode: 400,
				Code:       "translation_source_unsupported",
				Detail:     "源语言不受支持",
			}
		}
		if code == "" {
			code = AutoLanguage
		}
		baseMap["source"] = code
	}
	if v, ok := patchRaw["target"]; ok {
		code := NormalizeLanguageCode(asString(v))
		if !IsSupportedLanguage(code) {
			return Settings{}, &ConfigError{
				StatusCode: 400,
				Code:       "translation_target_unsupported",
				Detail:     "目标语言不受支持",
			}
		}
		baseMap["target"] = code
	}
	if v, ok := patchRaw["model"]; ok {
		baseMap["model"] = strings.TrimSpace(asString(v))
	}
	if v, ok := patchRaw["provider"]; ok {
		baseMap["provider"] = strings.ToLower(strings.TrimSpace(asString(v)))
	}
	if v, ok := patchRaw["targetPolicy"]; ok {
		baseMap["targetPolicy"] = strings.ToLower(strings.TrimSpace(asString(v)))
	}
	if v, ok := patchRaw["autoCopy"]; ok {
		baseMap["autoCopy"] = v == true
	}
	if v, ok := patchRaw["copyScope"]; ok {
		baseMap["copyScope"] = strings.ToLower(strings.TrimSpace(asString(v)))
	}
	if v, ok := patchRaw["routes"]; ok {
		baseMap["routes"] = v
	}

	updatedMS := now.UnixMilli()
	if updatedMS <= 0 {
		updatedMS = time.Now().UnixMilli()
	}
	baseMap["updatedAt"] = updatedMS

	next := NormalizeModelProvider(NormalizeSettingsMap(baseMap))
	payload, err := json.Marshal(next)
	if err != nil {
		return Settings{}, &ConfigError{
			StatusCode: 500,
			Code:       "translation_settings_write_failed",
			Detail:     "保存翻译设置失败",
		}
	}
	if err := appstate.WriteKV(ctx, path, SettingsKVKey, string(payload), updatedMS); err != nil {
		return Settings{}, &ConfigError{
			StatusCode: 500,
			Code:       "translation_settings_write_failed",
			Detail:     "保存翻译设置失败",
		}
	}
	return next, nil
}
