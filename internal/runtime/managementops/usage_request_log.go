package managementops

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const requestContextKind = "model_usage_request_context"

var (
	leadingMethodRe        = regexp.MustCompile(`^[A-Z]+\s+`)
	safeDiagnosticCodeRe   = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9_.:-]{0,95}$`)
	urlCredentialRe        = regexp.MustCompile(`(?i)(https?://)[^\s/:@]+:[^\s/@]+@`)
	quotedSecretAssignRe   = regexp.MustCompile(`(?i)((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|management[_-]?key|private[_-]?key|secret[_-]?key|token|secret|credential|password)(?:["']?)\s*[:=]\s*)(?:"[^\r\n"]*"|'[^\r\n']*')`)
	secretAssignRe         = regexp.MustCompile(`(?i)(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|x[_-]?api[_-]?key|management[_-]?key|private[_-]?key|secret[_-]?key|token|secret|credential|password)\b\s*[:=]\s*)[^\s,;&}\])]+`)
	authorizationHeaderRe  = regexp.MustCompile(`(?i)(\b(?:proxy[-_ ]?)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;)}\]]+`)
	cookieHeaderRe         = regexp.MustCompile(`(?i)(\b(?:set[-_ ]?cookie|cookie)s?\s*[:=]\s*)[^\r\n]*`)
	bearerTokenRe          = regexp.MustCompile(`(?i)\b(bearer)\s+[^\s,;)}\]]+`)
	basicTokenRe           = regexp.MustCompile(`(?i)\b(basic)\s+[^\s,;)}\]]+`)
	jwtLabelRe             = regexp.MustCompile(`(?i)(\bjwt\s+)[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+`)
	jwtTokenRe             = regexp.MustCompile(`(?i)\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b`)
	providerAPIKeyRe       = regexp.MustCompile(`(?i)\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{8,}|AIza[a-z0-9_-]{16,})\b`)
	controlCharsRe         = regexp.MustCompile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+")
	whitespaceCollapseRe   = regexp.MustCompile(`\s+`)
)

type requestLogRecord struct {
	RequestID       string
	Provider        string
	Model           string
	ReasoningEffort string
	Endpoint        string
	ClientIP        string
	RequestType     string
	DurationMS      int64
	TimestampMS     int64
	StatusCode      int
	ErrorCode       string
	ErrorMessage    string
}

type requestLogEntry struct {
	At              string  `json:"at"`
	Kind            string  `json:"kind"`
	RequestID       string  `json:"requestId"`
	Provider        string  `json:"provider"`
	Model           string  `json:"model"`
	EffectiveModel  string  `json:"effectiveModel"`
	RequestedModel  string  `json:"requestedModel"`
	ReasoningEffort string  `json:"reasoningEffort"`
	Endpoint        string  `json:"endpoint"`
	Path            string  `json:"path"`
	Route           string  `json:"route"`
	ClientIP        string  `json:"clientIp"`
	RequestType     string  `json:"requestType"`
	StreamRequested *bool   `json:"streamRequested"`
	StreamTransport string  `json:"streamTransport"`
	Method          string  `json:"method"`
	DurationMS      *float64 `json:"durationMs"`
	Status          float64 `json:"status"`
	PolicyKind      string  `json:"policyKind"`
	FailureReason   string  `json:"failureReason"`
	Error           string  `json:"error"`
	UpstreamBody    string  `json:"upstreamBody"`
	UpstreamError   string  `json:"upstreamError"`
	Detail          string  `json:"detail"`
}

type requestLogReader struct {
	logFile string

	mu            sync.Mutex
	cachedSig     string
	cachedRecords map[string]*requestLogRecord
}

func newRequestLogReader(logFile string) *requestLogReader {
	return &requestLogReader{
		logFile:       strings.TrimSpace(logFile),
		cachedRecords: make(map[string]*requestLogRecord),
	}
}

func (r *requestLogReader) read() map[string]*requestLogRecord {
	if r == nil || r.logFile == "" {
		return map[string]*requestLogRecord{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	stat, err := os.Stat(r.logFile)
	if err != nil {
		r.cachedSig = ""
		r.cachedRecords = make(map[string]*requestLogRecord)
		return r.cachedRecords
	}
	sig := fmt.Sprintf("%d:%d", stat.Size(), stat.ModTime().UnixNano())
	if sig == r.cachedSig && r.cachedRecords != nil {
		return r.cachedRecords
	}
	f, err := os.Open(r.logFile)
	if err != nil {
		r.cachedSig = ""
		r.cachedRecords = make(map[string]*requestLogRecord)
		return r.cachedRecords
	}
	defer func() { _ = f.Close() }()

	records := projectRequestLogScanner(bufio.NewScanner(f))
	r.cachedRecords = records
	r.cachedSig = sig
	return r.cachedRecords
}

func projectRequestLogScanner(scanner *bufio.Scanner) map[string]*requestLogRecord {
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	records := make(map[string]*requestLogRecord)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry requestLogEntry
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		reqID := clipText(entry.RequestID, 160)
		if reqID == "" {
			continue
		}
		endpoint := normalizeLogEndpoint(firstNonEmpty(entry.Endpoint, entry.Path, entry.Route))
		existing, hasExisting := records[reqID]
		if !hasExisting && endpoint != "" && !isGatewayEndpoint(endpoint) && entry.Kind != requestContextKind {
			continue
		}
		if !hasExisting {
			existing = &requestLogRecord{RequestID: reqID}
			records[reqID] = existing
		}
		mergeLogEntry(existing, &entry, endpoint)
	}
	return records
}

func mergeLogEntry(rec *requestLogRecord, entry *requestLogEntry, endpoint string) {
	if prov := clipText(entry.Provider, 32); prov != "" {
		rec.Provider = strings.ToLower(prov)
	}
	if model := clipText(firstNonEmpty(entry.EffectiveModel, entry.RequestedModel, entry.Model), 256); model != "" {
		rec.Model = model
	}
	if eff := clipText(entry.ReasoningEffort, 32); eff != "" {
		rec.ReasoningEffort = eff
	}
	if endpoint != "" {
		rec.Endpoint = endpoint
	}
	if ip := clipText(entry.ClientIP, 128); ip != "" {
		rec.ClientIP = ip
	}
	if reqType := requestTypeFromLogEntry(entry); reqType != "" {
		rec.RequestType = reqType
	}
	if entry.DurationMS != nil && !math.IsNaN(*entry.DurationMS) && !math.IsInf(*entry.DurationMS, 0) {
		dur := *entry.DurationMS
		if dur < 0 {
			dur = 0
		}
		rec.DurationMS = int64(math.Round(dur))
	}
	if ts := parseISOTimeMS(entry.At); ts > rec.TimestampMS {
		rec.TimestampMS = ts
	}
	statusCode := 0
	if !math.IsNaN(entry.Status) && !math.IsInf(entry.Status, 0) && entry.Status > 0 {
		statusCode = int(math.Round(entry.Status))
		rec.StatusCode = statusCode
	}
	if statusCode >= 400 || entry.Kind == "account_retry_failure" || entry.Kind == "request_safety_rejected" {
		if entry.PolicyKind != "" || entry.FailureReason != "" || entry.Error != "" || rec.ErrorCode == "" {
			effectiveStatus := statusCode
			if effectiveStatus == 0 {
				effectiveStatus = rec.StatusCode
			}
			rec.ErrorCode = errorCodeFromLogEntry(entry, effectiveStatus)
		}
		if msg := errorMessageFromLogEntry(entry); msg != "" {
			rec.ErrorMessage = msg
		}
	}
}

func clipText(value string, maxLen int) string {
	trimmed := strings.TrimSpace(value)
	if maxLen > 0 && len(trimmed) > maxLen {
		return trimmed[:maxLen]
	}
	return trimmed
}

func normalizeLogEndpoint(value string) string {
	clipped := clipText(value, 512)
	return leadingMethodRe.ReplaceAllString(clipped, "")
}

func isGatewayEndpoint(endpoint string) bool {
	ep := normalizeLogEndpoint(endpoint)
	return ep == "/v1" || strings.HasPrefix(ep, "/v1/") || strings.HasPrefix(ep, "/v1beta/") || strings.HasPrefix(ep, "/anthropic/")
}

func requestTypeFromLogEntry(entry *requestLogEntry) string {
	explicit := strings.ToLower(clipText(entry.RequestType, 16))
	if explicit == "stream" || explicit == "sync" {
		return explicit
	}
	if entry.StreamRequested != nil {
		if *entry.StreamRequested {
			return "stream"
		}
		return "sync"
	}
	if clipText(entry.StreamTransport, 64) != "" {
		return "stream"
	}
	method := strings.ToUpper(clipText(entry.Method, 16))
	if method == "GET" || method == "HEAD" {
		return "sync"
	}
	return ""
}

func errorCodeFromLogEntry(entry *requestLogEntry, statusCode int) string {
	fallback := "request_failed"
	if statusCode > 0 {
		fallback = fmt.Sprintf("http_%d", statusCode)
	}
	candidate := clipText(firstNonEmpty(entry.PolicyKind, entry.FailureReason, entry.Error), 96)
	if candidate == "" {
		return fallback
	}
	if sanitizeDiagnosticText(candidate, 96) != candidate {
		return fallback
	}
	if safeDiagnosticCodeRe.MatchString(candidate) {
		return candidate
	}
	return fallback
}

func errorMessageFromLogEntry(entry *requestLogEntry) string {
	raw := firstNonEmpty(entry.UpstreamBody, entry.UpstreamError, entry.Detail, entry.Error)
	return sanitizeDiagnosticText(raw, 320)
}

func sanitizeDiagnosticText(raw string, maxLen int) string {
	if maxLen <= 0 {
		maxLen = 512
	}
	s := urlCredentialRe.ReplaceAllString(raw, "${1}[redacted]@")
	s = quotedSecretAssignRe.ReplaceAllString(s, "${1}\"[redacted]\"")
	s = authorizationHeaderRe.ReplaceAllString(s, "${1}[redacted]")
	s = cookieHeaderRe.ReplaceAllString(s, "${1}[redacted]")
	s = secretAssignRe.ReplaceAllStringFunc(s, func(match string) string {
		if strings.Contains(match, "[redacted]") {
			return match
		}
		idx := strings.IndexAny(match, ":=")
		if idx < 0 {
			return "[redacted]"
		}
		prefix := match[:idx+1]
		rest := match[idx+1:]
		spaces := len(rest) - len(strings.TrimLeft(rest, " \t"))
		return prefix + rest[:spaces] + "[redacted]"
	})
	s = bearerTokenRe.ReplaceAllStringFunc(s, func(match string) string {
		if strings.Contains(match, "[redacted]") {
			return match
		}
		fields := strings.Fields(match)
		if len(fields) > 0 {
			return fields[0] + " [redacted]"
		}
		return "[redacted]"
	})
	s = basicTokenRe.ReplaceAllStringFunc(s, func(match string) string {
		if strings.Contains(match, "[redacted]") {
			return match
		}
		fields := strings.Fields(match)
		if len(fields) > 0 {
			return fields[0] + " [redacted]"
		}
		return "[redacted]"
	})
	s = jwtLabelRe.ReplaceAllString(s, "${1}[jwt-redacted]")
	s = jwtTokenRe.ReplaceAllString(s, "[jwt-redacted]")
	s = providerAPIKeyRe.ReplaceAllString(s, "[redacted]")
	s = controlCharsRe.ReplaceAllString(s, " ")
	s = whitespaceCollapseRe.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}

func parseISOTimeMS(raw string) int64 {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0
	}
	layouts := []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05"}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, trimmed); err == nil {
			ms := t.UnixMilli()
			if ms > 0 {
				return ms
			}
		}
	}
	return 0
}

// QueryRequestDetails 查询成功请求用量与日志失败请求明细。
func (s *UsageStore) QueryRequestDetails(ctx context.Context, query UsageQuery) (UsageRequestDetailsPayload, error) {
	if s == nil || s.db == nil {
		return UsageRequestDetailsPayload{}, ErrUsageUnavailable
	}
	normalized := normalizeUsageQueryBounds(query)
	clauses := []string{
		"request_id != ''",
		"source_kind GLOB 'server_*'",
		"timestamp_ms BETWEEN ? AND ?",
	}
	args := []any{normalized.FromMS, normalized.ToMS}
	if normalized.Provider != "" {
		clauses = append(clauses, "provider = ?")
		args = append(args, normalized.Provider)
	}
	if normalized.Model != "" {
		clauses = append(clauses, "model = ?")
		args = append(args, normalized.Model)
	}
	args = append(args, normalized.Limit)

	sqlText := fmt.Sprintf(`
		SELECT
			request_id, provider, model,
			input_tokens, output_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, reasoning_output_tokens,
			total_tokens, cost_usd, timestamp_ms
		FROM (
			SELECT
				id, request_id, provider, model,
				input_tokens, output_tokens, cache_read_input_tokens,
				cache_creation_input_tokens, reasoning_output_tokens,
				total_tokens, cost_usd, timestamp_ms,
				ROW_NUMBER() OVER (
					PARTITION BY request_id
					ORDER BY timestamp_ms DESC, id DESC
				) AS request_rank
			FROM model_usage_records
			WHERE %s
		) AS ranked_request_usage
		WHERE request_rank = 1
		ORDER BY timestamp_ms DESC, id DESC
		LIMIT ?`, strings.Join(clauses, " AND "))

	rows, err := s.db.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return UsageRequestDetailsPayload{}, fmt.Errorf("查询请求用量明细失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	logRecords := s.reqReader.read()
	usage := make([]UsageRequestRow, 0)
	for rows.Next() {
		var (
			reqID, prov, model                              string
			inTok, outTok, cacheRead, cacheCreate, reason   int64
			totalTok, tsMS                                  int64
			costUSD                                         float64
		)
		if scanErr := rows.Scan(
			&reqID, &prov, &model,
			&inTok, &outTok, &cacheRead, &cacheCreate, &reason,
			&totalTok, &costUSD, &tsMS,
		); scanErr != nil {
			return UsageRequestDetailsPayload{}, fmt.Errorf("扫描请求用量明细行失败: %w", scanErr)
		}
		telemetry := logRecords[reqID]
		item := UsageRequestRow{
			RequestID:                reqID,
			Provider:                 prov,
			Model:                    model,
			BillingMode:              "token",
			InputTokens:              inTok,
			OutputTokens:             outTok,
			CacheReadInputTokens:     cacheRead,
			CacheCreationInputTokens: cacheCreate,
			ReasoningOutputTokens:    reason,
			TotalTokens:              totalTok,
			CostUSD:                  NormalizeUsageCostUSD(costUSD),
			TimestampMS:              tsMS,
			StatusCode:               200,
		}
		if telemetry != nil {
			if item.Provider == "" {
				item.Provider = telemetry.Provider
			}
			if item.Model == "" {
				item.Model = telemetry.Model
			}
			item.ReasoningEffort = telemetry.ReasoningEffort
			item.Endpoint = telemetry.Endpoint
			item.ClientIP = telemetry.ClientIP
			item.RequestType = telemetry.RequestType
			item.DurationMS = telemetry.DurationMS
			if item.TimestampMS == 0 {
				item.TimestampMS = telemetry.TimestampMS
			}
			if telemetry.StatusCode != 0 {
				item.StatusCode = telemetry.StatusCode
			}
		}
		usage = append(usage, item)
	}
	if err := rows.Err(); err != nil {
		return UsageRequestDetailsPayload{}, err
	}

	errRows := make([]*requestLogRecord, 0)
	for _, rec := range logRecords {
		if rec.StatusCode < 400 || !isGatewayEndpoint(rec.Endpoint) {
			continue
		}
		if rec.TimestampMS < normalized.FromMS || rec.TimestampMS > normalized.ToMS {
			continue
		}
		if normalized.Provider != "" && rec.Provider != normalized.Provider {
			continue
		}
		if normalized.Model != "" && rec.Model != normalized.Model {
			continue
		}
		errRows = append(errRows, rec)
	}
	sort.Slice(errRows, func(i, j int) bool {
		if errRows[i].TimestampMS != errRows[j].TimestampMS {
			return errRows[i].TimestampMS > errRows[j].TimestampMS
		}
		return errRows[i].RequestID < errRows[j].RequestID
	})
	if len(errRows) > normalized.Limit {
		errRows = errRows[:normalized.Limit]
	}
	errsOut := make([]UsageRequestRow, 0, len(errRows))
	for _, rec := range errRows {
		errCode := rec.ErrorCode
		if errCode == "" {
			errCode = errorCodeFromLogEntry(&requestLogEntry{}, rec.StatusCode)
		}
		errMsg := rec.ErrorMessage
		if errMsg == "" {
			errMsg = fmt.Sprintf("HTTP %d", rec.StatusCode)
		}
		errsOut = append(errsOut, UsageRequestRow{
			RequestID:       rec.RequestID,
			Provider:        rec.Provider,
			Model:           rec.Model,
			ReasoningEffort: rec.ReasoningEffort,
			Endpoint:        rec.Endpoint,
			ClientIP:        rec.ClientIP,
			RequestType:     rec.RequestType,
			BillingMode:     "",
			DurationMS:      rec.DurationMS,
			TimestampMS:     rec.TimestampMS,
			StatusCode:      rec.StatusCode,
			ErrorCode:       errCode,
			ErrorMessage:    errMsg,
		})
	}
	return UsageRequestDetailsPayload{
		Usage:  usage,
		Errors: errsOut,
	}, nil
}

func normalizeUsageQueryBounds(q UsageQuery) UsageQuery {
	out := q
	out.Provider = strings.ToLower(strings.TrimSpace(q.Provider))
	out.Model = strings.TrimSpace(q.Model)
	out.SessionID = strings.TrimSpace(q.SessionID)
	if out.Limit <= 0 {
		out.Limit = DefaultUsageQueryLimit
	}
	if out.Limit > MaxUsageQueryLimit {
		out.Limit = MaxUsageQueryLimit
	}
	if out.ToMS <= 0 {
		out.ToMS = time.Now().UnixMilli()
	}
	if out.FromMS < 0 {
		out.FromMS = 0
	}
	return out
}
