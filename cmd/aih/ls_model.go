package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/accountlistread"
)

// lsAccount 是 `aih ls` 一行消费的完整视图。
type lsAccount struct {
	Account accountlistread.Account

	Configured       bool
	APIKeyMode       bool
	BaseURL          string
	MaskedKey        string
	IdentityVariants []string
	IdentityKey      string

	PlanType  string
	PlanLabel string

	UsageVariants []string
	UsageLabel    string
	RemainingPct  *float64
	QuotaStatus   string

	Runtime        lsRuntimeStatus
	RuntimeBlocked bool
	Throttle       []string

	IsMobile    bool
	DuplicateOf int64
	Hidden      bool

	rotationSlot  int
	rotatingCount int
}

// lsRuntimeStatus 是账号级运行态结论。
type lsRuntimeStatus struct {
	Status string
	Until  time.Time
	Reason string
}

func (status lsRuntimeStatus) normalized() string {
	return strings.ToLower(strings.TrimSpace(status.Status))
}

func (status lsRuntimeStatus) blocked() bool {
	normalized := status.normalized()
	return normalized != "" && normalized != "healthy" && normalized != "unknown"
}

// buildLSAccounts 把只读投影派生为列表行模型。
func buildLSAccounts(
	snapshot *accountlistread.Snapshot,
	mobileRef string,
	now time.Time,
) []*lsAccount {
	if snapshot == nil {
		return nil
	}
	accounts := make([]*lsAccount, 0, len(snapshot.Accounts))
	for _, raw := range snapshot.Accounts {
		account := &lsAccount{Account: raw}
		account.Configured = len(raw.CredentialJSON) > 0
		facts := extractLSIdentity(raw.CredentialJSON, raw.Provider, raw.AuthKind, raw.AuthMode)
		if len(raw.NodeNativeAuth) > 0 {
			facts = mergeLSIdentityFacts(facts, extractLSIdentity(raw.NodeNativeAuth, raw.Provider, raw.AuthKind, raw.AuthMode))
		}
		if len(raw.NodeEnv) > 0 {
			facts = mergeLSIdentityFacts(facts, extractLSIdentity(raw.NodeEnv, raw.Provider, raw.AuthKind, raw.AuthMode))
		}
		account.APIKeyMode = lsAPIKeyMode(raw.AuthKind, raw.AuthMode)
		account.BaseURL = facts.BaseURL
		account.MaskedKey = facts.MaskedKey
		if account.APIKeyMode && raw.Provider == "opencode" && facts.MaskedKey == "" && facts.BaseURL == "" {
			// opencode 的 api_key 账号在 Go 库里只有 auth.type=api，没有 key 正文；
			// Node 侧不把它当 API Key mode，而显示 OpenCode API 与 Unknown。
			account.APIKeyMode = false
		}
		account.IdentityVariants = buildLSIdentityVariants(raw, facts, account.APIKeyMode)
		account.IdentityKey = lsIdentityKeyForProvider(raw, facts, account.IdentityVariants)
		doc := parseLSUsageDocument(raw.Snapshot)
		account.PlanType, account.PlanLabel = lsPlan(raw, facts, doc, account.APIKeyMode)
		account.UsageVariants, account.UsageLabel, account.RemainingPct, account.QuotaStatus = lsUsage(raw, doc, account.APIKeyMode, account.Configured)
		account.Runtime = lsRuntimeStatusFor(raw, now)
		account.RuntimeBlocked = account.Runtime.blocked()
		account.Throttle = lsThrottleVariants(raw, account.Runtime, now)
		account.IsMobile = raw.Provider == "codex" && mobileRef != "" && raw.AccountRef == mobileRef
		account.Hidden = shouldHideLSAccount(*account)
		accounts = append(accounts, account)
	}
	assignLSDuplicates(accounts)
	return accounts
}

func shouldHideLSAccount(account lsAccount) bool {
	// 与旧 Node 列表不同：这里不隐藏额度为 0 的账号。Go 的 quota 快照与 Node
	// 的索引可能不同步（cline 2 号就是 Node 显示 Unknown、Go 快照已耗尽），
	// 隐藏会让账号直接消失；列表宁可显示 0% / 已耗尽，也不丢行。
	return false
}

func assignLSDuplicates(accounts []*lsAccount) {
	byProvider := make(map[string][]*lsAccount)
	for _, account := range accounts {
		byProvider[account.Account.Provider] = append(byProvider[account.Account.Provider], account)
	}
	for _, group := range byProvider {
		sort.SliceStable(group, func(left, right int) bool {
			return group[left].Account.CLIAccountID < group[right].Account.CLIAccountID
		})
		seen := make(map[string]int64)
		for _, account := range group {
			if account.Hidden || !account.Configured || account.APIKeyMode {
				continue
			}
			name := ""
			if len(account.IdentityVariants) > 0 {
				name = strings.TrimSpace(account.IdentityVariants[0])
			}
			if name == "" {
				name = strings.TrimSpace(account.Account.DisplayName)
			}
			if name == "" {
				name = strings.TrimSpace(account.Account.Email)
			}
			if name == "" || name == "Unknown" || name == "Token Configured" || strings.HasPrefix(name, "API Key") {
				continue
			}
			key := strings.TrimSpace(account.IdentityKey)
			if key != "" {
				key = "identity:" + key
			} else {
				key = "name:" + name
			}
			if first, exists := seen[key]; exists {
				account.DuplicateOf = first
				continue
			}
			seen[key] = account.Account.CLIAccountID
		}
	}
}

// lsAPIKeyMode 判断账号是否按 API Key / Auth Token 形态展示。
func lsAPIKeyMode(authKind string, authMode string) bool {
	kind := strings.ToLower(strings.TrimSpace(authKind))
	mode := strings.ToLower(strings.TrimSpace(authMode))
	if kind == "api_key" || kind == "auth_token" || kind == "vertex_ai" {
		return true
	}
	return strings.Contains(kind, "api_key") || mode == "api_key"
}

// lsPlan 解析套餐 token 并映射成用户可见标签。
func lsPlan(
	account accountlistread.Account,
	facts lsIdentityFacts,
	doc lsUsageDocument,
	apiKeyMode bool,
) (string, string) {
	if apiKeyMode {
		return "", ""
	}
	planType := ""
	for _, entry := range account.Usage {
		if strings.TrimSpace(entry.PlanType) != "" {
			planType = strings.TrimSpace(entry.PlanType)
		}
	}
	if planType == "" {
		planType = strings.TrimSpace(facts.PlanType)
	}
	if planType == "" {
		planType = strings.TrimSpace(doc.Account.PlanType)
	}
	planType = normalizeLSToken(planType)
	if planType == "" || planType == "free" || planType == "unknown" || planType == "oauth" {
		return planType, ""
	}
	label := ""
	if facts.RateLimitTier == "" {
		facts.RateLimitTier = doc.Account.RateLimitTier
	}
	switch strings.ToLower(account.Provider) {
	case "codex":
		label = map[string]string{
			"go": "Go", "plus": "Plus", "pro": "Pro",
			"prolite": "Pro Lite", "pro_lite": "Pro Lite",
			"team": "Team", "self_serve_business_usage_based": "Business",
			"business": "Business", "enterprise_cbp_usage_based": "Enterprise",
			"enterprise": "Enterprise", "hc": "Enterprise",
			"edu": "Edu", "education": "Edu",
		}[planType]
	case "claude":
		if planType == "max" {
			tier := normalizeLSToken(facts.RateLimitTier)
			label = map[string]string{
				"default_claude_max_5x": "Max 5x", "claude_max_5x": "Max 5x", "max_5x": "Max 5x",
				"default_claude_max_20x": "Max 20x", "claude_max_20x": "Max 20x", "max_20x": "Max 20x",
			}[tier]
			if label == "" {
				label = "Max"
			}
		} else {
			label = map[string]string{
				"pro": "Pro", "team": "Team", "business": "Business", "enterprise": "Enterprise",
			}[planType]
		}
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		label = map[string]string{
			"pro": "Pro", "pro_plus": "Pro Plus", "youth": "Youth",
			"advanced": "Advanced", "flagship": "Flagship",
		}[planType]
	}
	return planType, label
}

func normalizeLSToken(value string) string {
	return strings.ToLower(strings.NewReplacer(" ", "_", "-", "_").Replace(strings.TrimSpace(value)))
}

// lsUsage 生成完整行标签、轮换候选、最小剩余与额度状态。
func lsUsage(
	account accountlistread.Account,
	doc lsUsageDocument,
	apiKeyMode bool,
	configured bool,
) (variants []string, label string, remaining *float64, quotaStatus string) {
	if account.Snapshot != nil {
		quotaStatus = strings.ToLower(strings.TrimSpace(account.Snapshot.QuotaStatus))
	}
	if account.Snapshot != nil && account.Snapshot.HasNumericRemaining && account.Snapshot.RemainingBPS != nil {
		value := float64(*account.Snapshot.RemainingBPS) / 100
		remaining = &value
	}
	if apiKeyMode || !configured {
		return nil, "", remaining, quotaStatus
	}

	shape := lsUsageShape(account, doc)
	switch shape {
	case "window":
		variants, label, remaining = lsWindowUsage(account, doc, remaining)
	case "models":
		variants, label, remaining = lsModelUsage(account, doc, remaining)
	default:
		variants, label, remaining = lsBucketUsage(account, doc, remaining)
	}
	if quotaStatus == "" && remaining != nil {
		if *remaining <= 0 {
			quotaStatus = "exhausted"
		} else {
			quotaStatus = "available"
		}
	}
	return variants, label, remaining, quotaStatus
}

func lsUsageShape(account accountlistread.Account, doc lsUsageDocument) string {
	if len(doc.Models) > 0 {
		return "models"
	}
	for _, entry := range doc.Entries {
		if strings.TrimSpace(entry.Window) != "" {
			return "window"
		}
	}
	for _, entry := range account.Usage {
		if entry.WindowSeconds > 0 {
			return "window"
		}
	}
	return "bucket"
}

func lsWindowUsage(
	account accountlistread.Account,
	doc lsUsageDocument,
	fallback *float64,
) ([]string, string, *float64) {
	type window struct {
		label   string
		minutes int
		pct     *float64
	}
	byBucket := make(map[string]accountlistread.UsageEntry)
	for _, entry := range account.Usage {
		byBucket[entry.Bucket] = entry
	}
	windows := make([]window, 0)
	seen := make(map[string]bool)
	for _, entry := range doc.Entries {
		windowLabel := strings.TrimSpace(entry.Window)
		if windowLabel == "" {
			continue
		}
		minutes := entry.WindowMinutes
		if minutes == 0 {
			minutes = int(byBucket[entry.Bucket].WindowSeconds / 60)
		}
		label := humanizeLSWindow(windowLabel, minutes)
		if seen[label] {
			continue
		}
		seen[label] = true
		windows = append(windows, window{label: label, minutes: minutes, pct: entry.RemainingPct})
	}
	if len(windows) == 0 {
		for _, entry := range account.Usage {
			if entry.WindowSeconds <= 0 {
				continue
			}
			label := humanizeLSWindow(entry.Bucket, int(entry.WindowSeconds/60))
			if seen[label] {
				continue
			}
			seen[label] = true
			var pct *float64
			if entry.RemainingBPS != nil {
				value := float64(*entry.RemainingBPS) / 100
				pct = &value
			}
			windows = append(windows, window{label: label, minutes: int(entry.WindowSeconds / 60), pct: pct})
		}
	}
	sort.SliceStable(windows, func(left, right int) bool {
		if windows[left].minutes != windows[right].minutes {
			return windows[left].minutes < windows[right].minutes
		}
		return windows[left].label < windows[right].label
	})
	variants := make([]string, 0, len(windows))
	parts := make([]string, 0, len(windows))
	minValue := fallback
	for _, window := range windows {
		if window.pct == nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s: %.1f%%", window.label, *window.pct))
		variants = append(variants, fmt.Sprintf("%s: %.1f%%", window.label, *window.pct))
		if minValue == nil || *window.pct < *minValue {
			value := *window.pct
			minValue = &value
		}
	}
	return capLSVariants(variants), strings.Join(parts, " / "), minValue
}

func lsBucketUsage(
	account accountlistread.Account,
	doc lsUsageDocument,
	fallback *float64,
) ([]string, string, *float64) {
	type scope struct {
		label          string
		pct            *float64
		remainingUnits *float64
		totalUnits     *float64
		unitType       string
	}
	scopes := make([]scope, 0)
	if len(doc.Entries) > 0 {
		for _, entry := range doc.Entries {
			if isSecondaryLSUsageCategory(entry.Category) {
				continue
			}
			label := lsBucketLabel(entry.Bucket, entry.Window, account.Provider)
			scopes = append(scopes, scope{
				label: label, pct: entry.RemainingPct,
				remainingUnits: entry.RemainingUnits, totalUnits: entry.TotalUnits,
				unitType: entry.UnitType,
			})
		}
	} else {
		for _, entry := range account.Usage {
			if strings.EqualFold(entry.Kind, "credits") && entry.Scope != "account" {
				continue
			}
			var pct *float64
			if entry.RemainingBPS != nil {
				value := float64(*entry.RemainingBPS) / 100
				pct = &value
			}
			scopes = append(scopes, scope{label: lsBucketLabel(entry.Bucket, "", account.Provider), pct: pct})
		}
	}
	variants := make([]string, 0, 6)
	parts := make([]string, 0, len(scopes))
	minValue := fallback
	for _, scope := range scopes {
		if scope.pct == nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s: %.1f%%", scope.label, *scope.pct))
		variants = append(variants, fmt.Sprintf("%s: %.1f%%", scope.label, *scope.pct))
		if units := formatLSUsUnits(scope.remainingUnits, scope.totalUnits, scope.unitType); units != "" {
			variants = append(variants, units)
		}
		if minValue == nil || *scope.pct < *minValue {
			value := *scope.pct
			minValue = &value
		}
	}
	full := strings.Join(parts, " / ")
	// Node 对纯 credits 账号的行内标签只显示百分比，不带“Credits:”前缀。
	if len(parts) == 1 && strings.EqualFold(scopes[0].label, "Credits") && scopes[0].remainingUnits == nil {
		full = fmt.Sprintf("%.1f%%", *scopes[0].pct)
	}
	return capLSVariants(variants), full, minValue
}

func lsModelUsage(
	account accountlistread.Account,
	doc lsUsageDocument,
	fallback *float64,
) ([]string, string, *float64) {
	type model struct {
		name  string
		pct   float64
		reset string
	}
	models := make([]model, 0)
	for _, entry := range doc.Models {
		if entry.RemainingPct == nil {
			continue
		}
		name := strings.TrimSpace(entry.Model)
		if name == "" {
			name = strings.TrimSpace(entry.DisplayName)
		}
		if name == "" {
			continue
		}
		models = append(models, model{name: name, pct: *entry.RemainingPct, reset: strings.TrimSpace(entry.ResetIn)})
	}
	if len(models) == 0 {
		for _, entry := range account.Usage {
			if entry.RemainingBPS == nil || entry.ScopeKey == "" {
				continue
			}
			models = append(models, model{name: entry.ScopeKey, pct: float64(*entry.RemainingBPS) / 100})
		}
	}
	sort.SliceStable(models, func(left, right int) bool {
		if models[left].pct != models[right].pct {
			return models[left].pct < models[right].pct
		}
		return models[left].name < models[right].name
	})
	variants := make([]string, 0, len(models))
	parts := make([]string, 0, len(models))
	minValue := fallback
	for _, model := range models {
		part := fmt.Sprintf("%s %.1f%%", model.name, model.pct)
		if model.reset != "" {
			part += " / " + model.reset
		}
		parts = append(parts, part)
		variants = append(variants, part)
		if minValue == nil || model.pct < *minValue {
			value := model.pct
			minValue = &value
		}
	}
	return capLSVariants(variants), strings.Join(parts, " / "), minValue
}

func capLSVariants(values []string) []string {
	if len(values) > 6 {
		return values[:6]
	}
	return values
}

func isSecondaryLSUsageCategory(category string) bool {
	switch strings.ToLower(strings.TrimSpace(category)) {
	case "gift", "detail":
		return true
	default:
		return false
	}
}

func lsBucketLabel(bucket string, window string, provider string) string {
	if label := humanizeLSBucket(bucket); label != "" {
		return label
	}
	if window != "" {
		return humanizeLSWindow(window, 0)
	}
	return "Balance"
}

func humanizeLSBucket(bucket string) string {
	lower := strings.ToLower(strings.TrimSpace(bucket))
	labels := map[string]string{
		"credits": "Credits", "credit": "Credits", "balance": "Balance",
		"monthly": "Monthly", "monthly_quota": "Monthly",
		"five_hour": "5h", "five_hour_window": "5h",
		"seven_day": "7days", "seven_day_window": "7days",
		"daily": "Daily", "weekly": "Weekly", "gift": "Gift",
	}
	if label, ok := labels[lower]; ok {
		return label
	}
	if strings.HasPrefix(lower, "gift:") || strings.HasPrefix(lower, "detail:") {
		return strings.TrimSpace(bucket[strings.Index(bucket, ":")+1:])
	}
	return strings.TrimSpace(bucket)
}

func humanizeLSWindow(window string, minutes int) string {
	text := strings.TrimSpace(window)
	if matched, ok := parseLSMinutes(text); ok {
		minutes = matched
		text = ""
	}
	if text != "" {
		return text
	}
	if minutes <= 0 {
		return "Balance"
	}
	if minutes%1440 == 0 {
		return fmt.Sprintf("%ddays", minutes/1440)
	}
	if minutes%60 == 0 {
		return fmt.Sprintf("%dh", minutes/60)
	}
	days := minutes / 1440
	hours := (minutes % 1440) / 60
	rest := minutes % 60
	var builder strings.Builder
	if days > 0 {
		builder.WriteString(strconv.Itoa(days))
		builder.WriteString("d")
	}
	if hours > 0 {
		builder.WriteString(strconv.Itoa(hours))
		builder.WriteString("h")
	}
	if rest > 0 {
		builder.WriteString(strconv.Itoa(rest))
		builder.WriteString("m")
	}
	if builder.Len() == 0 {
		return fmt.Sprintf("%dm", minutes)
	}
	return builder.String()
}

func parseLSMinutes(value string) (int, bool) {
	text := strings.TrimSpace(strings.ToLower(value))
	if !strings.HasSuffix(text, "m") {
		return 0, false
	}
	number := strings.TrimSuffix(text, "m")
	minutes, err := strconv.Atoi(number)
	if err != nil || minutes <= 0 {
		return 0, false
	}
	return minutes, true
}

func formatLSUsUnits(remaining *float64, total *float64, unitType string) string {
	if remaining == nil && total == nil {
		return ""
	}
	symbol := ""
	if strings.EqualFold(unitType, "usd") {
		symbol = "$"
	}
	suffix := ""
	if unitType != "" && !strings.EqualFold(unitType, "usd") {
		suffix = " " + unitType
	}
	render := func(value *float64) string {
		if value == nil {
			return "?"
		}
		return fmt.Sprintf("%s%.2f", symbol, *value)
	}
	if remaining != nil && total != nil {
		return render(remaining) + " / " + render(total) + suffix
	}
	return render(remaining) + suffix
}

// lsThrottleVariants 生成账号级与模型级限流候选。
func lsThrottleVariants(account accountlistread.Account, runtime lsRuntimeStatus, now time.Time) []string {
	if variants, handled := lsJSONThrottleVariants(account, runtime, now); handled {
		return variants
	}
	variants := make([]string, 0, 6)
	push := func(value string) {
		if value == "" {
			return
		}
		for _, existing := range variants {
			if existing == value {
				return
			}
		}
		variants = append(variants, value)
	}
	if runtime.normalized() == "rate_limited" && runtime.Until.After(now) {
		push(fmt.Sprintf("[限流: 账号 至 %s]", formatLSClock(runtime.Until, now)))
	}
	type cooldown struct {
		model string
		until time.Time
		kind  string
	}
	active := make([]cooldown, 0, len(account.Cooldowns))
	for _, entry := range account.Cooldowns {
		if entry.ModelID == "" || entry.CooldownUntilMS <= 0 {
			continue
		}
		until := time.UnixMilli(entry.CooldownUntilMS)
		if !until.After(now) {
			continue
		}
		kind := entry.StreakKind
		if kind == "" {
			kind = entry.CooldownKind
		}
		active = append(active, cooldown{model: entry.ModelID, until: until, kind: kind})
	}
	sort.SliceStable(active, func(left, right int) bool {
		if !active[left].until.Equal(active[right].until) {
			return active[left].until.Before(active[right].until)
		}
		return active[left].model < active[right].model
	})
	for _, entry := range active {
		title := "受限"
		switch strings.ToLower(entry.kind) {
		case "rate_limited", "model_quota_exhausted", "model_overloaded", "model_capacity_unavailable":
			title = "限流"
		}
		push(fmt.Sprintf("[%s: %s 至 %s]", title, entry.model, formatLSClock(entry.until, now)))
	}
	if len(variants) > 6 {
		return variants[:6]
	}
	return variants
}

func lsJSONThrottleVariants(account accountlistread.Account, runtime lsRuntimeStatus, now time.Time) ([]string, bool) {
	if account.Runtime == nil || len(account.Runtime.Document) == 0 {
		return nil, false
	}
	var raw struct {
		ModelCooldowns      map[string]float64 `json:"modelCooldowns"`
		ModelFailureStreaks map[string]struct {
			Kind string `json:"kind"`
		} `json:"modelFailureStreaks"`
	}
	if json.Unmarshal(account.Runtime.Document, &raw) != nil {
		return nil, false
	}
	if raw.ModelCooldowns == nil {
		return nil, false
	}
	variants := make([]string, 0, 6)
	push := func(value string) {
		if value == "" {
			return
		}
		for _, existing := range variants {
			if existing == value {
				return
			}
		}
		variants = append(variants, value)
	}
	if runtime.normalized() == "rate_limited" && runtime.Until.After(now) {
		push(fmt.Sprintf("[限流: 账号 至 %s]", formatLSClock(runtime.Until, now)))
	}
	type item struct {
		model string
		until time.Time
		kind  string
	}
	items := make([]item, 0, len(raw.ModelCooldowns))
	for model, untilMS := range raw.ModelCooldowns {
		if strings.TrimSpace(model) == "" || untilMS <= 0 {
			continue
		}
		until := time.UnixMilli(int64(untilMS))
		if !until.After(now) {
			continue
		}
		kind := raw.ModelFailureStreaks[model].Kind
		items = append(items, item{model: model, until: until, kind: kind})
	}
	sort.SliceStable(items, func(left, right int) bool {
		if !items[left].until.Equal(items[right].until) {
			return items[left].until.Before(items[right].until)
		}
		return items[left].model < items[right].model
	})
	for _, entry := range items {
		title := "受限"
		switch strings.ToLower(entry.kind) {
		case "rate_limited", "model_quota_exhausted", "model_overloaded", "model_capacity_unavailable":
			title = "限流"
		}
		push(fmt.Sprintf("[%s: %s 至 %s]", title, entry.model, formatLSClock(entry.until, now)))
	}
	if len(variants) > 6 {
		variants = variants[:6]
	}
	return variants, true
}

// lsZcodeSessionExpired 复刻 Node isZcodeDesktopSessionExpired：
// access_token 是无 refresh 的 JWT 且 exp 已过期。
func lsZcodeSessionExpired(raw []byte, now time.Time) bool {
	if len(raw) == 0 {
		return false
	}
	var payload struct {
		NativeAuth struct {
			Credentials map[string]any `json:"credentials"`
		} `json:"native_auth_json"`
		Credentials map[string]any `json:"credentials"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return false
	}
	credentials := payload.NativeAuth.Credentials
	if credentials == nil {
		credentials = payload.Credentials
	}
	if credentials == nil {
		return false
	}
	active := strings.TrimSpace(lsStringValue(credentials["oauth:active_provider"]))
	regions := []string{"zai"}
	if active != "" {
		regions = []string{active, "zai"}
	}
	access := ""
	refresh := ""
	for _, region := range regions {
		if access == "" {
			access = strings.TrimSpace(lsStringValue(credentials["oauth:"+region+":access_token"]))
		}
		if refresh == "" {
			refresh = strings.TrimSpace(lsStringValue(credentials["oauth:"+region+":refresh_token"]))
		}
	}
	if access == "" || refresh != "" {
		return false
	}
	parts := strings.Split(access, ".")
	if len(parts) < 2 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(decoded, &claims) != nil || claims.Exp <= 0 {
		return false
	}
	return time.Unix(claims.Exp, 0).Before(now) || time.Unix(claims.Exp, 0).Equal(now)
}

func lsStringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func formatLSClock(until time.Time, now time.Time) string {
	if until.IsZero() {
		return ""
	}
	clock := until.Format("15:04")
	if until.Year() == now.Year() && until.YearDay() == now.YearDay() {
		return clock
	}
	return until.Format("01-02 15:04")
}

func lsRuntimeStatusFor(account accountlistread.Account, now time.Time) lsRuntimeStatus {
	zcodeCredential := account.CredentialJSON
	if len(account.NodeNativeAuth) > 0 {
		zcodeCredential = account.NodeNativeAuth
	}
	if account.Provider == "zcode" && lsZcodeSessionExpired(zcodeCredential, now) {
		return lsRuntimeStatus{Status: "auth_invalid", Reason: "zcode_access_token_expired"}
	}
	if account.Runtime == nil || len(account.Runtime.Document) == 0 {
		return lsRuntimeStatus{Status: "healthy"}
	}
	// Go 的 DeriveStatus 只认带 until 的 routingBlock；Node 对 recheck=manual
	// 的阻塞视为持续生效（codebuddy 的 permission_denied 就是这种形状）。
	var raw struct {
		RoutingBlock *struct {
			Kind    string   `json:"kind"`
			Reason  string   `json:"reason"`
			Recheck string   `json:"recheck"`
			Until   *float64 `json:"until"`
		} `json:"routingBlock"`
	}
	if json.Unmarshal(account.Runtime.Document, &raw) == nil && raw.RoutingBlock != nil &&
		strings.EqualFold(strings.TrimSpace(raw.RoutingBlock.Recheck), "manual") {
		return lsRuntimeStatus{
			Status: strings.TrimSpace(raw.RoutingBlock.Kind),
			Reason: strings.TrimSpace(raw.RoutingBlock.Reason),
		}
	}
	ref, err := accountcore.ParseAccountRef(account.AccountRef)
	if err != nil {
		return lsRuntimeStatus{Status: "healthy"}
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: ref,
		Document:   account.Runtime.Document,
		UpdatedAt:  account.Runtime.UpdatedAt,
	})
	if err != nil {
		return lsRuntimeStatus{Status: "healthy"}
	}
	derived := state.DeriveStatus(now)
	return lsRuntimeStatus{
		Status: derived.Status(),
		Until:  derived.Until(),
		Reason: derived.Reason(),
	}
}

// lsIdentityFacts 是从凭据 JSON 中提取到的展示身份。
type lsIdentityFacts struct {
	Emails        []string
	Phones        []string
	Nicknames     []string
	IDs           []string
	BaseURL       string
	MaskedKey     string
	PlanType      string
	RateLimitTier string
}

func extractLSIdentity(raw []byte, provider string, authKind string, authMode string) lsIdentityFacts {
	facts := lsIdentityFacts{}
	if len(raw) == 0 {
		return facts
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return facts
	}
	apiKeyMode := lsAPIKeyMode(authKind, authMode)
	walkLSIdentity(value, "", 0, apiKeyMode, &facts)
	return facts
}

func walkLSIdentity(value any, path string, depth int, apiKeyMode bool, facts *lsIdentityFacts) {
	if depth > 8 {
		return
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			lower := strings.ToLower(strings.TrimSpace(key))
			childPath := lower
			if path != "" {
				childPath = path + "." + lower
			}
			switch childTyped := child.(type) {
			case string:
				text := strings.TrimSpace(childTyped)
				if text == "" {
					continue
				}
				switch {
				case lower == "email" || lower == "emailaddress" || lower == "email_address" || lower == "mail":
					facts.addEmail(text)
				case lower == "phone" || lower == "phonenumber" || lower == "phone_number" || lower == "mobile":
					facts.addPhone(text)
				case lower == "nickname" || lower == "displayname" || lower == "display_name" || lower == "username" || lower == "user_name" || lower == "name":
					facts.addNickname(text, path)
				case lower == "uniqueuserid" || lower == "oneidaccountid" || lower == "accountid" || lower == "account_id" || lower == "userid" || lower == "user_id" || lower == "uid" || lower == "sub":
					facts.addID(text)
				case lower == "id" && (strings.Contains(path, "user") || strings.Contains(path, "account") || strings.Contains(path, "profile") || strings.Contains(path, "oauth")):
					facts.addID(text)
				case lower == "base_url" || lower == "baseurl" || strings.HasSuffix(lower, "_base_url"):
					if facts.BaseURL == "" {
						facts.BaseURL = text
					}
				case apiKeyMode && (lower == "api_key" || lower == "apikey" || lower == "api-key" || lower == "key" || lower == "token" || lower == "access_token" || strings.HasSuffix(lower, "_api_key") || strings.HasSuffix(lower, "_auth_token")):
					if facts.MaskedKey == "" {
						facts.MaskedKey = maskLSSecret(text)
					}
				case lower == "plantype" || lower == "plan_type":
					facts.PlanType = text
				case lower == "ratelimittier" || lower == "rate_limit_tier":
					facts.RateLimitTier = text
				}
				if looksLikeLSJSON(text) && isLSJSONContainerKey(lower) {
					var nested any
					if json.Unmarshal([]byte(text), &nested) == nil {
						walkLSIdentity(nested, childPath, depth+1, apiKeyMode, facts)
					}
				}
			case map[string]any, []any:
				walkLSIdentity(childTyped, childPath, depth+1, apiKeyMode, facts)
			}
		}
	case []any:
		for _, child := range typed {
			walkLSIdentity(child, path, depth+1, apiKeyMode, facts)
		}
	}
}

func (facts *lsIdentityFacts) addEmail(value string) {
	if strings.Contains(value, "@") && !containsLS(facts.Emails, value) {
		facts.Emails = append(facts.Emails, value)
	}
}

func (facts *lsIdentityFacts) addPhone(value string) {
	cleaned := strings.TrimSpace(value)
	if cleaned == "" || containsLS(facts.Phones, cleaned) {
		return
	}
	facts.Phones = append(facts.Phones, cleaned)
}

func (facts *lsIdentityFacts) addNickname(value string, path string) {
	text := strings.TrimSpace(value)
	if text == "" || len([]rune(text)) > 80 || containsLS(facts.Nicknames, text) {
		return
	}
	// 根级 name 经常是 Provider 自己的名字，交给上层过滤，不要当身份。
	if strings.TrimSpace(path) == "" && strings.EqualFold(text, "AIH") {
		return
	}
	facts.Nicknames = append(facts.Nicknames, text)
}

func (facts *lsIdentityFacts) addID(value string) {
	text := strings.TrimSpace(value)
	if text == "" || containsLS(facts.IDs, text) {
		return
	}
	facts.IDs = append(facts.IDs, text)
}

func containsLS(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func looksLikeLSJSON(value string) bool {
	trimmed := strings.TrimSpace(value)
	return len(trimmed) > 1 && (trimmed[0] == '{' || trimmed[0] == '[')
}

func isLSJSONContainerKey(key string) bool {
	if strings.Contains(key, "user_info") || strings.Contains(key, "userinfo") {
		return true
	}
	switch key {
	case "metadata", "account", "profile", "user", "oauth", "info", "credentials", "native_auth_json", "auth", "tokens", "token":
		return true
	default:
		return false
	}
}

func maskLSSecret(value string) string {
	text := strings.TrimSpace(value)
	if len(text) > 10 {
		return text[:5] + "..." + text[len(text)-4:]
	}
	if len(text) >= 4 {
		return "..." + text[len(text)-4:]
	}
	if text != "" {
		return text
	}
	return "Configured"
}

func buildLSIdentityVariants(account accountlistread.Account, facts lsIdentityFacts, apiKeyMode bool) []string {
	variants := make([]string, 0, 4)
	seen := make(map[string]bool)
	push := func(value string) {
		text := strings.TrimSpace(value)
		if text == "" || seen[text] {
			return
		}
		seen[text] = true
		variants = append(variants, text)
	}
	provider := strings.ToLower(account.Provider)
	if provider == "cline" {
		name := meaningfulLSName(account.DisplayName, account.Provider)
		if name == "" {
			for _, candidate := range facts.Nicknames {
				if meaningfulLSName(candidate, account.Provider) != "" {
					name = candidate
					break
				}
			}
		}
		if name != "" {
			push(name)
		}
		return variants
	}
	if apiKeyMode {
		if strings.EqualFold(account.Provider, "opencode") && facts.MaskedKey != "" {
			push("OpenCode API (" + maskLSSuffix(facts.MaskedKey) + ")")
		} else if facts.MaskedKey != "" {
			push("API Key: " + facts.MaskedKey)
		} else if facts.BaseURL != "" {
			push(lsHost(facts.BaseURL))
		} else {
			push("API Key")
		}
		return variants
	}

	if provider == "qoder" || provider == "qodercn" {
		email := strings.TrimSpace(account.Email)
		if email == "" && len(facts.Emails) > 0 {
			email = facts.Emails[0]
		}
		if email != "" {
			push(email)
			return variants
		}
		if name := meaningfulLSName(account.DisplayName, account.Provider); name != "" {
			push(name)
		}
		return variants
	}
	email := strings.TrimSpace(account.Email)
	if email == "" && len(facts.Emails) > 0 {
		email = facts.Emails[0]
	}
	phone := ""
	if email != "" {
		if matched, ok := syntheticLSPhone(email); ok {
			phone = matched
			email = ""
		}
	}
	if phone == "" && len(facts.Phones) > 0 {
		phone = facts.Phones[0]
	}
	if email != "" {
		push(email)
	}
	if phone != "" {
		push(phone)
	}
	name := meaningfulLSName(account.DisplayName, account.Provider)
	if name == "" {
		for _, candidate := range facts.Nicknames {
			if meaningfulLSName(candidate, account.Provider) != "" {
				name = candidate
				break
			}
		}
	}
	if name != "" {
		push(name)
	}
	if len(variants) == 0 {
		switch strings.ToLower(account.Provider) {
		case "opencode":
			push("OpenCode API")
		case "zcode":
			push("ZCode OAuth")
		}
	}
	return variants
}

func mergeLSIdentityFacts(base lsIdentityFacts, extra lsIdentityFacts) lsIdentityFacts {
	for _, value := range extra.Emails {
		if !containsLS(base.Emails, value) {
			base.Emails = append(base.Emails, value)
		}
	}
	for _, value := range extra.Phones {
		if !containsLS(base.Phones, value) {
			base.Phones = append(base.Phones, value)
		}
	}
	for _, value := range extra.Nicknames {
		if !containsLS(base.Nicknames, value) {
			base.Nicknames = append(base.Nicknames, value)
		}
	}
	for _, value := range extra.IDs {
		if !containsLS(base.IDs, value) {
			base.IDs = append(base.IDs, value)
		}
	}
	if base.BaseURL == "" {
		base.BaseURL = extra.BaseURL
	}
	if base.MaskedKey == "" {
		base.MaskedKey = extra.MaskedKey
	}
	if base.PlanType == "" {
		base.PlanType = extra.PlanType
	}
	if base.RateLimitTier == "" {
		base.RateLimitTier = extra.RateLimitTier
	}
	return base
}

func maskLSSuffix(masked string) string {
	text := strings.TrimSpace(masked)
	if text == "" {
		return "API Key"
	}
	if index := strings.LastIndex(text, "..."); index >= 0 {
		return "..." + text[index+3:]
	}
	return text
}

func meaningfulLSName(value string, provider string) string {
	text := strings.TrimSpace(value)
	if text == "" || text == "Unknown" || strings.HasPrefix(strings.ToLower(text), "api key") || strings.HasPrefix(strings.ToLower(text), "access token") {
		return ""
	}
	normalizedProvider := strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.ToLower(provider))
	normalizedText := strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.ToLower(text))
	if normalizedText == normalizedProvider {
		return ""
	}
	if strings.HasPrefix(normalizedText, normalizedProvider) && strings.ContainsAny(text, "()（）") {
		return ""
	}
	return text
}

func syntheticLSPhone(email string) (string, bool) {
	parts := strings.Split(email, "@")
	if len(parts) != 2 || !strings.EqualFold(parts[1], "phone.local") {
		return "", false
	}
	digits := parts[0]
	if len(digits) < 6 {
		return "", false
	}
	for _, char := range digits {
		if char < '0' || char > '9' {
			return "", false
		}
	}
	return digits, true
}

func lsHost(baseURL string) string {
	text := strings.TrimSpace(baseURL)
	if text == "" {
		return ""
	}
	parsed, err := url.Parse(text)
	if err == nil && parsed.Host != "" {
		return parsed.Host
	}
	return text
}

func lsIdentityKey(facts lsIdentityFacts) string {
	if len(facts.IDs) > 0 {
		return facts.IDs[0]
	}
	if len(facts.Emails) > 0 {
		return facts.Emails[0]
	}
	if len(facts.Phones) > 0 {
		return facts.Phones[0]
	}
	return ""
}

// lsIdentityKeyForProvider 按 Provider 的判重口径取身份键。
// cline 的判重只看展示名，qoder 只看邮箱；其余 Provider 优先用凭据里的稳定 user id。
func lsIdentityKeyForProvider(account accountlistread.Account, facts lsIdentityFacts, variants []string) string {
	provider := strings.ToLower(account.Provider)
	if provider == "cline" {
		if len(variants) > 0 {
			return variants[0]
		}
		return strings.TrimSpace(account.DisplayName)
	}
	if provider == "qoder" || provider == "qodercn" {
		if email := strings.TrimSpace(account.Email); email != "" {
			return email
		}
		if len(facts.Emails) > 0 {
			return facts.Emails[0]
		}
	}
	if key := lsIdentityKey(facts); key != "" {
		return key
	}
	if len(variants) > 0 {
		return variants[0]
	}
	return strings.TrimSpace(account.Email)
}
