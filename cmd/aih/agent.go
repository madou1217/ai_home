package main

import (
	"fmt"
	"io"
	"strings"
)

// agentSupport 是交互支持级别；reason/evidence 为空时输出 null，与 Node 合同一致。
type agentSupport struct {
	Level    string  `json:"level"`
	Reason   *string `json:"reason"`
	Evidence *string `json:"evidence"`
}

type agentInteractions struct {
	Approval         agentSupport `json:"approval"`
	Question         agentSupport `json:"question"`
	PlanConfirmation agentSupport `json:"plan_confirmation"`
}

type agentAdapterCapability struct {
	Adapter      string            `json:"adapter"`
	Label        string            `json:"label"`
	Transport    string            `json:"transport"`
	Interactions agentInteractions `json:"interactions"`
	Note         string            `json:"note"`
}

type agentHarnessRow struct {
	Provider   string   `json:"provider"`
	Label      string   `json:"label"`
	Candidates []string `json:"-"`
	Phase      int      `json:"phase"`
	Note       string   `json:"note"`
}

type agentExcluded struct {
	Provider string `json:"provider"`
	Reason   string `json:"reason"`
}

type agentCandidateView struct {
	AdapterID    string                  `json:"adapterId"`
	Implemented  bool                    `json:"implemented"`
	Capabilities *agentAdapterCapability `json:"capabilities"`
}

type agentProviderView struct {
	Provider   string               `json:"provider"`
	Label      string               `json:"label"`
	Phase      int                  `json:"phase"`
	Note       string               `json:"note"`
	Candidates []agentCandidateView `json:"candidates"`
}

func agentSupportOf(level, reason, evidence string) agentSupport {
	support := agentSupport{Level: level}
	if reason != "" {
		support.Reason = &reason
	}
	if evidence != "" {
		support.Evidence = &evidence
	}
	return support
}

var agentAdapterCapabilities = []agentAdapterCapability{
	{
		Adapter: "acp-stdio", Label: "ACP (stdio)", Transport: "acp-stdio",
		Interactions: agentInteractions{
			Approval:         agentSupportOf("native", "", "ACP session/request_permission（lib/server/acp-session-runner.js requestPermissionFromSurface）"),
			Question:         agentSupportOf("unsupported", "ACP 没有提问方法，只能靠 permission 选项承载", ""),
			PlanConfirmation: agentSupportOf("unsupported", "ACP 没有计划确认方法", ""),
		},
		Note: "NDJSON over stdio；entry 参数由 lib/runtime/acp-layouts.js 决定",
	},
	{
		Adapter: "acp-http-sse", Label: "ACP (HTTP/SSE)", Transport: "acp-http-sse",
		Interactions: agentInteractions{
			Approval:         agentSupportOf("native", "", "codebuddy --serve 的 HTTP/SSE 通道承载同一 session/request_permission"),
			Question:         agentSupportOf("unsupported", "ACP 没有提问方法", ""),
			PlanConfirmation: agentSupportOf("unsupported", "ACP 没有计划确认方法", ""),
		},
		Note: "同一个 ACP 合同，传输换成 HTTP + SSE",
	},
	{
		Adapter: "codex-app-server", Label: "Codex app-server", Transport: "codex-app-server",
		Interactions: agentInteractions{
			Approval:         agentSupportOf("native", "", "item/commandExecution|fileChange|permissions/requestApproval（lib/server/codex-app-server-protocol.js）"),
			Question:         agentSupportOf("native", "", "item/tool/requestUserInput（lib/server/chat-runtime/codex-interaction-request-adapter.js）"),
			PlanConfirmation: agentSupportOf("native", "", "turn/plan/updated + plan 模式审批策略（APPROVAL_MODE_POLICIES.plan）"),
		},
		Note: "WS JSON-RPC；比 PTY 探测可靠，且带 turn id",
	},
	{
		Adapter: "claude-stream-mcp", Label: "Claude stream-json + MCP", Transport: "claude-stream-mcp",
		Interactions: agentInteractions{
			Approval:         agentSupportOf("native", "", "--permission-prompt-tool mcp__aih__approve（lib/server/claude-permission-mcp-tool.js）"),
			Question:         agentSupportOf("emulated", "AskUserQuestion 工具调用被 permission tool 截获后转成 question", "claude-permission-mcp-tool 的 tool_name 分流"),
			PlanConfirmation: agentSupportOf("emulated", "ExitPlanMode 走同一 permission tool，映射成 plan_confirmation", "claudeApprovalArgs --permission-mode plan（lib/server/native-approval-modes.js）"),
		},
		Note: "结构化输出 + 回调式审批；不需要读屏",
	},
	{
		Adapter: "opencode-serve", Label: "OpenCode serve", Transport: "opencode-serve",
		Interactions: agentInteractions{
			Approval:         agentSupportOf("native", "", "SSE permission.asked + POST /permission/:id/reply（lib/server/chat-runtime/native-approval-transports.js）"),
			Question:         agentSupportOf("unsupported", "opencode serve 没有提问端点", ""),
			PlanConfirmation: agentSupportOf("unsupported", "opencode serve 没有计划确认端点", ""),
		},
		Note: "本地 server + SSE；比 ACP 兼容层稳",
	},
	{
		Adapter: "pty", Label: "PTY 屏幕探测", Transport: "pty",
		Interactions: agentInteractions{
			Approval:         agentSupportOf("emulated", "从终端屏幕文本识别确认提示，按序号/按键回写", "lib/protocol/native-interactive-prompts.js parseConfirmPrompt/parseNumberedChoicePrompt"),
			Question:         agentSupportOf("emulated", "识别编号选项提示后回写选项", "lib/protocol/native-interactive-prompts.js parseNumberedChoicePrompt"),
			PlanConfirmation: agentSupportOf("emulated", "识别 plan 选择提示后回写选项", "lib/protocol/native-interactive-prompts.js parseCodexPlanChoiceOptions"),
		},
		Note: "最后兜底：没有协议端点、或端点未装时才用；误判风险最高",
	},
}

var agentHarnessRows = []agentHarnessRow{
	{Provider: "codex", Label: "Codex", Candidates: []string{"codex-app-server", "pty"}, Phase: 2, Note: "app-server 包装器；PTY 兜底"},
	{Provider: "claude", Label: "Claude Code", Candidates: []string{"claude-stream-mcp", "pty"}, Phase: 3, Note: "permission-prompt-tool 承载 approval/question/plan"},
	{Provider: "gemini", Label: "Gemini CLI", Candidates: []string{"acp-stdio"}, Phase: 1, Note: "--acp 已验证"},
	{Provider: "cline", Label: "Cline", Candidates: []string{"acp-stdio"}, Phase: 1, Note: "--acp 已验证，resume 也走 ACP"},
	{Provider: "codebuddy", Label: "CodeBuddy", Candidates: []string{"acp-stdio"}, Phase: 1, Note: "--acp / --serve 已验证"},
	{Provider: "codebuddycn", Label: "CodeBuddy CN", Candidates: []string{"acp-stdio"}, Phase: 1, Note: "布局为推断，phase 1 需实测确认"},
	{Provider: "qoder", Label: "Qoder", Candidates: []string{"acp-stdio"}, Phase: 1, Note: "--acp 已验证；缺 acp_session 能力登记，见计划 §7"},
	{Provider: "qodercn", Label: "Qoder CN", Candidates: []string{"acp-stdio"}, Phase: 1, Note: "布局为推断，phase 1 需实测确认"},
	{Provider: "kimi", Label: "Kimi CLI", Candidates: []string{"acp-stdio"}, Phase: 5, Note: "有 ACP 布局与能力，但不在 native session 名单里，需先接线"},
	{Provider: "opencode", Label: "OpenCode", Candidates: []string{"opencode-serve", "acp-stdio"}, Phase: 4, Note: "serve 优先，ACP 兼容层兜底"},
	{Provider: "grok", Label: "Grok CLI", Candidates: []string{"pty", "acp-stdio"}, Phase: 5, Note: "当前只有 PTY；ACP 入口待账号通道"},
	{Provider: "agy", Label: "Antigravity CLI", Candidates: []string{"pty"}, Phase: 6, Note: "无 ACP、无审批通道"},
	{Provider: "kiro", Label: "Kiro", Candidates: []string{"pty"}, Phase: 6, Note: "无 ACP"},
	{Provider: "pi", Label: "pi", Candidates: []string{"pty"}, Phase: 7, Note: "外部 harness，无 ACP"},
	{Provider: "dsh-tui", Label: "dsh (TUI)", Candidates: []string{"pty"}, Phase: 7, Note: "外部 harness；dsh 的 web profile 不在范围内"},
}

var agentExcludedHarnesses = []agentExcluded{
	{Provider: "zcode", Reason: "desktop 会话（ZCode Desktop），不是 TUI harness"},
	{Provider: "workbuddy", Reason: "desktop 会话，审批在桌面进程内"},
	{Provider: "workbuddycn", Reason: "desktop 会话，审批在桌面进程内"},
	{Provider: "dsh", Reason: "外部 harness 的 web profile，不是 TUI 会话"},
}

// agentImplementedAdapters 与 lib/agent-session/adapters 的实现文件一致。
var agentImplementedAdapters = map[string]bool{
	"acp-stdio": true, "acp-http-sse": true, "codex-app-server": true,
	"claude-stream-mcp": true, "pty": true,
}

func runAgent(arguments []string, runtime commandRuntime) error {
	action := "adapters"
	provider := ""
	jsonOutput := false
	for _, token := range arguments {
		value := strings.TrimSpace(token)
		switch value {
		case "":
			continue
		case "--json":
			jsonOutput = true
		case "--help", "-h", "help":
			writeAgentUsage(runtime.stdout)
			return nil
		case "adapters", "list", "capabilities", "probe":
			action = value
		default:
			if strings.HasPrefix(value, "-") {
				continue
			}
			if provider == "" {
				provider = value
			}
		}
	}
	switch action {
	case "adapters", "list":
		if jsonOutput {
			type response struct {
				OK       bool                `json:"ok"`
				Adapters []agentProviderView `json:"adapters"`
				Excluded []agentExcluded     `json:"excluded"`
			}
			return writeJSONDocument(runtime.stdout, response{OK: true, Adapters: describeAllAgentProviders(), Excluded: agentExcludedHarnesses})
		}
		writeAgentAdapters(runtime.stdout)
	case "capabilities":
		if provider == "" {
			return fmt.Errorf("用法: aih agent capabilities <provider>")
		}
		view := describeAgentProvider(provider)
		if view == nil {
			return fmt.Errorf("未登记的 harness: %s（aih agent adapters 看全量）", provider)
		}
		if jsonOutput {
			type response struct {
				OK bool `json:"ok"`
				agentProviderView
			}
			return writeJSONDocument(runtime.stdout, response{OK: true, agentProviderView: *view})
		}
		writeAgentCapabilities(runtime.stdout, *view)
	case "probe":
		if provider == "" {
			return fmt.Errorf("用法: aih agent probe <provider>")
		}
		resolution, err := resolveAgentAdapter(provider)
		if err != nil {
			if jsonOutput {
				_ = writeJSONDocument(runtime.stdout, map[string]any{"ok": false, "provider": provider, "error": err.Error(), "attempted": []any{}})
			}
			return err
		}
		if jsonOutput {
			return writeJSONDocument(runtime.stdout, resolution)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%s -> %s (%s)\n", resolution["provider"], resolution["adapter"], resolution["transport"])
	default:
		return fmt.Errorf("未知子命令: %s（adapters | capabilities | probe）", action)
	}
	return nil
}

func writeAgentUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "aih agent - 每个 TUI harness 的会话适配层")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih agent [adapters] [--json]")
	_, _ = fmt.Fprintln(output, "  aih agent capabilities <provider> [--json]")
	_, _ = fmt.Fprintln(output, "  aih agent probe <provider> [--json]")
}

func describeAllAgentProviders() []agentProviderView {
	views := make([]agentProviderView, 0, len(agentHarnessRows))
	for _, row := range agentHarnessRows {
		view := describeAgentProvider(row.Provider)
		if view != nil {
			views = append(views, *view)
		}
	}
	return views
}

func describeAgentProvider(provider string) *agentProviderView {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	for _, row := range agentHarnessRows {
		if row.Provider != normalized {
			continue
		}
		view := agentProviderView{Provider: row.Provider, Label: row.Label, Phase: row.Phase, Note: row.Note}
		for _, adapterID := range row.Candidates {
			capability := agentCapabilityByID(adapterID)
			view.Candidates = append(view.Candidates, agentCandidateView{
				AdapterID:    adapterID,
				Implemented:  agentImplementedAdapters[adapterID],
				Capabilities: capability,
			})
		}
		return &view
	}
	return nil
}

func agentCapabilityByID(adapterID string) *agentAdapterCapability {
	for index := range agentAdapterCapabilities {
		if agentAdapterCapabilities[index].Adapter == adapterID {
			return &agentAdapterCapabilities[index]
		}
	}
	return nil
}

func resolveAgentAdapter(provider string) (map[string]any, error) {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	for _, excluded := range agentExcludedHarnesses {
		if excluded.Provider == normalized {
			return nil, fmt.Errorf("agent_session_harness_excluded")
		}
	}
	var row *agentHarnessRow
	for index := range agentHarnessRows {
		if agentHarnessRows[index].Provider == normalized {
			row = &agentHarnessRows[index]
			break
		}
	}
	if row == nil {
		return nil, fmt.Errorf("agent_session_harness_unknown")
	}
	attempted := make([]map[string]any, 0, len(row.Candidates))
	for _, adapterID := range row.Candidates {
		implemented := agentImplementedAdapters[adapterID]
		attempted = append(attempted, map[string]any{"adapterId": adapterID, "implemented": implemented})
		if implemented {
			capability := agentCapabilityByID(adapterID)
			transport := ""
			if capability != nil {
				transport = capability.Transport
			}
			return map[string]any{
				"ok":        true,
				"provider":  normalized,
				"adapter":   adapterID,
				"transport": transport,
				"attempted": attempted,
			}, nil
		}
	}
	return nil, fmt.Errorf("agent_session_adapter_unavailable")
}

func writeAgentAdapters(output io.Writer) {
	_, _ = fmt.Fprintln(output, "PROVIDER        PHASE  ADAPTER               STATE")
	for _, row := range describeAllAgentProviders() {
		for index, candidate := range row.Candidates {
			label := candidate.AdapterID
			if index > 0 {
				label += " (fallback)"
			}
			state := "planned"
			if candidate.Implemented {
				state = "ready"
			}
			_, _ = fmt.Fprintf(output, "%-14s  %-5d  %-20s  %s\n", row.Provider, row.Phase, label, state)
		}
	}
	if len(agentExcludedHarnesses) > 0 {
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "不登记（不在本层范围内）:")
		for _, row := range agentExcludedHarnesses {
			_, _ = fmt.Fprintf(output, "  %-14s %s\n", row.Provider, row.Reason)
		}
	}
}

func writeAgentCapabilities(output io.Writer, view agentProviderView) {
	_, _ = fmt.Fprintf(output, "%s (%s)  phase %d\n", view.Label, view.Provider, view.Phase)
	if strings.TrimSpace(view.Note) != "" {
		_, _ = fmt.Fprintf(output, "  %s\n", view.Note)
	}
	_, _ = fmt.Fprintln(output)
	for _, candidate := range view.Candidates {
		_, _ = fmt.Fprintln(output, candidate.AdapterID)
		_, _ = fmt.Fprintln(output, "KIND                LEVEL")
		if candidate.Capabilities == nil {
			continue
		}
		printAgentSupport(output, "审批", candidate.Capabilities.Interactions.Approval)
		printAgentSupport(output, "提问", candidate.Capabilities.Interactions.Question)
		printAgentSupport(output, "计划确认", candidate.Capabilities.Interactions.PlanConfirmation)
		_, _ = fmt.Fprintln(output)
	}
}

func printAgentSupport(output io.Writer, label string, support agentSupport) {
	detail := ""
	if support.Evidence != nil {
		detail = *support.Evidence
	} else if support.Reason != nil {
		detail = *support.Reason
	}
	if detail != "" {
		_, _ = fmt.Fprintf(output, "  %-18s%s  %s\n", label, support.Level, detail)
	} else {
		_, _ = fmt.Fprintf(output, "  %-18s%s\n", label, support.Level)
	}
}
