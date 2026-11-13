package chatruntime

import (
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
)

const (
	redactedValue    = "[redacted]"
	jwtRedactedValue = "[jwt-redacted]"

	defaultDiagnosticMessageMaxLen = 512
	defaultDiagnosticDetailDepth   = 5
	defaultDiagnosticDetailEntries = 40
)

var (
	safeDiagnosticCodeRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$`)
	sensitiveDetailKeyRe  = regexp.MustCompile(`(?i)(^|[-_.])(authorization|cookie|cookies|credential|credentials|key|keys|password|secret|secrets|token|tokens)($|[-_.])`)
	camelSplitRe          = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	urlCredentialRe       = regexp.MustCompile(`(?i)(https?://)[^\s/:@]+:[^\s/@]+@`)
	doubleQuotedSecretRe  = regexp.MustCompile(`(?i)((?:["\x27])?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|management[_-]?key|private[_-]?key|secret[_-]?key|token|secret|credential|password)(?:["\x27])?\s*[:=]\s*)"[^\r\n"]*"`)
	singleQuotedSecretRe  = regexp.MustCompile(`(?i)((?:["\x27])?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|management[_-]?key|private[_-]?key|secret[_-]?key|token|secret|credential|password)(?:["\x27])?\s*[:=]\s*)\x27[^\r\n\x27]*\x27`)
	authorizationAssignRe = regexp.MustCompile(`(?i)(\b(?:proxy[-_ ]?)?authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s,;)}\]]+`)
	cookieAssignRe        = regexp.MustCompile(`(?i)(\b(?:set[-_ ]?cookie|cookie)s?\s*[:=]\s*)[^\r\n]*`)
	secretAssignRe        = regexp.MustCompile(`(?i)(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|management[_-]?key|private[_-]?key|secret[_-]?key|token|secret|credential|password)\b\s*[:=]\s*)[^\s,;&}\])]+`)
	bearerRe              = regexp.MustCompile(`(?i)\b(bearer)\s+[^\s,;)}\]]+`)
	basicRe               = regexp.MustCompile(`(?i)\b(basic)\s+[^\s,;)}\]]+`)
	jwtLabelRe            = regexp.MustCompile(`(?i)(\bjwt\s+)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
	jwtTokenRe            = regexp.MustCompile(`(?i)\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	providerKeyRe         = regexp.MustCompile(`(?i)\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{16,})\b`)
	controlCharsRe        = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+`)
	whitespaceRe          = regexp.MustCompile(`\s+`)
)

// CanonicalDiagnostic 描述脱敏后的可持久化/可返回错误诊断。
type CanonicalDiagnostic struct {
	Code       string         `json:"code"`
	Message    string         `json:"message"`
	StatusCode int            `json:"statusCode,omitempty"`
	Details    map[string]any `json:"details,omitempty"`
}

// DiagnosticOptions 控制错误诊断脱敏参数。
type DiagnosticOptions struct {
	FallbackCode      string
	FallbackMessage   string
	MaxMessageLength  int
	IncludeStatusCode bool
	DefaultStatusCode int
	IncludeDetails    bool
	MaxDetailDepth    int
	MaxDetailEntries  int
	MaxDetailTextLen  int
}

// SanitizeDiagnosticText 对错误文本脱敏并截断。
func SanitizeDiagnosticText(value string, maxLength int) string {
	limit := maxLength
	if limit <= 0 {
		limit = defaultDiagnosticMessageMaxLen
	}
	s := urlCredentialRe.ReplaceAllString(value, "${1}[redacted]@")
	s = doubleQuotedSecretRe.ReplaceAllString(s, `${1}"`+redactedValue+`"`)
	s = singleQuotedSecretRe.ReplaceAllString(s, "${1}\x27"+redactedValue+"\x27")
	s = authorizationAssignRe.ReplaceAllStringFunc(s, func(match string) string {
		parts := authorizationAssignRe.FindStringSubmatch(match)
		if len(parts) >= 3 && parts[2] != "" {
			return parts[1] + parts[2] + " " + redactedValue
		}
		if len(parts) >= 2 {
			return parts[1] + redactedValue
		}
		return redactedValue
	})
	s = cookieAssignRe.ReplaceAllString(s, "${1}"+redactedValue)
	s = secretAssignRe.ReplaceAllStringFunc(s, func(match string) string {
		parts := secretAssignRe.FindStringSubmatch(match)
		if len(parts) >= 2 && !strings.HasPrefix(strings.TrimPrefix(match, parts[1]), redactedValue) {
			return parts[1] + redactedValue
		}
		return match
	})
	s = bearerRe.ReplaceAllStringFunc(s, func(match string) string {
		parts := bearerRe.FindStringSubmatch(match)
		if len(parts) >= 2 {
			rest := strings.TrimSpace(match[len(parts[1]):])
			if strings.HasPrefix(rest, redactedValue) {
				return match
			}
			return parts[1] + " " + redactedValue
		}
		return match
	})
	s = basicRe.ReplaceAllStringFunc(s, func(match string) string {
		parts := basicRe.FindStringSubmatch(match)
		if len(parts) >= 2 {
			rest := strings.TrimSpace(match[len(parts[1]):])
			if strings.HasPrefix(rest, redactedValue) {
				return match
			}
			return parts[1] + " " + redactedValue
		}
		return match
	})
	s = jwtLabelRe.ReplaceAllString(s, "${1}"+jwtRedactedValue)
	s = jwtTokenRe.ReplaceAllString(s, jwtRedactedValue)
	s = providerKeyRe.ReplaceAllString(s, redactedValue)
	s = controlCharsRe.ReplaceAllString(s, " ")
	s = whitespaceRe.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	if limit <= 3 {
		return string(runes[:limit])
	}
	return string(runes[:limit-3]) + "..."
}

// SanitizeDiagnosticCode 校验并返回安全的错误码。
func SanitizeDiagnosticCode(value string, fallback string) string {
	code := strings.TrimSpace(value)
	if safeDiagnosticCodeRe.MatchString(code) {
		return code
	}
	safeFallback := strings.TrimSpace(fallback)
	if safeDiagnosticCodeRe.MatchString(safeFallback) {
		return safeFallback
	}
	return "chat_runtime_failed"
}

// SanitizeDiagnosticDetails 递归脱敏结构化诊断详情。
func SanitizeDiagnosticDetails(value any, options DiagnosticOptions) any {
	depth := options.MaxDetailDepth
	if depth <= 0 {
		depth = defaultDiagnosticDetailDepth
	}
	entries := options.MaxDetailEntries
	if entries <= 0 {
		entries = defaultDiagnosticDetailEntries
	}
	textLen := options.MaxDetailTextLen
	if textLen <= 0 {
		textLen = defaultDiagnosticMessageMaxLen
	}
	return projectDiagnosticValue(value, depth, entries, textLen, 0)
}

func projectDiagnosticValue(value any, maxDepth, maxEntries, maxTextLen, depth int) any {
	if value == nil {
		return nil
	}
	switch v := value.(type) {
	case bool:
		return v
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return v
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Sprint(v)
		}
		return v
	case float32:
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return fmt.Sprint(v)
		}
		return v
	case string:
		return SanitizeDiagnosticText(v, maxTextLen)
	case []string:
		if depth >= maxDepth {
			return "[truncated]"
		}
		limit := min(len(v), maxEntries)
		out := make([]any, 0, limit)
		for i := 0; i < limit; i++ {
			out = append(out, SanitizeDiagnosticText(v[i], maxTextLen))
		}
		return out
	case []any:
		if depth >= maxDepth {
			return "[truncated]"
		}
		limit := min(len(v), maxEntries)
		out := make([]any, 0, limit)
		for i := 0; i < limit; i++ {
			out = append(out, projectDiagnosticValue(v[i], maxDepth, maxEntries, maxTextLen, depth+1))
		}
		return out
	case map[string]any:
		if depth >= maxDepth {
			return "[truncated]"
		}
		keys := sortedMapKeys(v)
		if len(keys) > maxEntries {
			keys = keys[:maxEntries]
		}
		out := make(map[string]any, len(keys))
		for _, k := range keys {
			normalizedKey := strings.ToLower(camelSplitRe.ReplaceAllString(k, "$1-$2"))
			if sensitiveDetailKeyRe.MatchString(normalizedKey) {
				out[k] = redactedValue
				continue
			}
			out[k] = projectDiagnosticValue(v[k], maxDepth, maxEntries, maxTextLen, depth+1)
		}
		return out
	default:
		return SanitizeDiagnosticText(fmt.Sprint(v), maxTextLen)
	}
}

// SanitizeCanonicalDiagnostic 从 Go error 或诊断 map 生成脱敏的 CanonicalDiagnostic。
func SanitizeCanonicalDiagnostic(errOrRecord any, options DiagnosticOptions) CanonicalDiagnostic {
	fallbackCode := SanitizeDiagnosticCode(options.FallbackCode, "chat_runtime_failed")
	var rawCode, rawMessage string
	var statusCode int
	var details map[string]any

	switch v := errOrRecord.(type) {
	case *Error:
		if v != nil {
			rawCode = v.Code
			rawMessage = v.Message
			statusCode = v.StatusCode
			details = v.Details
		}
	case error:
		if v != nil {
			if re, ok := AsRuntimeError(v); ok {
				rawCode = re.Code
				rawMessage = re.Message
				statusCode = re.StatusCode
				details = re.Details
			} else {
				rawMessage = v.Error()
			}
		}
	case map[string]any:
		if s, ok := v["code"].(string); ok {
			rawCode = s
		} else if s, ok := v["error"].(string); ok {
			rawCode = s
		}
		if s, ok := v["message"].(string); ok {
			rawMessage = s
		}
		if n, ok := asInt(v["statusCode"]); ok {
			statusCode = n
		}
		if d, ok := v["details"].(map[string]any); ok {
			details = d
		}
	case CanonicalDiagnostic:
		rawCode = v.Code
		rawMessage = v.Message
		statusCode = v.StatusCode
		details = v.Details
	case *CanonicalDiagnostic:
		if v != nil {
			rawCode = v.Code
			rawMessage = v.Message
			statusCode = v.StatusCode
			details = v.Details
		}
	case string:
		rawMessage = v
	}

	code := SanitizeDiagnosticCode(rawCode, fallbackCode)
	fallbackMessage := options.FallbackMessage
	if fallbackMessage == "" {
		fallbackMessage = code
	}
	if strings.TrimSpace(rawMessage) == "" {
		rawMessage = fallbackMessage
	}
	message := SanitizeDiagnosticText(rawMessage, options.MaxMessageLength)
	if message == "" {
		message = fallbackCode
	}

	out := CanonicalDiagnostic{
		Code:    code,
		Message: message,
	}
	if options.IncludeStatusCode {
		defaultCode := options.DefaultStatusCode
		if defaultCode < 400 || defaultCode > 599 {
			defaultCode = http.StatusInternalServerError
		}
		if statusCode >= 400 && statusCode <= 599 {
			out.StatusCode = statusCode
		} else {
			out.StatusCode = defaultCode
		}
	}
	if options.IncludeDetails && details != nil {
		if sanitized, ok := SanitizeDiagnosticDetails(details, options).(map[string]any); ok {
			out.Details = sanitized
		}
	}
	return out
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n {
			return 0, false
		}
		return int(n), true
	default:
		return 0, false
	}
}
