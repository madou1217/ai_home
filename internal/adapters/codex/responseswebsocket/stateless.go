package responseswebsocket

import (
	"context"
	"encoding/json"
	"sort"
	"sync"

	"github.com/coder/websocket"

	"github.com/madou1217/ai_home/internal/adapters/codex/responsesitem"
)

const maxStatelessContextBytes = 32 * 1024 * 1024

// statelessConnection expands incremental continuations before forwarding them.
//
// Responses WebSockets may carry previous_response_id without the upstream
// retaining that response (store:false), and pooled accounts switch between
// upstreams at any reconnect. Relying on upstream persistence then fails with
// previous_response_id errors the client cannot repair. The connection keeps the
// last turn and the Dialer's shared journal covers every other turn of the same
// process, so a continuation from an earlier connection or another account is
// forwarded as a complete stateless request instead.
type statelessConnection struct {
	Connection
	journal       *responseJournal
	mu            sync.Mutex
	lastID        string
	lastInput     []json.RawMessage
	pendingInput  []json.RawMessage
	pendingValid  bool
	pendingOutput map[int]json.RawMessage
	outputBytes   int
}

func (connection *statelessConnection) Write(ctx context.Context, kind websocket.MessageType, payload []byte) error {
	if kind == websocket.MessageText {
		payload = connection.prepare(payload)
	}
	return connection.Connection.Write(ctx, kind, payload)
}

func (connection *statelessConnection) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	kind, payload, err := connection.Connection.Read(ctx)
	if err == nil && kind == websocket.MessageText {
		connection.observe(payload)
	}
	return kind, payload, err
}

func (connection *statelessConnection) prepare(payload []byte) []byte {
	var frame map[string]json.RawMessage
	if json.Unmarshal(payload, &frame) != nil || string(frame["type"]) != `"response.create"` {
		return payload
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.pendingInput, connection.pendingValid = nil, false
	connection.pendingOutput, connection.outputBytes = nil, 0
	input, ok := statelessInput(frame["input"])
	if !ok {
		return payload
	}
	var previous string
	_ = json.Unmarshal(frame["previous_response_id"], &previous)
	if previous != "" {
		contextItems, found := connection.continuationContext(previous)
		if found {
			expanded := make([]json.RawMessage, 0, len(contextItems)+len(input))
			expanded = append(expanded, contextItems...)
			expanded = append(expanded, input...)
			// 展开后的请求是 store:false 的无状态请求：旧账号的 item.id 与新账号
			// 存储无关，encrypted_content 也无法解密，必须按无状态语义剥掉。
			expanded = stripForeignState(expanded)
			if encoded, err := json.Marshal(expanded); err == nil && len(encoded) <= maxStatelessContextBytes {
				frame["input"] = encoded
				delete(frame, "previous_response_id")
				// 展开后的请求自带完整上下文，不需要（也不能）让上游再持久化续接。
				frame["store"] = json.RawMessage("false")
				if prepared, err := json.Marshal(frame); err == nil && len(prepared) <= maxStatelessContextBytes {
					payload = prepared
					input = expanded
				}
			}
		}
		// 未知 ID 不凭空补上下文：保持原帧，让上游给出真实终态。
	}
	if statelessInputSize(input) <= maxStatelessContextBytes {
		connection.pendingInput, connection.pendingValid = input, true
	}
	return payload
}

// continuationContext 先看本连接上一轮，再看 Dialer 的进程级日志。
//
// 日志覆盖换号、重连和另一条连接上的同会话续接；两者都未命中时不能发明上下文。
func (connection *statelessConnection) continuationContext(previous string) ([]json.RawMessage, bool) {
	if connection.lastID == previous && connection.lastInput != nil {
		return connection.lastInput, true
	}
	if connection.journal == nil {
		return nil, false
	}
	return connection.journal.Lookup(previous)
}

// stripForeignState 按 store:false 语义清理展开后的历史项。
//
// 展开后的请求可能落到另一个账号：item.id 属于原账号的响应存储，加密推理
// 也只能被原账号解密。保留它们会被上游以 invalid_id / invalid_encrypted_content
// 拒绝；调用与结果的配对使用 call_id，不依赖 item.id。
func stripForeignState(items []json.RawMessage) []json.RawMessage {
	changed := false
	out := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		var fields map[string]json.RawMessage
		if json.Unmarshal(item, &fields) != nil {
			out = append(out, item)
			continue
		}
		var itemType string
		_ = json.Unmarshal(fields["type"], &itemType)
		// 工具发现、本地 shell、web 搜索只是客户端的本地轨迹；上游无法重放，
		// 展开为无状态请求时必须移除（与 HTTP 清洗同一份名单）。
		if responsesitem.IsUnreplayableInputItem(itemType) {
			changed = true
			continue
		}
		itemChanged := false
		if _, found := fields["id"]; found {
			delete(fields, "id")
			itemChanged = true
		}
		if itemType == "reasoning" {
			if _, found := fields["encrypted_content"]; found {
				delete(fields, "encrypted_content")
				itemChanged = true
			}
		}
		if !itemChanged {
			out = append(out, item)
			continue
		}
		rewritten, err := json.Marshal(fields)
		if err != nil {
			out = append(out, item)
			continue
		}
		out = append(out, rewritten)
		changed = true
	}
	if !changed {
		return items
	}
	return out
}

func (connection *statelessConnection) observe(payload []byte) {
	var event struct {
		Type        string          `json:"type"`
		OutputIndex int             `json:"output_index"`
		Item        json.RawMessage `json:"item"`
		Response    struct {
			ID     string            `json:"id"`
			Output []json.RawMessage `json:"output"`
		} `json:"response"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return
	}
	switch event.Type {
	case "response.output_item.done", "response.completed", "response.failed", "response.incomplete", "error":
	default:
		return
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if event.Type == "response.output_item.done" {
		if !connection.pendingValid || event.OutputIndex < 0 || len(event.Item) == 0 || string(event.Item) == "null" {
			return
		}
		if connection.pendingOutput == nil {
			connection.pendingOutput = make(map[int]json.RawMessage)
		}
		connection.outputBytes += len(event.Item) - len(connection.pendingOutput[event.OutputIndex])
		if connection.outputBytes > maxStatelessContextBytes {
			connection.pendingOutput, connection.pendingValid = nil, false
			return
		}
		connection.pendingOutput[event.OutputIndex] = event.Item
		return
	}
	defer func() {
		connection.pendingInput, connection.pendingValid = nil, false
		connection.pendingOutput, connection.outputBytes = nil, 0
	}()
	if event.Type != "response.completed" {
		return
	}
	connection.lastID, connection.lastInput = "", nil
	if !connection.pendingValid || event.Response.ID == "" {
		return
	}
	// Codex's Responses Lite stream ends with output:[] even after emitting
	// completed tool items. Those items are the authoritative full outputs.
	if len(event.Response.Output) == 0 && len(connection.pendingOutput) > 0 {
		indices := make([]int, 0, len(connection.pendingOutput))
		for index := range connection.pendingOutput {
			indices = append(indices, index)
		}
		sort.Ints(indices)
		for _, index := range indices {
			event.Response.Output = append(event.Response.Output, connection.pendingOutput[index])
		}
	}
	items := make([]json.RawMessage, 0, len(connection.pendingInput)+len(event.Response.Output))
	items = append(items, connection.pendingInput...)
	items = append(items, event.Response.Output...)
	// 进程级日志跨连接共享：换号或重连后的续接仍能展开为完整上下文。
	if connection.journal != nil {
		connection.journal.Store(event.Response.ID, items)
	}
	if statelessInputSize(items) > maxStatelessContextBytes {
		return
	}
	connection.lastID = event.Response.ID
	connection.lastInput = items
}

func statelessInput(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return []json.RawMessage{}, true
	}
	var input []json.RawMessage
	if json.Unmarshal(raw, &input) == nil {
		return input, true
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return nil, false
	}
	item, _ := json.Marshal(map[string]string{"role": "user", "content": text})
	return []json.RawMessage{item}, true
}

func statelessInputSize(input []json.RawMessage) int {
	size := 2
	for _, item := range input {
		size += len(item) + 1
	}
	return size
}
