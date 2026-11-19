package codexappserverws

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// SessionHeaderConfigKey 是终端会话身份在 provider 配置中的位置。
func SessionHeaderConfigKey(args []string) (key, value string) {
	for _, arg := range args {
		trimmed := strings.TrimSpace(arg)
		if !strings.HasPrefix(trimmed, "model_providers.") || !strings.Contains(trimmed, ".http_headers.X-Session-Id=") {
			continue
		}
		parts := strings.SplitN(trimmed, "=", 2)
		if len(parts) != 2 {
			continue
		}
		return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
	}
	return "", ""
}

// StripSessionHeaderArgs 移除会话身份覆盖项，使多个终端可以共享同一后端。
func StripSessionHeaderArgs(args []string) []string {
	out := make([]string, 0, len(args))
	skipNext := false
	for i, arg := range args {
		if skipNext {
			skipNext = false
			continue
		}
		trimmed := strings.TrimSpace(arg)
		if trimmed == "-c" || trimmed == "--config" {
			if i+1 < len(args) {
				next := strings.TrimSpace(args[i+1])
				if strings.HasPrefix(next, "model_providers.") && strings.Contains(next, ".http_headers.X-Session-Id=") {
					skipNext = true
					continue
				}
			}
			out = append(out, arg)
			continue
		}
		if strings.HasPrefix(trimmed, "-c") && strings.Contains(trimmed, ".http_headers.X-Session-Id=") {
			continue
		}
		out = append(out, arg)
	}
	return out
}

// ThreadFilter 把共享 app-server 的广播限制在本终端拥有的线程上。
// 该类型只处理服务端 -> 客户端的报文；没有 threadId 的全局事件保持原样。
type ThreadFilter struct {
	mu      sync.Mutex
	owned   map[string]struct{}
	pending map[string]struct{}
	log     func(string)
}

func NewThreadFilter(log func(string)) *ThreadFilter {
	return &ThreadFilter{owned: map[string]struct{}{}, pending: map[string]struct{}{}, log: log}
}

// ObserveClientMessage 记录本终端发起的线程创建请求 id。
func (f *ThreadFilter) ObserveClientMessage(raw []byte) {
	if f == nil {
		return
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) != nil {
		return
	}
	var method string
	_ = json.Unmarshal(payload["method"], &method)
	switch method {
	case "thread/start", "thread/resume", "thread/fork":
	default:
		return
	}
	id := requestIDKey(payload["id"])
	if id == "" {
		return
	}
	f.mu.Lock()
	f.pending[id] = struct{}{}
	f.mu.Unlock()
}

// Allow 判断服务端报文是否可以转发给本终端。
func (f *ThreadFilter) Allow(raw []byte) bool {
	if f == nil {
		return true
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) != nil {
		return true
	}
	if _, isResponse := payload["method"]; !isResponse {
		f.observeResponse(payload)
		return true
	}
	if method, ok := payload["method"]; ok {
		var name string
		if json.Unmarshal(method, &name) == nil && name == "thread/started" {
			// 线程创建公告先于响应到达；放行以免终端错过自己的新线程。
			return true
		}
	}
	threadID := payloadThreadID(payload)
	if threadID == "" {
		return true
	}
	f.mu.Lock()
	_, ok := f.owned[threadID]
	f.mu.Unlock()
	return ok
}

func (f *ThreadFilter) observeResponse(payload map[string]json.RawMessage) {
	id := requestIDKey(payload["id"])
	if id == "" {
		return
	}
	f.mu.Lock()
	_, pending := f.pending[id]
	f.mu.Unlock()
	if !pending {
		return
	}
	threadID := responseThreadID(payload["result"])
	f.mu.Lock()
	delete(f.pending, id)
	if threadID != "" {
		f.owned[threadID] = struct{}{}
	}
	f.mu.Unlock()
}

func requestIDKey(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return "s:" + text
	}
	var num json.Number
	if json.Unmarshal(raw, &num) == nil {
		return "n:" + num.String()
	}
	return ""
}

func responseThreadID(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(raw, &result) != nil {
		return ""
	}
	if threadID := jsonString(result["threadId"]); threadID != "" {
		return threadID
	}
	var thread map[string]json.RawMessage
	if json.Unmarshal(result["thread"], &thread) == nil {
		if threadID := jsonString(thread["id"]); threadID != "" {
			return threadID
		}
	}
	if threadID := jsonString(result["id"]); threadID != "" {
		return threadID
	}
	return ""
}

func payloadThreadID(payload map[string]json.RawMessage) string {
	raw := payload["params"]
	if len(raw) == 0 {
		return ""
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(raw, &params) != nil {
		return ""
	}
	if threadID := jsonString(params["threadId"]); threadID != "" {
		return threadID
	}
	var thread map[string]json.RawMessage
	if json.Unmarshal(params["thread"], &thread) == nil {
		return jsonString(thread["id"])
	}
	return ""
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return ""
	}
	return strings.TrimSpace(text)
}

// ReadBackendPort 从 app-server 的 ws 启动日志里读取实际绑定端口。
func ReadBackendPort(logPath string, timeout time.Duration) (int, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if port, ok := scanBackendPort(logPath); ok {
			return port, true
		}
		time.Sleep(60 * time.Millisecond)
	}
	return 0, false
}

func scanBackendPort(logPath string) (int, bool) {
	file, err := os.Open(filepath.Clean(logPath))
	if err != nil {
		return 0, false
	}
	defer file.Close()
	if info, err := file.Stat(); err == nil && info.Size() > 1<<20 {
		if _, err := file.Seek(info.Size()-(1<<20), 0); err != nil {
			return 0, false
		}
	}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		index := strings.Index(line, "listening on: ws://127.0.0.1:")
		if index < 0 {
			continue
		}
		rest := line[index+len("listening on: ws://127.0.0.1:"):]
		end := 0
		for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
			end++
		}
		if end == 0 {
			continue
		}
		port := 0
		for _, ch := range rest[:end] {
			port = port*10 + int(ch-'0')
		}
		if port > 0 && port < 65536 {
			return port, true
		}
	}
	return 0, false
}

var _ = websocket.MessageText
