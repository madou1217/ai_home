package requirements

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// RefineSystemPrompt 是需求优化模型的系统提示。
const RefineSystemPrompt = "你是需求分析器。把用户的一段需求整理成清晰、可执行、可验收的步骤。" +
	"只输出一个 JSON 对象，不要代码块，不要额外解释。格式：" +
	"{\"title\":\"简短标题\",\"summary\":\"一句话目标\",\"steps\":[{\"text\":\"步骤\"}],\"acceptance\":[\"验收标准\"]}"

// BuildRefinePrompt 把需求与工作区上下文交给模型。
func BuildRefinePrompt(requirement Requirement, workspace Workspace) string {
	var builder strings.Builder
	builder.WriteString("原始需求：\n")
	builder.WriteString(requirement.Title)
	builder.WriteString("\n")
	if description := strings.TrimSpace(requirement.Description); description != "" {
		builder.WriteString(description)
		builder.WriteString("\n")
	}
	builder.WriteString("\n工作区项目路径：\n")
	for _, path := range workspace.ProjectPaths {
		builder.WriteString("- " + path + "\n")
	}
	builder.WriteString("\n要求：\n")
	builder.WriteString("1. 步骤必须能由 AI 在工程环境中直接执行（读代码、改代码、跑验证）。\n")
	builder.WriteString("2. 步骤按依赖顺序编号，通常 3 到 8 步。\n")
	builder.WriteString("3. 验收标准要可观察、可验证，不要写空泛描述。\n")
	builder.WriteString("4. 不要扩展原始需求的范围。\n")
	return builder.String()
}

type refinementPayload struct {
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Steps   []struct {
		Text string `json:"text"`
	} `json:"steps"`
	Acceptance []string `json:"acceptance"`
}

var numberedLinePattern = regexp.MustCompile(`^\s*(?:[-*+]\s*)?(?:\d+[.)、]\s*)?`)

// ParseRefinement 解析模型输出；JSON 失败时退化为按行提取。
func ParseRefinement(output string, fallbackTitle string) (string, string, []Step, []string) {
	cleaned := strings.TrimSpace(output)
	cleaned = strings.TrimPrefix(cleaned, "```json")
	cleaned = strings.TrimPrefix(cleaned, "```")
	cleaned = strings.TrimSuffix(cleaned, "```")
	cleaned = strings.TrimSpace(cleaned)
	start := strings.Index(cleaned, "{")
	end := strings.LastIndex(cleaned, "}")
	if start >= 0 && end > start {
		var payload refinementPayload
		if json.Unmarshal([]byte(cleaned[start:end+1]), &payload) == nil {
			title := strings.TrimSpace(payload.Title)
			if title == "" {
				title = fallbackTitle
			}
			steps := make([]Step, 0, len(payload.Steps))
			for _, step := range payload.Steps {
				if text := strings.TrimSpace(step.Text); text != "" {
					steps = append(steps, Step{Text: text, Status: "pending"})
				}
			}
			return title, strings.TrimSpace(payload.Summary), steps, payload.Acceptance
		}
	}
	// 退化为按行拆解：模型偶尔会不守 JSON 协议。
	steps := []Step{}
	for _, line := range strings.Split(cleaned, "\n") {
		line = strings.TrimSpace(numberedLinePattern.ReplaceAllString(line, ""))
		line = strings.TrimSpace(strings.Trim(line, "`"))
		if len([]rune(line)) < 4 {
			continue
		}
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "title") || strings.HasPrefix(lower, "summary") || strings.HasPrefix(lower, "acceptance") || line == "{" || line == "}" {
			continue
		}
		steps = append(steps, Step{Text: line, Status: "pending"})
	}
	return fallbackTitle, "", steps, nil
}

func composeRefinedDescription(original, summary string, steps []Step, acceptance []string) string {
	var builder strings.Builder
	summary = strings.TrimSpace(summary)
	if summary != "" {
		builder.WriteString(summary)
		builder.WriteString("\n\n")
	}
	builder.WriteString("执行步骤：\n")
	for index, step := range steps {
		builder.WriteString(fmt.Sprintf("%d. %s\n", index+1, step.Text))
	}
	if len(acceptance) > 0 {
		builder.WriteString("\n验收标准：\n")
		for _, item := range acceptance {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			builder.WriteString("- " + item + "\n")
		}
	}
	if builder.Len() == 0 {
		return strings.TrimSpace(original)
	}
	if original = strings.TrimSpace(original); original != "" && !strings.Contains(builder.String(), original) {
		builder.WriteString("\n原始描述：\n")
		builder.WriteString(original)
	}
	return strings.TrimSpace(builder.String())
}
