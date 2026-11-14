package chatruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	codexDispatchCapacity  = 256
	codexDispatchByteLimit = 16 << 20
)

type codexTurnRegistration struct {
	binding CodexTurnBinding
	active  atomic.Bool
}

type codexQueuedNotification struct {
	id            any
	method        string
	params        json.RawMessage
	registration  *codexTurnRegistration
	serverRequest bool
	bytes         int
}

// codexRPCDispatch 用固定环形数组保持连接内通知顺序，同时让 reader 始终可处理响应。
// 条数/原始字节都有限制，包含正在执行的回调；溢出明确断连而不是丢终态或堵 reader。
// 每条连接只有一个 worker，回调内同步 Request 不会自等待。
type codexRPCDispatch struct {
	client                     *CodexAppServerClient
	cmd                        *exec.Cmd
	mu                         sync.Mutex
	ready                      *sync.Cond
	entries                    [codexDispatchCapacity]codexQueuedNotification
	head, count, bytes, active int
	stopped                    bool
	terminal                   map[string]*codexTurnRegistration
	reason                     error
}

func newCodexRPCDispatch(client *CodexAppServerClient, cmd *exec.Cmd) *codexRPCDispatch {
	d := &codexRPCDispatch{client: client, cmd: cmd}
	d.ready = sync.NewCond(&d.mu)
	return d
}

func (d *codexRPCDispatch) enqueue(event codexQueuedNotification) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopped || d.count+d.active >= codexDispatchCapacity || event.bytes > codexDispatchByteLimit-d.bytes {
		return false
	}
	d.entries[(d.head+d.count)%codexDispatchCapacity] = event
	d.count++
	d.bytes += event.bytes
	d.ready.Signal()
	return true
}

func (d *codexRPCDispatch) finish(bindings map[string]*codexTurnRegistration, reason error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stopped {
		return
	}
	d.stopped, d.terminal, d.reason = true, bindings, reason
	d.ready.Signal()
}

func (d *codexRPCDispatch) run() {
	defer func() { d.client.mu.Lock(); d.client.dispatchers--; d.client.mu.Unlock() }()
	for {
		d.mu.Lock()
		for d.count == 0 && !d.stopped {
			d.ready.Wait()
		}
		if d.count == 0 && d.stopped {
			terminal, reason := d.terminal, d.reason
			d.terminal = nil
			d.mu.Unlock()
			// 已收到的正常终态先交付，断连是最后一项；不会盖掉排队中的 completed。
			for _, binding := range terminal {
				if binding.active.Swap(false) && binding.binding.OnDisconnected != nil {
					binding.binding.OnDisconnected(reason)
				}
			}
			return
		}
		event := d.entries[d.head]
		d.entries[d.head] = codexQueuedNotification{}
		d.head = (d.head + 1) % codexDispatchCapacity
		d.count--
		d.active = 1
		d.mu.Unlock()
		d.deliver(event)
		d.mu.Lock()
		d.active = 0
		d.bytes -= event.bytes
		d.mu.Unlock()
	}
}

func (d *codexRPCDispatch) deliver(event codexQueuedNotification) {
	registration := event.registration
	if registration == nil || !registration.active.Load() {
		if event.serverRequest {
			_ = d.client.writeConnectionEnvelope(context.Background(), d.cmd, map[string]any{
				"jsonrpc": "2.0", "id": event.id, "error": map[string]any{"code": -32601, "message": "unsupported server request method"},
			})
		}
		return
	}
	var params map[string]any
	if len(event.params) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(event.params))
		decoder.UseNumber()
		if err := decoder.Decode(&params); err != nil {
			_ = d.client.disconnectConnection(d.cmd, NewError("codex_app_server_invalid_message", http.StatusBadGateway, nil), false)
			return
		}
	}
	ctx := context.WithValue(context.Background(), codexRPCConnectionKey{}, d.cmd)
	message := CodexJSONRPCMessage{Context: ctx, ID: event.id, Method: event.method, Params: params}
	if event.serverRequest {
		if registration.binding.OnServerRequest != nil {
			registration.binding.OnServerRequest(message)
		}
	} else if registration.binding.OnNotification != nil {
		registration.binding.OnNotification(message)
	}
}

type codexWireEnvelope struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *CodexRPCError  `json:"error"`
}

func (c *CodexAppServerClient) dispatchLine(cmd *exec.Cmd, dispatcher *codexRPCDispatch, line []byte) error {
	var wire codexWireEnvelope
	if err := json.Unmarshal(line, &wire); err != nil {
		return NewError("codex_app_server_invalid_message", http.StatusBadGateway, nil)
	}
	var id any
	if len(wire.ID) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(wire.ID))
		decoder.UseNumber()
		if err := decoder.Decode(&id); err != nil {
			return NewError("codex_app_server_invalid_message", http.StatusBadGateway, nil)
		}
	}
	method := strings.TrimSpace(wire.Method)
	c.mu.Lock()
	if c.cmd != cmd {
		c.mu.Unlock()
		return nil
	}
	if len(wire.ID) > 0 && method == "" {
		key := canonicalRPCIDKey(id)
		ch := c.pending[key]
		delete(c.pending, key)
		c.mu.Unlock()
		if ch == nil {
			return nil
		}
		result := codexRPCResult{}
		if wire.Error != nil {
			result.err = NewErrorWithMessage("codex_app_server_rpc_error", http.StatusBadGateway, wire.Error.Error(), map[string]any{"rpcCode": wire.Error.Code})
		} else if len(wire.Result) > 0 {
			decoder := json.NewDecoder(bytes.NewReader(wire.Result))
			decoder.UseNumber()
			if err := decoder.Decode(&result.result); err != nil {
				result.err = NewError("codex_app_server_invalid_response", http.StatusBadGateway, nil)
			}
		}
		ch <- result
		close(ch)
		return nil
	}
	c.mu.Unlock()
	if method == "" {
		return nil
	}
	var route struct {
		ThreadID string `json:"threadId"`
		Thread   *struct {
			ThreadID string `json:"threadId"`
		} `json:"turn"`
	}
	if len(wire.Params) > 0 && json.Unmarshal(wire.Params, &route) != nil {
		return NewError("codex_app_server_invalid_message", http.StatusBadGateway, nil)
	}
	threadID := strings.TrimSpace(route.ThreadID)
	if threadID == "" && route.Thread != nil {
		threadID = strings.TrimSpace(route.Thread.ThreadID)
	}
	c.mu.Lock()
	if c.cmd != cmd {
		c.mu.Unlock()
		return nil
	}
	if method == "thread/closed" {
		c.observeThreadClosedLocked(threadID)
	}
	registration := c.bindings[threadID]
	if threadID == "" && len(c.bindings) == 1 {
		for _, binding := range c.bindings {
			registration = binding
		}
	}
	c.mu.Unlock()
	serverRequest := len(wire.ID) > 0
	if !serverRequest && (registration == nil || registration.binding.OnNotification == nil) {
		return nil
	}
	if serverRequest && registration != nil && registration.binding.OnServerRequest == nil {
		registration = nil
	}
	if !dispatcher.enqueue(codexQueuedNotification{id: id, method: method, params: wire.Params, registration: registration, serverRequest: serverRequest, bytes: len(line)}) {
		return NewError("codex_app_server_notification_overflow", http.StatusServiceUnavailable, nil)
	}
	return nil
}
