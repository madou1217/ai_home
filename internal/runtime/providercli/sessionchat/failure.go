package sessionchat

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// 账号运行态冷却时长（与 Node 的 ACCOUNT_GUESSED_COOLDOWN_MS / ROUTING_BLOCK_RECHECK_MS 同值）。
const accountGuessedCooldownMs int64 = 30 * 1000

// failureRule 是声明式「错误签名 → 结论」规则。
//
// kind=turn 影响本轮结果与换账号重试；kind=blocker 影响账号运行态。
// 命中的第一行胜出，顺序即优先级。
type failureRule struct {
	id           string
	kind         string
	provider     string
	all          []string
	any          []string
	code         string
	message      string
	retryAnother bool
	status       string
	reason       string
	blockerState string
}

// providerFailureRules 与 Node PROVIDER_FAILURE_RULES 同序同值。
var providerFailureRules = []failureRule{
	{
		id: "gemini-permission-denied", kind: "turn", provider: "gemini",
		any:  []string{"permission_denied", "the caller does not have permission", "reason\": \"forbidden\"", "\"status\": \"permission_denied\""},
		code: "gemini_permission_denied", message: "当前 Gemini 账号无权限（PERMISSION_DENIED）", retryAnother: true,
	},
	{
		id: "cline-insufficient-credits", kind: "turn", provider: "cline",
		all: []string{"insufficient balance"}, any: []string{"cline credits", "balance is $0"},
		code: "cline_insufficient_credits", message: "当前 Cline 账号额度不足（Cline Credits 余额为 0），请换账号或充值", retryAnother: true,
	},
	{
		id: "agy-region-not-eligible", kind: "turn", provider: "agy",
		all:  []string{"eligibility check failed"},
		code: "agy_region_not_eligible", message: "该 agy 账号在当前地区不可用（Antigravity 地区资格限制），请换账号或调整出口", retryAnother: true,
	},
	{
		id: "agy-region-not-eligible-blocker", kind: "blocker", provider: "agy",
		all: []string{"eligibility check failed"}, status: "permission_denied",
		reason: "agy_region_not_eligible", blockerState: "permission_denied",
	},
	{
		id: "upstream-rate-limited", kind: "turn", provider: "*",
		any: []string{
			"rate limit", "rate_limit", "too many requests", "429 too many", "last status: 429",
			"usage limit", "quota exceeded", "insufficient_quota", "exceeded your current quota",
		},
		code: "upstream_rate_limited", message: "当前账号已触发上游限流或额度上限", retryAnother: true,
	},
}

// matchesFailureRule 判断规则是否命中：all 全部命中且 any 至少命中一条（都声明时）。
func matchesFailureRule(rule failureRule, lowered string) bool {
	for _, pattern := range rule.all {
		if !strings.Contains(lowered, strings.ToLower(pattern)) {
			return false
		}
	}
	if len(rule.any) > 0 {
		matched := false
		for _, pattern := range rule.any {
			if strings.Contains(lowered, strings.ToLower(pattern)) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return len(rule.all) > 0 || len(rule.any) > 0
}

// findFailureRule 按 kind/provider 查规则，provider 为 * 的通配规则兜底。
func findFailureRule(kind string, provider string, lowered string) *failureRule {
	for index := range providerFailureRules {
		rule := &providerFailureRules[index]
		if rule.kind != kind {
			continue
		}
		if rule.provider != provider && rule.provider != "*" {
			continue
		}
		if matchesFailureRule(*rule, lowered) {
			return rule
		}
	}
	return nil
}

// ansiPattern 匹配 CSI/ANSI 控制序列（同 Node stripAnsi 的正则）。
var ansiPattern = regexp.MustCompile("[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]")

// trailingSpacesPattern 去掉每行末尾的空白（保留 CR/LF/TAB）。
var trailingSpacesPattern = regexp.MustCompile("(?m)[^\\S\r\n\t]+$")

// StripANSI 删除终端控制序列。
func StripANSI(text string) string {
	return ansiPattern.ReplaceAllString(text, "")
}

// SanitizeTerminalText 删除控制序列、NUL 与行尾空白，供日志/阻塞判定使用。
func SanitizeTerminalText(text string) string {
	removedNUL := strings.ReplaceAll(StripANSI(text), "\x00", "")
	return trailingSpacesPattern.ReplaceAllString(removedNUL, "")
}

// FailureDetails 是错误对象的嵌套明细（canonical 驱动会包一层）。
type FailureDetails struct {
	Detail  string
	Message string
}

// FailureError 是一次失败的输入面。字段与 Node errorLike 的可读部分对应。
type FailureError struct {
	Code    string
	Message string
	Detail  string
	Details *FailureDetails
}

// FailureOptions 是分类的附加输入。
type FailureOptions struct {
	// ExitCode 为 nil 表示 Node 侧 undefined（不参与兜底文案）。
	ExitCode *float64
}

// FailureClassification 是失败分类结论。
type FailureClassification struct {
	Code                string
	Message             string
	RetryAnotherAccount bool
}

// ClassifyNativeSessionFailure 把 CLI/上游失败签名归成稳定错误码与换账号建议。
//
// 顺序：provider 专属规则（gemini/cline/agy）→ 通用限流/额度墙 → 原始码兜底。
// 上游正文可能在 message，也可能被包进 detail/details，两者都要看。
func ClassifyNativeSessionFailure(provider string, failure *FailureError, options FailureOptions) FailureClassification {
	normalizedProvider := NormalizeProvider(provider)
	sourceCode := ""
	message := ""
	detailText := ""
	if failure != nil {
		sourceCode = normalizeString(failure.Code)
		message = failure.Message
		detailText = normalizeString(failure.Detail)
		if detailText == "" && failure.Details != nil {
			detailText = normalizeString(failure.Details.Detail)
			if detailText == "" {
				detailText = normalizeString(failure.Details.Message)
			}
		}
	}
	parts := make([]string, 0, 2)
	if message != "" {
		parts = append(parts, message)
	}
	if detailText != "" {
		parts = append(parts, detailText)
	}
	text := normalizeString(strings.Join(parts, " "))
	lowered := strings.ToLower(text)

	if rule := findFailureRule("turn", normalizedProvider, lowered); rule != nil {
		return FailureClassification{
			Code: rule.code, Message: rule.message, RetryAnotherAccount: rule.retryAnother,
		}
	}

	fallbackMessage := text
	if fallbackMessage == "" {
		if options.ExitCode != nil && !math.IsNaN(*options.ExitCode) && !math.IsInf(*options.ExitCode, 0) {
			fallbackMessage = "native_session_failed_exit_" + strconv.FormatFloat(*options.ExitCode, 'f', -1, 64)
		} else {
			fallbackMessage = "native_session_failed"
		}
	}
	code := sourceCode
	if code == "" {
		code = "native_session_failed"
	}
	return FailureClassification{Code: code, Message: fallbackMessage, RetryAnotherAccount: false}
}

// unauthorizedPattern 是 401 的认证语义旁证（避免把 14012 tokens 里的 401 误判）。
var unauthorizedPattern = regexp.MustCompile("unauthori[sz]ed|unauthenticated|authentication|incorrect api key|invalid[ _-]?(?:api[ _-]?key|token|credentials?)|token (?:has )?expired|expired[ _-]token")

// status401Pattern 匹配独立出现的 401 状态码。
var status401Pattern = regexp.MustCompile("\\b401\\b")

// AccountRuntimeBlocker 是终端输出推出的账号运行态阻塞。
type AccountRuntimeBlocker struct {
	Provider     string         `json:"provider"`
	Status       string         `json:"status"`
	Reason       string         `json:"reason"`
	Source       string         `json:"source"`
	RuntimeState map[string]any `json:"runtimeState"`
	Message      string         `json:"message"`
}

// truncateUTF16 按 JS String.prototype.slice 的语义截断（UTF-16 码元）。
func truncateUTF16(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	return string(utf16.Decode(units[:limit]))
}

// ClassifyNativeAccountRuntimeBlocker 从终端输出判定账号级阻塞（地区限制 / 凭据失效）。
//
// 只认确定性信号：401 必须带认证语义旁证；agy 的 "not signed in" 是冷启动横幅，
// 真正的失败信号是自动登录失败后回退到 "select login method"。
func ClassifyNativeAccountRuntimeBlocker(provider string, output string, nowMs int64) *AccountRuntimeBlocker {
	normalizedProvider := NormalizeProvider(provider)
	plain := strings.TrimSpace(strings.Join(strings.Fields(SanitizeTerminalText(output)), " "))
	if plain == "" {
		return nil
	}
	lowered := strings.ToLower(plain)

	if rule := findFailureRule("blocker", normalizedProvider, lowered); rule != nil {
		return &AccountRuntimeBlocker{
			Provider:     normalizedProvider,
			Status:       rule.status,
			Reason:       rule.reason,
			Source:       "native_session_terminal_output",
			RuntimeState: buildPermissionDeniedRuntimeState(rule.reason, nowMs),
			Message:      truncateUTF16(plain, 512),
		}
	}

	looksUnauthorized := status401Pattern.MatchString(lowered) && unauthorizedPattern.MatchString(lowered)
	looksAPIKeyInvalid := strings.Contains(lowered, "incorrect api key") ||
		strings.Contains(lowered, "invalid api key") ||
		strings.Contains(lowered, "invalid_api_key") ||
		strings.Contains(lowered, "api key provided")
	// 不认 aih 自己的 auth_invalid_reauth_required：那是网关整池不可调度的信封码，
	// 与本账号凭据无关。
	looksRefreshInvalid := strings.Contains(lowered, "token_expired") ||
		strings.Contains(lowered, "invalid_grant") ||
		strings.Contains(lowered, "your session has expired") ||
		strings.Contains(lowered, "re-authentication required") ||
		strings.Contains(lowered, "provided authentication token is expired") ||
		strings.Contains(lowered, "access token could not be refreshed") ||
		(strings.Contains(lowered, "refresh token") &&
			(strings.Contains(lowered, "expired") ||
				strings.Contains(lowered, "invalid") ||
				strings.Contains(lowered, "reused")))
	looksClaudeLoginMissing := normalizedProvider == "claude" &&
		(strings.Contains(lowered, "authentication_failed") ||
			(strings.Contains(lowered, "not logged in") && strings.Contains(lowered, "/login")) ||
			strings.Contains(lowered, "please run /login"))
	looksAgyLoginMissing := normalizedProvider == "agy" &&
		strings.Contains(lowered, "select login method") &&
		strings.Contains(lowered, "google oauth")

	if !looksAPIKeyInvalid && !looksUnauthorized && !looksRefreshInvalid &&
		!looksClaudeLoginMissing && !looksAgyLoginMissing {
		return nil
	}

	reason := "auth_invalid_reauth_required"
	switch {
	case looksAPIKeyInvalid || looksUnauthorized:
		reason = "upstream_401"
	case looksClaudeLoginMissing:
		reason = "claude_not_logged_in"
	case looksAgyLoginMissing:
		reason = "agy_not_signed_in"
	}
	return &AccountRuntimeBlocker{
		Provider:     normalizedProvider,
		Status:       "auth_invalid",
		Reason:       reason,
		Source:       "native_session_terminal_output",
		RuntimeState: buildAuthInvalidRuntimeState(reason, nowMs),
		Message:      truncateUTF16(plain, 512),
	}
}

// emptyRuntimeStateBase 是账号运行态的基础字段（与 Node 同字段同默认值）。
func emptyRuntimeStateBase(reason string, nowMs int64) map[string]any {
	return map[string]any{
		"cooldownUntil":           int64(0),
		"consecutiveFailures":     int64(1),
		"successCount":            int64(0),
		"failCount":               int64(1),
		"lastError":               reason,
		"lastFailureKind":         "",
		"lastFailureReason":       reason,
		"lastFailureAt":           nowMs,
		"lastSuccessAt":           int64(0),
		"rateLimitUntil":          int64(0),
		"authInvalidUntil":        int64(0),
		"overloadUntil":           int64(0),
		"networkUntil":            int64(0),
		"serviceUnavailableUntil": int64(0),
		"upstreamErrorUntil":      int64(0),
	}
}

// buildAuthInvalidRuntimeState 构造凭据失效的账号运行态。
func buildAuthInvalidRuntimeState(reason string, nowMs int64) map[string]any {
	message := normalizeString(reason)
	if message == "" {
		message = "auth_invalid_reauth_required"
	}
	until := nowMs + accountGuessedCooldownMs
	state := emptyRuntimeStateBase(message, nowMs)
	state["cooldownUntil"] = until
	state["lastFailureKind"] = "auth_invalid"
	state["authInvalidUntil"] = until
	return state
}

// BuildAuthInvalidRuntimeState 供上层直接构造凭据失效运行态（测试与降级装配用）。
func BuildAuthInvalidRuntimeState(reason string, nowMs int64) map[string]any {
	return buildAuthInvalidRuntimeState(reason, nowMs)
}

// buildPermissionDeniedRuntimeState 构造上游明确拒绝（地区/资格/权限）的账号运行态。
func buildPermissionDeniedRuntimeState(reason string, nowMs int64) map[string]any {
	message := normalizeString(reason)
	if message == "" {
		message = "permission_denied"
	}
	state := emptyRuntimeStateBase(message, nowMs)
	state["lastFailureKind"] = "permission_denied"
	state["routingBlock"] = map[string]any{
		"kind":       "permission_denied",
		"reason":     message,
		"observedAt": nowMs,
		"until":      nowMs + accountGuessedCooldownMs,
	}
	return state
}

// runtimeAuthTokenPattern 把账号认证模式归一化成稳定 token。
func normalizeRuntimeAuthMode(value string) string {
	raw := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "_", "-")
	switch raw {
	case "api-key", "apikey":
		return "api-key"
	case "auth-token", "authtoken", "claude-code-token":
		return "auth-token"
	case "oauth", "oauth-browser", "oauth-device":
		return raw
	default:
		return ""
	}
}

// IsAPICredentialAuthMode 判断该认证模式是否属于 API 密钥/令牌（可换号的凭据）。
func IsAPICredentialAuthMode(authMode string) bool {
	normalized := normalizeRuntimeAuthMode(authMode)
	return normalized == "api-key" || normalized == "auth-token"
}

// BuildNativeAccountRuntimeBaseState 构造账号运行态事件的基础字段。
//
// 与 Node 一致：写入的 authMode 只做小写，不做连字符归一（原始值原样可见）；
// apiKeyMode 则按归一化后的模式判断。
func BuildNativeAccountRuntimeBaseState(authMode string) map[string]any {
	state := map[string]any{"configured": true}
	raw := strings.ToLower(strings.TrimSpace(authMode))
	if raw != "" {
		state["authMode"] = raw
		state["apiKeyMode"] = IsAPICredentialAuthMode(raw)
	}
	return state
}

// ShouldScanNativeRuntimeBlockerOutput 判断本轮输出是否值得做账号阻塞扫描。
//
// 交互式轮与显式错误总是扫描；非交互轮只在非零退出时扫描（正常输出里
// 通常不会出现真实失败签名，扫描会带来误判风险）。
func ShouldScanNativeRuntimeBlockerOutput(interactiveCLI bool, explicitError bool, exitCode *float64) bool {
	if interactiveCLI {
		return true
	}
	if explicitError {
		return true
	}
	return exitCode != nil && *exitCode != 0
}
