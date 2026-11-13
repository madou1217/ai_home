package codexappserverapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// DefaultRemoteControlOrigin 是 ChatGPT remote-control 官方上游地址。
	DefaultRemoteControlOrigin = "https://chatgpt.com"
	// DefaultRemoteControlBasePath 是默认转发路径前缀。
	DefaultRemoteControlBasePath = "/backend-api"
	// MaxRemoteHTTPBodyBytes 限制 HTTP 转发请求与响应体最大字节数。
	MaxRemoteHTTPBodyBytes = 64 * 1024 * 1024
	// MaxRemoteThreadSummaryItems 限制 trace 中记录的 thread/list 结果条数。
	MaxRemoteThreadSummaryItems = 10
	// MaxChunkAssemblyBytes 限制单条分片重组消息大小。
	MaxChunkAssemblyBytes = 4 * 1024 * 1024
)

var (
	reBearerSecret = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._~+/=-]+`)
	reJSONSecret   = regexp.MustCompile(`(?i)"((?:access|refresh|id)_token|authToken|token)"\s*:\s*"[^"]+"`)
	reJWTSecret    = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)

	remoteHydrationNotificationMethods = map[string]struct{}{
		"thread/started":            {},
		"thread/status/changed":     {},
		"thread/tokenUsage/updated": {},
	}
	hopByHopHeaders = map[string]struct{}{
		"connection":          {},
		"content-length":      {},
		"host":                {},
		"keep-alive":          {},
		"proxy-authenticate":  {},
		"proxy-authorization": {},
		"te":                  {},
		"trailer":             {},
		"transfer-encoding":   {},
		"upgrade":             {},
	}
	wsHandshakeHeaders = map[string]struct{}{
		"sec-websocket-accept":     {},
		"sec-websocket-extensions": {},
		"sec-websocket-key":        {},
		"sec-websocket-protocol":   {},
		"sec-websocket-version":    {},
	}
)

// SanitizeTraceText 对 trace 文本中的 Bearer、JWT 与常见 token 字段做脱敏并限制长度。
func SanitizeTraceText(value string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 4000
	}
	text := reBearerSecret.ReplaceAllString(value, "Bearer [redacted]")
	text = reJSONSecret.ReplaceAllString(text, `"$1":"[redacted]"`)
	text = reJWTSecret.ReplaceAllString(text, "[jwt-redacted]")
	if len(text) <= maxLength {
		return text
	}
	return text[:maxLength] + "..."
}

func compactThreadListItem(raw any) map[string]any {
	item, ok := raw.(map[string]any)
	if !ok || item == nil {
		return nil
	}
	id := firstNonEmptyString(item, "id", "sessionId", "threadId")
	if id == "" {
		return nil
	}
	out := map[string]any{"id": id}
	if updated := firstNonNil(item, "updatedAt", "updated_at", "updated_at_ms"); updated != nil && updated != "" {
		out["updatedAt"] = updated
	}
	if created := firstNonNil(item, "createdAt", "created_at", "created_at_ms"); created != nil && created != "" {
		out["createdAt"] = created
	}
	if mp := firstNonEmptyString(item, "modelProvider", "model_provider"); mp != "" {
		out["modelProvider"] = mp
	}
	if src, ok := item["source"].(string); ok && src != "" {
		out["source"] = src
	}
	if ts, exists := item["threadSource"]; exists {
		if ts == nil {
			out["threadSource"] = nil
		} else if s, ok := ts.(string); ok {
			out["threadSource"] = s
		}
	}
	if tsSnake, ok := item["thread_source"].(string); ok && tsSnake != "" {
		out["threadSource"] = tsSnake
	}
	if cwd, ok := item["cwd"].(string); ok && cwd != "" {
		out["cwd"] = cwd
	}
	return out
}

func firstNonEmptyString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func firstNonNil(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, exists := m[k]; exists && v != nil {
			return v
		}
	}
	return nil
}

// SummarizeJSONRPCMessage 生成不包含敏感负荷的 JSON-RPC 诊断摘要。
func SummarizeJSONRPCMessage(message map[string]any) map[string]any {
	if message == nil {
		return map[string]any{"kind": "unknown"}
	}
	summary := make(map[string]any)
	if id := extractJSONRPCIDString(message); id != "" {
		summary["id"] = id
	}
	if method, ok := message["method"].(string); ok && strings.TrimSpace(method) != "" {
		summary["method"] = strings.TrimSpace(method)
	}
	if tid := extractJSONRPCThreadID(message); tid != "" {
		summary["threadId"] = tid
	}
	if method, _ := summary["method"].(string); method == "thread/list" {
		if params, ok := message["params"].(map[string]any); ok {
			if limit, ok := params["limit"]; ok {
				summary["limit"] = limit
			}
			if cursor, exists := params["cursor"]; exists {
				summary["cursor"] = cursor
			}
			if sk, ok := params["sortKey"].(string); ok && sk != "" {
				summary["sortKey"] = sk
			}
			if archived, exists := params["archived"]; exists {
				summary["archived"] = archived == true
			}
			if mp, ok := params["modelProviders"]; ok {
				summary["modelProviders"] = mp
			}
			if sks, ok := params["sourceKinds"]; ok {
				summary["sourceKinds"] = sks
			}
			summary["useStateDbOnly"] = params["useStateDbOnly"] == true
		}
	}
	if result, ok := message["result"].(map[string]any); ok && result != nil {
		if data, ok := result["data"].([]any); ok {
			threads := make([]map[string]any, 0, MaxRemoteThreadSummaryItems)
			ids := make([]string, 0, MaxRemoteThreadSummaryItems)
			for _, item := range data {
				compact := compactThreadListItem(item)
				if compact == nil {
					continue
				}
				threads = append(threads, compact)
				if id, _ := compact["id"].(string); id != "" {
					ids = append(ids, id)
				}
				if len(threads) >= MaxRemoteThreadSummaryItems {
					break
				}
			}
			summary["resultThreads"] = threads
			summary["resultThreadIds"] = ids
			if nc, ok := result["nextCursor"].(string); ok && nc != "" {
				summary["nextCursorValue"] = nc
			}
			if bc, ok := result["backwardsCursor"].(string); ok && bc != "" {
				summary["backwardsCursorValue"] = bc
			}
		}
	}
	return summary
}

// SummarizeRemoteEnvelope 提取 remote-control 信封字段摘要（不记录载荷明文）。
func SummarizeRemoteEnvelope(envelope any) map[string]any {
	m, ok := envelope.(map[string]any)
	if !ok || m == nil {
		return map[string]any{"type": "non_json"}
	}
	t, _ := m["type"].(string)
	t = strings.TrimSpace(t)
	if t == "" {
		t = "unknown"
	}
	summary := map[string]any{"type": t}
	if cid, ok := m["client_id"].(string); ok && cid != "" {
		summary["clientId"] = cid
	}
	if sid, ok := m["stream_id"].(string); ok && sid != "" {
		summary["streamId"] = sid
	}
	if seqID, exists := m["seq_id"]; exists {
		summary["seqId"] = seqID
	}
	if t == "client_message" || t == "server_message" {
		if msg, ok := m["message"].(map[string]any); ok {
			summary["message"] = SummarizeJSONRPCMessage(msg)
		}
	}
	if t == "client_message_chunk" || t == "server_message_chunk" {
		summary["segmentId"] = m["segment_id"]
		summary["segmentCount"] = m["segment_count"]
		summary["messageSizeBytes"] = m["message_size_bytes"]
	}
	return summary
}

// RewriteRemoteControlPayload 对 server->client 的 client_message 信封内部消息应用兼容重写。
func RewriteRemoteControlPayload(raw []byte) (payload []byte, changed bool, summary map[string]any) {
	var envelope map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(raw), &envelope); err != nil || envelope == nil {
		return raw, false, map[string]any{"type": "non_json"}
	}
	envType, _ := envelope["type"].(string)
	if strings.TrimSpace(envType) != "client_message" {
		return raw, false, SummarizeRemoteEnvelope(envelope)
	}
	origMsg, ok := envelope["message"].(map[string]any)
	if !ok || origMsg == nil {
		return raw, false, SummarizeRemoteEnvelope(envelope)
	}
	origMsgBytes, err := json.Marshal(origMsg)
	if err != nil {
		return raw, false, SummarizeRemoteEnvelope(envelope)
	}
	rewrittenMsgBytes := RewriteClientMessage(origMsgBytes, "")
	if bytes.Equal(rewrittenMsgBytes, origMsgBytes) {
		return raw, false, SummarizeRemoteEnvelope(envelope)
	}
	var rewrittenMsg map[string]any
	if err := json.Unmarshal(rewrittenMsgBytes, &rewrittenMsg); err != nil || rewrittenMsg == nil {
		return raw, false, SummarizeRemoteEnvelope(envelope)
	}
	nextEnvelope := make(map[string]any, len(envelope))
	for k, v := range envelope {
		nextEnvelope[k] = v
	}
	nextEnvelope["message"] = rewrittenMsg
	encoded, err := json.Marshal(nextEnvelope)
	if err != nil {
		return raw, false, SummarizeRemoteEnvelope(envelope)
	}
	return encoded, true, SummarizeRemoteEnvelope(nextEnvelope)
}

// ReadRemoteHydrationSuppressionState 读取当前仍在抑制有效期内的线程 ID 集合。
func ReadRemoteHydrationSuppressionState(filePath string, nowMs int64) map[string]struct{} {
	cleanPath := strings.TrimSpace(filePath)
	out := make(map[string]struct{})
	if cleanPath == "" {
		return out
	}
	if nowMs <= 0 {
		nowMs = time.Now().UnixMilli()
	}
	raw, err := os.ReadFile(cleanPath)
	if err != nil {
		return out
	}
	var state struct {
		Threads []struct {
			ID        string  `json:"id"`
			ExpiresAt float64 `json:"expiresAt"`
		} `json:"threads"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return out
	}
	for _, entry := range state.Threads {
		id := strings.TrimSpace(entry.ID)
		if id != "" && int64(entry.ExpiresAt) > nowMs {
			out[id] = struct{}{}
		}
	}
	return out
}

// ShouldSuppressRemoteHydrationEnvelope 判断当前服务端回放通知是否因后台水合期而应被静默丢弃。
func ShouldSuppressRemoteHydrationEnvelope(
	envelope map[string]any,
	suppressedIDs map[string]struct{},
) bool {
	if envelope == nil || len(suppressedIDs) == 0 {
		return false
	}
	envType, _ := envelope["type"].(string)
	if strings.TrimSpace(envType) != "server_message" {
		return false
	}
	msg, ok := envelope["message"].(map[string]any)
	if !ok || msg == nil {
		return false
	}
	method, _ := msg["method"].(string)
	if _, tracked := remoteHydrationNotificationMethods[strings.TrimSpace(method)]; !tracked {
		return false
	}
	threadID := extractJSONRPCThreadID(msg)
	if threadID == "" {
		return false
	}
	_, suppressed := suppressedIDs[threadID]
	return suppressed
}

type chunkAssemblyEntry struct {
	envType          string
	clientID         string
	streamID         string
	seqID            any
	segmentCount     int
	messageSizeBytes int
	parts            []string
	received         int
}

// RemoteChunkAssembler 在内存中按顺序重组分片控制帧用于调试追踪。
type RemoteChunkAssembler struct {
	mu         sync.Mutex
	chunks     map[string]*chunkAssemblyEntry
	writeTrace func(entry map[string]any)
}

// NewRemoteChunkAssembler 创建线程安全的分片重组观察器。
func NewRemoteChunkAssembler(writeTrace func(entry map[string]any)) *RemoteChunkAssembler {
	return &RemoteChunkAssembler{
		chunks:     make(map[string]*chunkAssemblyEntry),
		writeTrace: writeTrace,
	}
}

// Accept 接收单个分片信封，齐片后触发重组回调并释放缓存。
func (a *RemoteChunkAssembler) Accept(envelope map[string]any, direction string) {
	if a == nil || envelope == nil {
		return
	}
	envType, _ := envelope["type"].(string)
	envType = strings.TrimSpace(envType)
	if envType != "client_message_chunk" && envType != "server_message_chunk" {
		return
	}
	segCountF, ok1 := envelope["segment_count"].(float64)
	segIDF, ok2 := envelope["segment_id"].(float64)
	chunkB64, _ := envelope["message_chunk_base64"].(string)
	chunkB64 = strings.TrimSpace(chunkB64)
	segCount := int(segCountF)
	segID := int(segIDF)
	if !ok1 || !ok2 || float64(segCount) != segCountF || float64(segID) != segIDF ||
		segCount <= 0 || segID < 0 || segID >= segCount || chunkB64 == "" {
		return
	}
	msgSizeF, _ := envelope["message_size_bytes"].(float64)
	msgSize := int(msgSizeF)
	if msgSize > MaxChunkAssemblyBytes {
		return
	}

	clientID, _ := envelope["client_id"].(string)
	streamID, _ := envelope["stream_id"].(string)
	seqID := envelope["seq_id"]
	key := fmt.Sprintf("%s:%s:%s:%v", envType, clientID, streamID, seqID)

	a.mu.Lock()
	entry, exists := a.chunks[key]
	if !exists {
		entry = &chunkAssemblyEntry{
			envType:          envType,
			clientID:         clientID,
			streamID:         streamID,
			seqID:            seqID,
			segmentCount:     segCount,
			messageSizeBytes: msgSize,
			parts:            make([]string, segCount),
		}
		a.chunks[key] = entry
	}
	if entry.segmentCount != segCount {
		delete(a.chunks, key)
		a.mu.Unlock()
		return
	}
	if entry.parts[segID] == "" {
		entry.received++
	}
	entry.parts[segID] = chunkB64
	if entry.received != entry.segmentCount {
		a.mu.Unlock()
		return
	}
	delete(a.chunks, key)
	a.mu.Unlock()

	var rawMsg bytes.Buffer
	var decodeErr error
	for _, part := range entry.parts {
		decoded, err := base64.StdEncoding.DecodeString(part)
		if err != nil {
			decodeErr = err
			break
		}
		rawMsg.Write(decoded)
	}
	if a.writeTrace == nil {
		return
	}
	if decodeErr != nil {
		a.writeTrace(map[string]any{
			"direction": direction,
			"binary":    false,
			"summary": map[string]any{
				"type":     envType + "_reassemble_failed",
				"clientId": entry.clientID,
				"streamId": entry.streamID,
				"seqId":    entry.seqID,
				"error":    SanitizeTraceText(decodeErr.Error(), 4000),
			},
		})
		return
	}
	var parsed map[string]any
	_ = json.Unmarshal(rawMsg.Bytes(), &parsed)
	a.writeTrace(map[string]any{
		"direction": direction,
		"binary":    false,
		"summary": map[string]any{
			"type":             envType + "_reassembled",
			"clientId":         entry.clientID,
			"streamId":         entry.streamID,
			"seqId":            entry.seqID,
			"segmentCount":     entry.segmentCount,
			"messageSizeBytes": entry.messageSizeBytes,
			"message":          SummarizeJSONRPCMessage(parsed),
		},
	})
}

// RemoteControlDependencies 配置 ChatGPT remote-control HTTP/WebSocket 反向代理。
type RemoteControlDependencies struct {
	UpstreamOrigin    string
	SuppressStateFile string
	HTTPClient        *http.Client
	Now               func() time.Time
	WriteTrace        func(entry map[string]any)
}

// RemoteControlHandler 转发 Codex remote-control 的 HTTP 与 WebSocket 流量到上游 Origin。
type RemoteControlHandler struct {
	upstreamOrigin    *url.URL
	suppressStateFile string
	httpClient        *http.Client
	now               func() time.Time
	writeTrace        func(entry map[string]any)
	chunks            *RemoteChunkAssembler
}

// NewRemoteControlHandler 创建 remote-control HTTP/WS 代理处理器。
func NewRemoteControlHandler(deps RemoteControlDependencies) (*RemoteControlHandler, error) {
	rawOrigin := strings.TrimSpace(deps.UpstreamOrigin)
	if rawOrigin == "" {
		rawOrigin = DefaultRemoteControlOrigin
	}
	parsed, err := url.Parse(rawOrigin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("无效的上游 Origin: %q", rawOrigin)
	}
	client := deps.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: 60 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	nowFn := deps.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	writeTrace := deps.WriteTrace
	return &RemoteControlHandler{
		upstreamOrigin:    parsed,
		suppressStateFile: strings.TrimSpace(deps.SuppressStateFile),
		httpClient:        client,
		now:               nowFn,
		writeTrace:        writeTrace,
		chunks:            NewRemoteChunkAssembler(writeTrace),
	}, nil
}

func (h *RemoteControlHandler) trace(entry map[string]any) {
	if h.writeTrace != nil {
		h.writeTrace(entry)
	}
}

func (h *RemoteControlHandler) targetURL(reqURL *url.URL, forWebSocket bool) *url.URL {
	target := &url.URL{
		Scheme: h.upstreamOrigin.Scheme,
		Host:   h.upstreamOrigin.Host,
		Path:   DefaultRemoteControlBasePath,
	}
	if reqURL != nil {
		if reqURL.Path != "" {
			target.Path = reqURL.Path
		}
		target.RawQuery = reqURL.RawQuery
	}
	if forWebSocket {
		if strings.EqualFold(target.Scheme, "http") {
			target.Scheme = "ws"
		} else {
			target.Scheme = "wss"
		}
	}
	return target
}

func copyFilteredHeaders(src http.Header, extraSkip map[string]struct{}) http.Header {
	out := make(http.Header)
	for key, vals := range src {
		lower := strings.ToLower(key)
		if _, skip := hopByHopHeaders[lower]; skip {
			continue
		}
		if _, skip := extraSkip[lower]; skip {
			continue
		}
		copied := make([]string, len(vals))
		copy(copied, vals)
		out[key] = copied
	}
	return out
}

// ServeHTTP 根据请求是否为 WebSocket Upgrade 分流至 WS 双向代理或 HTTP 转发。
func (h *RemoteControlHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || request == nil {
		http.Error(response, "remote_control_proxy_failed", http.StatusServiceUnavailable)
		return
	}
	if IsUpgradeRequest(request) {
		h.serveWebSocket(response, request)
		return
	}
	h.serveHTTPRequest(response, request)
}

func (h *RemoteControlHandler) serveHTTPRequest(response http.ResponseWriter, request *http.Request) {
	target := h.targetURL(request.URL, false)
	limited := io.LimitReader(request.Body, MaxRemoteHTTPBodyBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		http.Error(response, "request_body_read_failed", http.StatusBadRequest)
		return
	}
	if len(body) > MaxRemoteHTTPBodyBytes {
		http.Error(response, "request_body_too_large", http.StatusRequestEntityTooLarge)
		return
	}

	h.trace(map[string]any{
		"direction": "http_to_chatgpt",
		"method":    request.Method,
		"path":      target.Path,
		"bodyBytes": len(body),
	})

	var bodyReader io.Reader
	if len(body) > 0 {
		bodyReader = bytes.NewReader(body)
	}
	outReq, err := http.NewRequestWithContext(request.Context(), request.Method, target.String(), bodyReader)
	if err != nil {
		http.Error(response, "remote_control_proxy_failed", http.StatusInternalServerError)
		return
	}
	outReq.Header = copyFilteredHeaders(request.Header, nil)

	resp, err := h.httpClient.Do(outReq)
	if err != nil {
		h.trace(map[string]any{
			"direction": "http_from_chatgpt",
			"method":    request.Method,
			"path":      target.Path,
			"error":     SanitizeTraceText(err.Error(), 4000),
		})
		http.Error(response, "remote_control_proxy_upstream_failed", http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, MaxRemoteHTTPBodyBytes+1))
	if err != nil {
		http.Error(response, "remote_control_proxy_upstream_failed", http.StatusBadGateway)
		return
	}
	for k, vals := range resp.Header {
		lower := strings.ToLower(k)
		if lower == "content-encoding" || lower == "transfer-encoding" || lower == "content-length" {
			continue
		}
		for _, v := range vals {
			response.Header().Add(k, v)
		}
	}
	reqID := resp.Header.Get("X-Request-Id")
	if reqID == "" {
		reqID = resp.Header.Get("X-Oai-Request-Id")
	}
	h.trace(map[string]any{
		"direction": "http_from_chatgpt",
		"method":    request.Method,
		"path":      target.Path,
		"status":    resp.StatusCode,
		"bodyBytes": len(respBody),
		"requestId": reqID,
		"cfRay":     resp.Header.Get("Cf-Ray"),
	})

	response.WriteHeader(resp.StatusCode)
	_, _ = response.Write(respBody)
}

func (h *RemoteControlHandler) serveWebSocket(response http.ResponseWriter, request *http.Request) {
	target := h.targetURL(request.URL, true)
	h.trace(map[string]any{
		"direction": "ws_connect_to_chatgpt",
		"path":      target.Path,
	})

	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()

	dialOpts := &websocket.DialOptions{
		HTTPClient: h.httpClient,
		HTTPHeader: copyFilteredHeaders(request.Header, wsHandshakeHeaders),
	}
	dialCtx, dialCancel := context.WithTimeout(ctx, 20*time.Second)
	upstream, _, err := websocket.Dial(dialCtx, target.String(), dialOpts)
	dialCancel()
	if err != nil {
		h.trace(map[string]any{
			"direction": "ws_connect_to_chatgpt",
			"path":      target.Path,
			"error":     SanitizeTraceText(err.Error(), 4000),
		})
		http.Error(response, "remote_control_ws_upstream_failed", http.StatusBadGateway)
		return
	}

	client, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		_ = upstream.CloseNow()
		return
	}
	client.SetReadLimit(maxAppServerLineBytes)
	upstream.SetReadLimit(maxAppServerLineBytes)

	var closeOnce sync.Once
	shutdown := func() {
		closeOnce.Do(func() {
			cancel()
			_ = client.Close(websocket.StatusNormalClosure, "")
			_ = upstream.Close(websocket.StatusNormalClosure, "")
		})
	}
	defer shutdown()

	var wg sync.WaitGroup
	wg.Add(2)

	// client -> upstream
	go func() {
		defer wg.Done()
		defer shutdown()
		for {
			msgType, data, readErr := client.Read(ctx)
			if readErr != nil {
				if !errors.Is(readErr, context.Canceled) {
					h.trace(map[string]any{
						"direction": "ws_client_error",
						"error":     SanitizeTraceText(readErr.Error(), 4000),
					})
				}
				return
			}
			if msgType == websocket.MessageBinary {
				h.trace(map[string]any{
					"direction": "ws_app_server_to_chatgpt",
					"binary":    true,
					"summary":   map[string]any{"type": "binary"},
				})
				if writeErr := upstream.Write(ctx, websocket.MessageBinary, data); writeErr != nil {
					return
				}
				continue
			}

			var envelope map[string]any
			_ = json.Unmarshal(bytes.TrimSpace(data), &envelope)
			suppressedIDs := ReadRemoteHydrationSuppressionState(h.suppressStateFile, h.now().UnixMilli())
			suppressed := ShouldSuppressRemoteHydrationEnvelope(envelope, suppressedIDs)
			var summary any = SummarizeRemoteEnvelope(envelope)
			if envelope == nil {
				summary = SummarizeRemoteEnvelope(string(data))
			}
			traceEntry := map[string]any{
				"direction": "ws_app_server_to_chatgpt",
				"binary":    false,
				"summary":   summary,
			}
			if suppressed {
				traceEntry["suppressed"] = true
				traceEntry["reason"] = "hidden_hydration_notification"
			}
			h.trace(traceEntry)
			h.chunks.Accept(envelope, "ws_app_server_to_chatgpt")
			if suppressed {
				continue
			}
			if writeErr := upstream.Write(ctx, websocket.MessageText, data); writeErr != nil {
				return
			}
		}
	}()

	// upstream -> client
	go func() {
		defer wg.Done()
		defer shutdown()
		for {
			msgType, data, readErr := upstream.Read(ctx)
			if readErr != nil {
				if !errors.Is(readErr, context.Canceled) {
					h.trace(map[string]any{
						"direction": "ws_upstream_error",
						"error":     SanitizeTraceText(readErr.Error(), 4000),
					})
				}
				return
			}
			if msgType == websocket.MessageBinary {
				h.trace(map[string]any{
					"direction": "ws_chatgpt_to_app_server",
					"binary":    true,
					"summary":   map[string]any{"type": "binary"},
				})
				if writeErr := client.Write(ctx, websocket.MessageBinary, data); writeErr != nil {
					return
				}
				continue
			}
			var envelope map[string]any
			_ = json.Unmarshal(bytes.TrimSpace(data), &envelope)
			rewritten, changed, summary := RewriteRemoteControlPayload(data)
			h.trace(map[string]any{
				"direction": "ws_chatgpt_to_app_server",
				"binary":    false,
				"rewritten": changed,
				"summary":   summary,
			})
			h.chunks.Accept(envelope, "ws_chatgpt_to_app_server")
			if writeErr := client.Write(ctx, websocket.MessageText, rewritten); writeErr != nil {
				return
			}
		}
	}()

	wg.Wait()
}
