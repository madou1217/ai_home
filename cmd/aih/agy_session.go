package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const agySessionUsage = `aih agy session — 一条需求一个常驻 AGY 会话（不是一次性 --print）

  aih agy session open "<需求>" --model <模型> --connection <id|标签> --root <远端目录>
                           [--title 标题] [--effort low|medium|high|xhigh|max]
                           [--account-home <远端 HOME>] [--binary <远端 agy 路径>] [--local] [--json]
  aih agy session ls [--json]
  aih agy session show <会话ID> [--json]
  aih agy session say <会话ID> "内容" [--no-wait] [--json]
  aih agy session tail <会话ID> [--after N] [--follow]
  aih agy session resume <会话ID>
  aih agy session close <会话ID>

  aih agy acp [--cwd <目录>] [--command <agy>] [--model <模型>] [--effort low|medium|high|xhigh]
              [--timeout <时长>] [--auto-approve] "<提示词>"
                           用 ACP 直接驱动 AGY，暴露 read/write/run_command/审批

说明：
  - 会话进程常驻：同一进程连续跑多轮，上下文不靠重启恢复；进程退出后 resume 用
    --conversation 续接。
  - 会话同时是 peer 目标（通道 agy-session），因此也可以用
    aih peer send "<会话>" "..." 投递，回复会写回原发送会话。
  - 远端执行依赖已保存的 SSH 连接；--connection 支持连接 id 或标签（例如 AWS）。
`

type agySessionClient struct {
	runtime commandRuntime
	baseURL string
	key     string
	// httpClient 给会话创建/对话用更长的超时：远端首连 + 起管道 + 首轮投递可能超过通用 30s。
	httpClient *http.Client
}

func newAGYSessionClient(runtime commandRuntime) (*agySessionClient, error) {
	key := envValue(runtime, "AIH_SERVER_MANAGEMENT_KEY")
	if key == "" {
		return nil, fmt.Errorf("需要 Management Key；请先在 WebUI 授权本机 Server")
	}
	client := &http.Client{Timeout: 150 * time.Second}
	if shared, ok := runtime.managementAPI.(*http.Client); ok {
		copy := *shared
		copy.Timeout = 150 * time.Second
		client = &copy
	}
	return &agySessionClient{
		runtime:    runtime,
		baseURL:    strings.TrimRight(resolveManagementBaseURL(runtime), "/"),
		key:        key,
		httpClient: client,
	}, nil
}

func (client *agySessionClient) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+client.key)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

type agySessionView struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Goal           string `json:"goal"`
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	Status         string `json:"status"`
	RemoteRoot     string `json:"remoteRoot"`
	ConnectionID   string `json:"connectionId"`
	ConversationID string `json:"conversationId"`
	LastError      string `json:"lastError"`
	LastReply      string `json:"lastReply"`
	TurnCount      int    `json:"turnCount"`
	Alive          bool   `json:"alive"`
	PeerTarget     string `json:"peerTarget"`
	Current        *struct {
		ID    int64  `json:"id"`
		State string `json:"state"`
	} `json:"current"`
}

type agySessionEvent struct {
	Seq    int64  `json:"seq"`
	TurnID int64  `json:"turnId"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Status string `json:"status"`
	Tool   string `json:"tool"`
}

// runAGYCommand 是 `aih agy ...` 的唯一入口；未命中时返回 handled=false。
func runAGYCommand(ctx context.Context, args []string, runtime commandRuntime) (bool, error) {
	if len(args) == 0 || args[0] != "agy" {
		return false, nil
	}
	if len(args) >= 2 && args[1] == "acp" {
		return true, runAGYACPCommand(ctx, args[2:], runtime)
	}
	if len(args) < 3 || args[1] != "session" || args[2] == "--help" || args[2] == "-h" {
		_, _ = io.WriteString(runtime.stdout, agySessionUsage)
		return true, nil
	}
	verb := strings.ToLower(strings.TrimSpace(args[2]))
	rest := args[3:]
	positionals, values, flags := parseAGYSessionArgs(rest)
	client, err := newAGYSessionClient(runtime)
	if err != nil {
		return true, err
	}
	jsonOut := flags["json"]
	switch verb {
	case "open":
		if len(positionals) == 0 {
			return true, fmt.Errorf("用法：aih agy session open \"<需求>\" --model <模型> --connection <id|标签> --root <目录>")
		}
		return true, runAGYSessionOpen(ctx, client, strings.Join(positionals, " "), values, flags, runtime, jsonOut)
	case "ls", "list":
		var result struct {
			Sessions []agySessionView `json:"sessions"`
		}
		if err := client.do(ctx, http.MethodGet, "/v1/management/agy-sessions", nil, &result); err != nil {
			return true, err
		}
		if jsonOut {
			return true, writeJSONOutput(runtime, map[string]any{"sessions": result.Sessions})
		}
		if len(result.Sessions) == 0 {
			_, _ = fmt.Fprintln(runtime.stdout, "暂无 AGY 会话。用 aih agy session open 开启。")
			return true, nil
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%-16s %-8s %-26s %-6s %s\n", "会话", "状态", "模型", "轮数", "标题 / 目录")
		for _, session := range result.Sessions {
			_, _ = fmt.Fprintf(runtime.stdout, "%-16s %-8s %-26s %-6d %s · %s\n",
				session.ID, session.Status, session.Model, session.TurnCount, session.Title, session.RemoteRoot)
		}
		return true, nil
	case "show":
		view, err := fetchAGYSession(ctx, client, firstPositional(positionals))
		if err != nil {
			return true, err
		}
		if jsonOut {
			return true, writeJSONOutput(runtime, view)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "会话 %s\n  标题: %s\n  状态: %s  存活: %v  轮数: %d\n  模型: %s  目录: %s\n  conversation: %s\n  peer: %s\n",
			view.ID, view.Title, view.Status, view.Alive, view.TurnCount, view.Model, view.RemoteRoot, view.ConversationID, view.PeerTarget)
		if view.LastError != "" {
			_, _ = fmt.Fprintf(runtime.stdout, "  最近错误: %s\n", view.LastError)
		}
		return true, nil
	case "say", "send":
		if len(positionals) < 2 {
			return true, fmt.Errorf("用法：aih agy session say <会话ID> \"内容\"")
		}
		sessionID := positionals[0]
		content := strings.Join(positionals[1:], " ")
		var submitted struct {
			TurnID int64 `json:"turnId"`
		}
		if err := client.do(ctx, http.MethodPost, "/v1/management/agy-sessions/"+url.PathEscape(sessionID)+"/messages",
			map[string]any{"content": content}, &submitted); err != nil {
			return true, err
		}
		if jsonOut {
			return true, writeJSONOutput(runtime, submitted)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "已投递第 %d 轮\n", submitted.TurnID)
		if flags["no-wait"] {
			return true, nil
		}
		return true, streamAGYTurn(ctx, client, sessionID, submitted.TurnID, runtime)
	case "tail":
		sessionID := firstPositional(positionals)
		if sessionID == "" {
			return true, fmt.Errorf("用法：aih agy session tail <会话ID> [--after N] [--follow]")
		}
		after, _ := strconv.ParseInt(values["after"], 10, 64)
		return true, streamAGYEvents(ctx, client, sessionID, after, flags["follow"], runtime, jsonOut)
	case "resume":
		sessionID := firstPositional(positionals)
		if sessionID == "" {
			return true, fmt.Errorf("用法：aih agy session resume <会话ID>")
		}
		view := agySessionView{}
		if err := client.do(ctx, http.MethodPost, "/v1/management/agy-sessions/"+url.PathEscape(sessionID)+"/resume", nil, &struct {
			Session *agySessionView `json:"session"`
		}{Session: &view}); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintf(runtime.stdout, "会话 %s 已恢复（存活=%v）\n", view.ID, view.Alive)
		return true, nil
	case "close":
		sessionID := firstPositional(positionals)
		if sessionID == "" {
			return true, fmt.Errorf("用法：aih agy session close <会话ID>")
		}
		if err := client.do(ctx, http.MethodPost, "/v1/management/agy-sessions/"+url.PathEscape(sessionID)+"/close", nil, nil); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintf(runtime.stdout, "会话 %s 已关闭（记录保留，可 resume）\n", sessionID)
		return true, nil
	default:
		return true, fmt.Errorf("未知的 agy session 子命令：%s", verb)
	}
}

func runAGYSessionOpen(
	ctx context.Context, client *agySessionClient, goal string,
	values map[string]string, flags map[string]bool, runtime commandRuntime, jsonOut bool,
) error {
	model := strings.TrimSpace(values["model"])
	if model == "" {
		return fmt.Errorf("必须指定 --model（例如 gemini-4-neon-xhigh）")
	}
	input := map[string]any{
		"goal":         goal,
		"title":        strings.TrimSpace(values["title"]),
		"model":        model,
		"effort":       strings.TrimSpace(values["effort"]),
		"connectionId": strings.TrimSpace(values["connection"]),
		"remoteRoot":   strings.TrimSpace(values["root"]),
		"accountHome":  strings.TrimSpace(values["account-home"]),
		"binary":       strings.TrimSpace(values["binary"]),
		"local":        flags["local"],
	}
	var result struct {
		Session agySessionView `json:"session"`
	}
	if err := client.do(ctx, http.MethodPost, "/v1/management/agy-sessions", input, &result); err != nil {
		return err
	}
	if jsonOut {
		return writeJSONOutput(runtime, result.Session)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "会话 %s 已开启（模型 %s，目录 %s）\npeer 目标：%s\n",
		result.Session.ID, result.Session.Model, result.Session.RemoteRoot, result.Session.PeerTarget)
	_, _ = fmt.Fprintf(runtime.stdout, "第一条需求已作为第 1 轮发出；用 aih agy session tail %s --follow 观察，或 aih agy session say %s \"...\" 继续对话。\n",
		result.Session.ID, result.Session.ID)
	return nil
}

// streamAGYTurn 读到本轮出现 result/error 为止，边读边打印增量。
func streamAGYTurn(ctx context.Context, client *agySessionClient, sessionID string, turnID int64, runtime commandRuntime) error {
	cursor := int64(0)
	deadline := time.Now().Add(30 * time.Minute)
	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("等待超时；会话仍在后台执行，可用 tail --follow 继续观察")
		}
		var result struct {
			Events []agySessionEvent `json:"events"`
			Cursor int64             `json:"cursor"`
		}
		query := fmt.Sprintf("/v1/management/agy-sessions/%s/events?after=%d", url.PathEscape(sessionID), cursor)
		if err := client.do(ctx, http.MethodGet, query, nil, &result); err != nil {
			return err
		}
		cursor = result.Cursor
		for _, event := range result.Events {
			if event.TurnID != turnID {
				continue
			}
			switch event.Kind {
			case "delta":
				_, _ = io.WriteString(runtime.stdout, event.Text)
			case "process":
				if event.Tool != "" {
					_, _ = fmt.Fprintf(runtime.stderr, "[tool] %s\n", event.Tool)
				}
			case "result":
				_, _ = fmt.Fprintln(runtime.stdout)
				return nil
			case "error":
				_, _ = fmt.Fprintln(runtime.stdout)
				return fmt.Errorf("本轮失败：%s", event.Text)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1200 * time.Millisecond):
		}
	}
}

func streamAGYEvents(ctx context.Context, client *agySessionClient, sessionID string, after int64, follow bool, runtime commandRuntime, jsonOut bool) error {
	cursor := after
	for {
		var result struct {
			Events []agySessionEvent `json:"events"`
			Cursor int64             `json:"cursor"`
		}
		query := fmt.Sprintf("/v1/management/agy-sessions/%s/events?after=%d", url.PathEscape(sessionID), cursor)
		if err := client.do(ctx, http.MethodGet, query, nil, &result); err != nil {
			return err
		}
		for _, event := range result.Events {
			cursor = event.Seq
			if jsonOut {
				if err := writeJSONOutput(runtime, event); err != nil {
					return err
				}
				continue
			}
			switch event.Kind {
			case "delta":
				_, _ = io.WriteString(runtime.stdout, event.Text)
			case "result":
				_, _ = fmt.Fprintf(runtime.stdout, "\n[turn %d %s]\n", event.TurnID, event.Kind)
			case "error":
				_, _ = fmt.Fprintf(runtime.stdout, "\n[turn %d 失败: %s]\n", event.TurnID, event.Text)
			case "process":
				_, _ = fmt.Fprintf(runtime.stdout, "[%s %s %s]\n", event.Kind, event.Status, event.Tool)
			case "turn-start":
				_, _ = fmt.Fprintf(runtime.stdout, "[turn %d 开始]\n", event.TurnID)
			}
		}
		if result.Cursor > cursor {
			cursor = result.Cursor
		}
		if !follow {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1200 * time.Millisecond):
		}
	}
}

func fetchAGYSession(ctx context.Context, client *agySessionClient, id string) (agySessionView, error) {
	if strings.TrimSpace(id) == "" {
		return agySessionView{}, fmt.Errorf("用法：aih agy session show <会话ID>")
	}
	var result struct {
		Session agySessionView `json:"session"`
	}
	err := client.do(ctx, http.MethodGet, "/v1/management/agy-sessions/"+url.PathEscape(id), nil, &result)
	return result.Session, err
}

func writeJSONOutput(runtime commandRuntime, value any) error {
	encoder := json.NewEncoder(runtime.stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func firstPositional(positionals []string) string {
	if len(positionals) == 0 {
		return ""
	}
	return positionals[0]
}

// parseAGYSessionArgs 解析 --flag value 与布尔 --flag，位置参数保持顺序。
func parseAGYSessionArgs(args []string) ([]string, map[string]string, map[string]bool) {
	values := map[string]string{}
	flags := map[string]bool{}
	positionals := []string{}
	booleanFlags := map[string]bool{"json": true, "local": true, "follow": true, "no-wait": true, "help": true}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			positionals = append(positionals, arg)
			continue
		}
		name := strings.TrimPrefix(arg, "--")
		if equals := strings.Index(name, "="); equals >= 0 {
			values[name[:equals]] = name[equals+1:]
			continue
		}
		if booleanFlags[name] {
			flags[name] = true
			continue
		}
		if index+1 < len(args) && !strings.HasPrefix(args[index+1], "--") {
			values[name] = args[index+1]
			index++
			continue
		}
		flags[name] = true
	}
	return positionals, values, flags
}
