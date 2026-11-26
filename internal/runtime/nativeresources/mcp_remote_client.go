package nativeresources

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	mcpRemoteTimeout        = 15 * time.Second
	mcpRemoteRequestTimeout = 10 * time.Second
	mcpSessionHeader        = "Mcp-Session-Id"
)

type mcpSession interface {
	initialize(ctx context.Context) (map[string]any, error)
	listTools(ctx context.Context) ([]map[string]any, error)
	callTool(ctx context.Context, tool string, args map[string]any) (map[string]any, error)
	close()
}

func dialMCPClient(ctx context.Context, server *MCPServerSpec) (mcpSession, error) {
	if server == nil {
		return nil, fail("mcp_definition_required")
	}
	switch strings.ToLower(strings.TrimSpace(server.Transport)) {
	case "", "stdio":
		return dialMCPStdio(ctx, server)
	case "http":
		return dialMCPHTTP(server)
	case "sse":
		return dialMCPSSE(ctx, server)
	default:
		return nil, fail("mcp_transport_invalid")
	}
}

// ---------- Streamable HTTP ----------

type mcpHTTPClient struct {
	server      *MCPServerSpec
	client      *http.Client
	sessionID   string
	nextID      int64
	mu          sync.Mutex
	initialized map[string]any
}

func dialMCPHTTP(server *MCPServerSpec) (*mcpHTTPClient, error) {
	if server == nil || strings.TrimSpace(server.URL) == "" {
		return nil, fail("mcp_url_required")
	}
	return &mcpHTTPClient{
		server: server,
		client: &http.Client{Timeout: mcpRemoteTimeout},
	}, nil
}

func (c *mcpHTTPClient) nextRequestID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	return c.nextID
}

func (c *mcpHTTPClient) request(ctx context.Context, method string, params any, notification bool) (any, http.Header, error) {
	body := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		body["params"] = params
	}
	id := int64(0)
	if !notification {
		id = c.nextRequestID()
		body["id"] = id
	}
	raw, err := json.Marshal(body)
	if err != nil || len(raw) > maxMCPFrameBytes {
		return nil, nil, fail("mcp_request_limit")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.server.URL, bytes.NewReader(raw))
	if err != nil {
		return nil, nil, fail("mcp_remote_request_invalid")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	for key, value := range c.server.Headers {
		request.Header.Set(key, value)
	}
	c.mu.Lock()
	sessionID := c.sessionID
	c.mu.Unlock()
	if sessionID != "" {
		request.Header.Set(mcpSessionHeader, sessionID)
	}

	response, err := c.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, fail("mcp_cancelled")
		}
		return nil, nil, fail("mcp_remote_unreachable")
	}
	defer response.Body.Close()
	if session := strings.TrimSpace(response.Header.Get(mcpSessionHeader)); session != "" {
		c.mu.Lock()
		c.sessionID = session
		c.mu.Unlock()
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, response.Header, fmt.Errorf("mcp_remote_http_%d", response.StatusCode)
	}
	if notification {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, response.Header, nil
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") {
		result, readErr := readSSEResponse(response.Body, id)
		return result, response.Header, readErr
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxMCPFrameBytes+1))
	if err != nil || len(payload) > maxMCPFrameBytes {
		return nil, response.Header, fail("mcp_response_limit")
	}
	var decoded any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, response.Header, fail("mcp_response_invalid")
	}
	result, err := pickRPCResponse(decoded, id)
	return result, response.Header, err
}

func pickRPCResponse(decoded any, id int64) (any, error) {
	candidates := []any{decoded}
	if list, ok := decoded.([]any); ok {
		candidates = list
	}
	for _, item := range candidates {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rawID, ok := msg["id"].(float64)
		if !ok || int64(rawID) != id {
			continue
		}
		_, hasErr := msg["error"]
		_, hasResult := msg["result"]
		if hasErr == hasResult {
			return nil, fail("mcp_response_invalid")
		}
		if hasErr {
			return nil, fail("mcp_remote_error")
		}
		return msg["result"], nil
	}
	return nil, fail("mcp_response_id_mismatch")
}

func readSSEResponse(reader io.Reader, id int64) (any, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maxMCPFrameBytes)
	event := ""
	data := make([]string, 0, 1)
	dispatch := func() (any, error, bool) {
		if len(data) == 0 {
			event = ""
			return nil, nil, false
		}
		payload := strings.Join(data, "\n")
		data = data[:0]
		currentEvent := event
		event = ""
		if currentEvent != "" && currentEvent != "message" {
			return nil, nil, false
		}
		var msg any
		if json.Unmarshal([]byte(payload), &msg) != nil {
			return nil, nil, false
		}
		result, err := pickRPCResponse(msg, id)
		if err != nil {
			if err.Error() == "mcp_response_id_mismatch" {
				return nil, nil, false
			}
			return nil, err, true
		}
		return result, nil, true
	}
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			if result, err, done := dispatch(); done {
				return result, err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
		}
	}
	if result, err, done := dispatch(); done {
		return result, err
	}
	if err := scanner.Err(); err != nil && strings.Contains(err.Error(), "token too long") {
		return nil, fail("mcp_response_limit")
	}
	return nil, fail("mcp_response_id_mismatch")
}

func (c *mcpHTTPClient) initialize(ctx context.Context) (map[string]any, error) {
	if c.initialized != nil {
		return c.initialized, nil
	}
	raw, _, err := c.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-03-26",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "aih-mcp-manager", "version": "1.0.0"},
	}, false)
	if err != nil {
		return nil, err
	}
	resMap, ok := raw.(map[string]any)
	if !ok {
		return nil, fail("mcp_initialize_invalid")
	}
	ver, _ := resMap["protocolVersion"].(string)
	info, _ := resMap["serverInfo"].(map[string]any)
	name, _ := info["name"].(string)
	if !mcpProtocols[ver] || name == "" {
		return nil, fail("mcp_initialize_invalid")
	}
	if _, _, err := c.request(ctx, "notifications/initialized", nil, true); err != nil {
		return nil, err
	}
	c.initialized = resMap
	return resMap, nil
}

func (c *mcpHTTPClient) listTools(ctx context.Context) ([]map[string]any, error) {
	if _, err := c.initialize(ctx); err != nil {
		return nil, err
	}
	return listMCPTools(ctx, c.request)
}

func (c *mcpHTTPClient) callTool(ctx context.Context, tool string, args map[string]any) (map[string]any, error) {
	if _, err := c.initialize(ctx); err != nil {
		return nil, err
	}
	return callMCPTool(ctx, c.request, tool, args)
}

func (c *mcpHTTPClient) close() {}

// ---------- Legacy SSE ----------

type mcpSSEClient struct {
	server      *MCPServerSpec
	client      *http.Client
	cancel      context.CancelFunc
	body        io.ReadCloser
	postURL     string
	endpointCh  chan string
	pending     map[int64]chan rpcResp
	mu          sync.Mutex
	nextID      int64
	failure     error
	closed      bool
	initialized map[string]any
}

func dialMCPSSE(ctx context.Context, server *MCPServerSpec) (*mcpSSEClient, error) {
	if server == nil || strings.TrimSpace(server.URL) == "" {
		return nil, fail("mcp_url_required")
	}
	streamCtx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(streamCtx, http.MethodGet, server.URL, nil)
	if err != nil {
		cancel()
		return nil, fail("mcp_remote_request_invalid")
	}
	request.Header.Set("Accept", "text/event-stream")
	for key, value := range server.Headers {
		request.Header.Set(key, value)
	}
	response, err := (&http.Client{}).Do(request)
	if err != nil {
		cancel()
		return nil, fail("mcp_remote_unreachable")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_ = response.Body.Close()
		cancel()
		return nil, fmt.Errorf("mcp_remote_http_%d", response.StatusCode)
	}
	client := &mcpSSEClient{
		server:     server,
		client:     &http.Client{Timeout: mcpRemoteTimeout},
		cancel:     cancel,
		body:       response.Body,
		endpointCh: make(chan string, 1),
		pending:    make(map[int64]chan rpcResp),
	}
	go client.readLoop()
	select {
	case endpoint := <-client.endpointCh:
		if strings.TrimSpace(endpoint) == "" {
			client.close()
			return nil, fail("mcp_remote_endpoint_missing")
		}
		client.postURL = endpoint
		return client, nil
	case <-time.After(mcpRemoteRequestTimeout):
		client.close()
		return nil, fail("mcp_remote_endpoint_timeout")
	case <-ctx.Done():
		client.close()
		return nil, fail("mcp_cancelled")
	}
}

func (c *mcpSSEClient) readLoop() {
	defer c.body.Close()
	scanner := bufio.NewScanner(c.body)
	scanner.Buffer(make([]byte, 4096), maxMCPFrameBytes)
	event := ""
	data := make([]string, 0, 1)
	dispatch := func() {
		if len(data) == 0 {
			event = ""
			return
		}
		payload := strings.Join(data, "\n")
		data = data[:0]
		currentEvent := event
		event = ""
		switch currentEvent {
		case "endpoint":
			postURL, err := resolveSSEPostURL(c.server.URL, payload)
			if err != nil {
				c.fail(fail("mcp_remote_endpoint_invalid"))
				return
			}
			select {
			case c.endpointCh <- postURL:
			default:
			}
		case "", "message":
			c.dispatchMessage([]byte(payload))
		}
	}
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			dispatch()
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
		}
	}
	dispatch()
	c.fail(fail("mcp_sse_closed"))
}

func resolveSSEPostURL(baseURL, endpoint string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", err
	}
	reference, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil {
		return "", err
	}
	resolved := base.ResolveReference(reference)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return "", fail("mcp_remote_endpoint_invalid")
	}
	return resolved.String(), nil
}

func (c *mcpSSEClient) dispatchMessage(payload []byte) {
	var msg map[string]any
	if err := json.Unmarshal(payload, &msg); err != nil || msg == nil {
		return
	}
	if method, ok := msg["method"].(string); ok {
		if rawID, hasID := msg["id"]; hasID && rawID != nil {
			result := map[string]any{}
			if method != "ping" {
				c.sendServerError(rawID)
				return
			}
			c.sendServerResult(rawID, result)
		}
		return
	}
	rawID, ok := msg["id"].(float64)
	if !ok {
		return
	}
	id := int64(rawID)
	c.mu.Lock()
	ch, found := c.pending[id]
	if found {
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if !found {
		return
	}
	_, hasErr := msg["error"]
	_, hasResult := msg["result"]
	if hasErr == hasResult {
		ch <- rpcResp{err: fail("mcp_response_invalid")}
		return
	}
	if hasErr {
		ch <- rpcResp{err: fail("mcp_remote_error")}
		return
	}
	ch <- rpcResp{result: msg["result"]}
}

func (c *mcpSSEClient) sendServerResult(id any, result map[string]any) {
	_ = c.post(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (c *mcpSSEClient) sendServerError(id any) {
	_ = c.post(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "Method not supported"}})
}

func (c *mcpSSEClient) post(payload any) error {
	if strings.TrimSpace(c.postURL) == "" {
		return fail("mcp_remote_endpoint_missing")
	}
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > maxMCPFrameBytes {
		return fail("mcp_request_limit")
	}
	ctx, cancel := context.WithTimeout(context.Background(), mcpRemoteRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.postURL, bytes.NewReader(raw))
	if err != nil {
		return fail("mcp_remote_request_invalid")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	for key, value := range c.server.Headers {
		request.Header.Set(key, value)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return fail("mcp_remote_unreachable")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("mcp_remote_http_%d", response.StatusCode)
	}
	return nil
}

func (c *mcpSSEClient) request(ctx context.Context, method string, params any) (any, error) {
	if strings.TrimSpace(c.postURL) == "" {
		return nil, fail("mcp_remote_endpoint_missing")
	}
	c.mu.Lock()
	if c.failure != nil || c.closed {
		err := c.failure
		if err == nil {
			err = fail("mcp_sse_closed")
		}
		c.mu.Unlock()
		return nil, err
	}
	c.nextID++
	id := c.nextID
	ch := make(chan rpcResp, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	body := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		body["params"] = params
	}
	if err := c.post(body); err != nil {
		c.fail(err)
		return nil, err
	}
	timer := time.NewTimer(mcpRemoteRequestTimeout)
	defer timer.Stop()
	select {
	case response := <-ch:
		return response.result, response.err
	case <-timer.C:
		c.fail(fail("mcp_request_timeout"))
		return nil, fail("mcp_request_timeout")
	case <-ctx.Done():
		return nil, fail("mcp_cancelled")
	}
}

func (c *mcpSSEClient) notify(ctx context.Context, method string) error {
	if err := c.post(map[string]any{"jsonrpc": "2.0", "method": method}); err != nil {
		return err
	}
	return nil
}

func (c *mcpSSEClient) initialize(ctx context.Context) (map[string]any, error) {
	if c.initialized != nil {
		return c.initialized, nil
	}
	raw, err := c.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-03-26",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "aih-mcp-manager", "version": "1.0.0"},
	})
	if err != nil {
		return nil, err
	}
	resMap, ok := raw.(map[string]any)
	if !ok {
		return nil, fail("mcp_initialize_invalid")
	}
	ver, _ := resMap["protocolVersion"].(string)
	info, _ := resMap["serverInfo"].(map[string]any)
	name, _ := info["name"].(string)
	if !mcpProtocols[ver] || name == "" {
		return nil, fail("mcp_initialize_invalid")
	}
	if err := c.notify(ctx, "notifications/initialized"); err != nil {
		return nil, err
	}
	c.initialized = resMap
	return resMap, nil
}

func (c *mcpSSEClient) listTools(ctx context.Context) ([]map[string]any, error) {
	if _, err := c.initialize(ctx); err != nil {
		return nil, err
	}
	return listMCPTools(ctx, func(ctx context.Context, method string, params any, _ bool) (any, http.Header, error) {
		result, err := c.request(ctx, method, params)
		return result, nil, err
	})
}

func (c *mcpSSEClient) callTool(ctx context.Context, tool string, args map[string]any) (map[string]any, error) {
	if _, err := c.initialize(ctx); err != nil {
		return nil, err
	}
	return callMCPTool(ctx, func(ctx context.Context, method string, params any, _ bool) (any, http.Header, error) {
		result, err := c.request(ctx, method, params)
		return result, nil, err
	}, tool, args)
}

func (c *mcpSSEClient) fail(reason error) {
	c.mu.Lock()
	if c.failure == nil {
		c.failure = reason
	}
	pending := c.pending
	c.pending = make(map[int64]chan rpcResp)
	c.mu.Unlock()
	for _, ch := range pending {
		ch <- rpcResp{err: reason}
	}
}

func (c *mcpSSEClient) close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	c.cancel()
	_ = c.body.Close()
	c.fail(fail("mcp_sse_closed"))
}

// ---------- shared tool helpers ----------

type mcpRequestFunc func(ctx context.Context, method string, params any, notification bool) (any, http.Header, error)

func listMCPTools(ctx context.Context, request mcpRequestFunc) ([]map[string]any, error) {
	tools := make([]map[string]any, 0)
	seenNames := make(map[string]bool)
	cursors := make(map[string]bool)
	var cursor string
	for {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, _, err := request(ctx, "tools/list", params, false)
		if err != nil {
			return nil, err
		}
		resMap, ok := raw.(map[string]any)
		if !ok {
			return nil, fail("mcp_tools_invalid")
		}
		rawList, ok := resMap["tools"].([]any)
		if !ok {
			return nil, fail("mcp_tools_invalid")
		}
		for _, item := range rawList {
			toolMap, ok := item.(map[string]any)
			if !ok {
				return nil, fail("mcp_tools_invalid")
			}
			name, _ := toolMap["name"].(string)
			schema, _ := toolMap["inputSchema"].(map[string]any)
			schemaType, _ := schema["type"].(string)
			if name == "" || len(name) > 128 || schemaType != "object" || seenNames[name] {
				return nil, fail("mcp_tools_invalid")
			}
			seenNames[name] = true
			tools = append(tools, toolMap)
		}
		if len(tools) > 256 || len(cursors) >= 20 {
			return nil, fail("mcp_tools_limit")
		}
		nextRaw, exists := resMap["nextCursor"]
		if !exists || nextRaw == nil {
			break
		}
		next, ok := nextRaw.(string)
		if !ok || next == "" || cursors[next] {
			return nil, fail("mcp_tools_cursor_invalid")
		}
		cursors[next] = true
		cursor = next
	}
	return tools, nil
}

func callMCPTool(ctx context.Context, request mcpRequestFunc, tool string, args map[string]any) (map[string]any, error) {
	if strings.TrimSpace(tool) == "" || args == nil {
		return nil, fail("mcp_tool_arguments_invalid")
	}
	raw, _, err := request(ctx, "tools/call", map[string]any{"name": tool, "arguments": args}, false)
	if err != nil {
		return nil, err
	}
	resMap, ok := raw.(map[string]any)
	if !ok {
		return nil, fail("mcp_tool_result_invalid")
	}
	if _, ok := resMap["content"].([]any); !ok {
		return nil, fail("mcp_tool_result_invalid")
	}
	return resMap, nil
}
