package requirements

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Loop 完成信号。Agent 在最终回复中使用固定标记，调度器据此自动停止；
// 没有标记时才调用 AI 验收员判断，避免硬编码轮次。
const (
	LoopDoneMarker     = "[[REQUIREMENT_DONE]]"
	LoopContinueMarker = "[[REQUIREMENT_CONTINUE]]"
	// LoopSafetyLimit 是极端情况下防止进程无限循环的安全网，不是业务轮次语义。
	LoopSafetyLimit = 50
)

// LoopDecision 是 AI 验收员的输出。
type LoopDecision struct {
	Done   bool   `json:"done"`
	Reason string `json:"reason"`
	Next   string `json:"next"`
}

// LoopJudgeSystemPrompt 要求模型只输出完成判定 JSON。
// 某些 Provider（AGY）不上报结构化工具事件，此时最终回复中的具体产物与验证描述
// 是唯一可用的完成证据，不能仅因缺少 tool 事件就否定。
const LoopJudgeSystemPrompt = "你是严格但务实的需求验收员。根据需求、验收标准、执行步骤和本轮最终回复判断是否完成。" +
	"某些 Provider（例如 AGY）不会上报结构化工具事件；此时最终回复中明确给出具体产物、文件或验证结果即可作为完成证据，" +
	"不要仅因缺少工具事件就判未完成。只有当证据不足、与需求矛盾或明确还有未完成项时才判 false。" +
	"只输出 JSON：{\"done\":true|false,\"reason\":\"判定依据\",\"next\":\"若未完成，下一轮应做什么\"}"

// BuildLoopJudgePrompt 组装验收上下文。
func BuildLoopJudgePrompt(requirement Requirement, finalMessage string, hadWork bool) string {
	var builder strings.Builder
	builder.WriteString("## 需求\n")
	builder.WriteString(requirement.Title)
	builder.WriteString("\n\n")
	if description := strings.TrimSpace(requirement.Description); description != "" {
		builder.WriteString("## 描述与验收标准\n")
		builder.WriteString(description)
		builder.WriteString("\n\n")
	}
	if len(requirement.Steps) > 0 {
		builder.WriteString("## 步骤状态\n")
		for index, step := range requirement.Steps {
			builder.WriteString(fmt.Sprintf("%d. [%s] %s\n", index+1, step.Status, step.Text))
		}
		builder.WriteString("\n")
	}
	if hadWork {
		builder.WriteString("## 本轮工具事件\n本轮检测到工具/文件变更。\n\n")
	} else {
		builder.WriteString("## 本轮工具事件\nProvider 未上报结构化工具事件；请结合最终回复中的具体产物与验证描述判断。\n\n")
	}
	builder.WriteString("## 本轮最终回复\n")
	if trimmed := strings.TrimSpace(finalMessage); trimmed != "" {
		builder.WriteString(truncateRunes(trimmed, 12000))
	} else {
		builder.WriteString("（没有 assistant 文本）")
	}
	builder.WriteString("\n\n请判断是否完成。")
	return builder.String()
}

// HasLoopMarker 判断最终回复是否带有完成/继续标记。
func HasLoopMarker(message, marker string) bool {
	return strings.Contains(strings.ToUpper(message), strings.ToUpper(marker))
}

// ParseLoopDecision 解析验收员 JSON；无法解析时返回 ok=false。
func ParseLoopDecision(output string) (LoopDecision, bool) {
	cleaned := strings.TrimSpace(output)
	cleaned = strings.TrimPrefix(cleaned, "```json")
	cleaned = strings.TrimPrefix(cleaned, "```")
	cleaned = strings.TrimSuffix(cleaned, "```")
	cleaned = strings.TrimSpace(cleaned)
	start := strings.Index(cleaned, "{")
	end := strings.LastIndex(cleaned, "}")
	if start >= 0 && end > start {
		var decision LoopDecision
		if json.Unmarshal([]byte(cleaned[start:end+1]), &decision) == nil {
			decision.Reason = strings.TrimSpace(decision.Reason)
			decision.Next = strings.TrimSpace(decision.Next)
			return decision, true
		}
	}
	lower := strings.ToLower(cleaned)
	switch {
	case strings.Contains(lower, "done") && strings.Contains(lower, "true"):
		return LoopDecision{Done: true, Reason: truncateRunes(cleaned, 200)}, true
	case strings.Contains(lower, "done") && strings.Contains(lower, "false"):
		return LoopDecision{Done: false, Next: truncateRunes(cleaned, 400)}, true
	default:
		return LoopDecision{}, false
	}
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
