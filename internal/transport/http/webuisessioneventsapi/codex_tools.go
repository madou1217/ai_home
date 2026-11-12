package webuisessioneventsapi

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	chunkIDLinePattern = regexp.MustCompile(`^Chunk ID:\s*`)
	outputLinePattern  = regexp.MustCompile(`^Output:\s*(.*)$`)
)

// codexCallResult 是 exec_command_end 里可复用的结构化结果片段。
type codexCallResult struct {
	output    string
	parsedCmd []any
	cwd       string
}

func shouldSkipCodexFunctionCall(name string) bool {
	switch strings.TrimSpace(name) {
	case "write_stdin", "send_input", "resize_run_terminal", "read_thread_terminal":
		return true
	default:
		return false
	}
}

func isCodexGoalToolName(name string) bool {
	switch name {
	case "create_goal", "update_goal", "get_goal":
		return true
	default:
		return false
	}
}

// normalizeCodexFunctionCall 复刻 Node 的工具事件正文格式。
//
// 返回 false 表示该工具调用按 Node 口径应被跳过（交互式终端工具）。
func normalizeCodexFunctionCall(payload map[string]any, resultInfo *codexCallResult) (string, bool) {
	name := "Unknown"
	if truthy(payload["name"]) {
		name = jsString(payload["name"])
	}
	if shouldSkipCodexFunctionCall(name) {
		return "", false
	}
	args, rawArguments := parseFunctionArguments(payload["arguments"])

	toolName := name
	body := ""
	switch name {
	case "exec_command", "shell":
		var parsedPrimary map[string]any
		if resultInfo != nil && len(resultInfo.parsedCmd) > 0 {
			parsedPrimary, _ = resultInfo.parsedCmd[0].(map[string]any)
		}
		parsedType := ""
		if parsedPrimary != nil {
			parsedType = jsTrim(jsString(parsedPrimary["type"]))
		}
		switch parsedType {
		case "read":
			toolName = "Read"
			body = jsString(firstTruthy(primaryValue(parsedPrimary, "path"), primaryValue(parsedPrimary, "name"), argument(args, "cmd"), argument(args, "command")))
		case "write":
			toolName = "Write"
			body = jsString(firstTruthy(primaryValue(parsedPrimary, "path"), primaryValue(parsedPrimary, "name"), argument(args, "cmd"), argument(args, "command")))
		case "edit":
			toolName = "Edit"
			body = jsString(firstTruthy(primaryValue(parsedPrimary, "path"), primaryValue(parsedPrimary, "name"), argument(args, "cmd"), argument(args, "command")))
		default:
			toolName = "Terminal"
			body = jsString(firstTruthy(argument(args, "cmd"), argument(args, "command")))
			cwd := ""
			if resultInfo != nil && resultInfo.cwd != "" {
				cwd = resultInfo.cwd
			} else if workdir := argument(args, "workdir"); truthy(workdir) {
				cwd = jsString(workdir)
			}
			if cwd != "" {
				body += "\n# cwd: " + cwd
			}
		}
	case "create_file", "write_file":
		toolName = "Write"
		body = jsString(firstTruthy(argument(args, "path"), argument(args, "file_path")))
	case "read_file":
		toolName = "Read"
		body = jsString(firstTruthy(argument(args, "path"), argument(args, "file_path")))
	case "apply_diff", "edit_file", "apply_patch":
		toolName = "Edit"
		body = jsString(firstTruthy(argument(args, "path"), argument(args, "file_path")))
	case "TodoWrite":
		if todos, ok := argArray(args, "todos"); ok {
			toolName = "TodoWrite"
			body = compactRaw(todos)
		} else {
			body = jsSliceUTF16(rawArguments, maxFunctionArgumentChars)
		}
	case "Task", "update_plan":
		taskList, ok := firstArrayArgument(args, "tasks", "plan", "items")
		if ok {
			planKey := "tasks"
			toolName = "Task"
			if name == "update_plan" {
				planKey = "plan"
				toolName = "update_plan"
			}
			body = "{\"explanation\":" + rawArgumentOr(args, "explanation", "\"\"") +
				",\"" + planKey + "\":" + compactRaw(taskList) + "}"
		} else {
			body = jsSliceUTF16(rawArguments, maxFunctionArgumentChars)
		}
	case "request_user_input":
		toolName = "request_user_input"
		questions := json.RawMessage("[]")
		if value, ok := args["questions"]; ok {
			if _, isArray := decodeAny(value).([]any); isArray {
				questions = value
			}
		}
		body = "{\"questions\":" + compactRaw(questions) + "}"
	case "spawn_agent":
		toolName = "spawn_agent"
		subagent, _ := payload["subagent"].(map[string]any)
		body = spawnAgentBody(args, subagent)
	default:
		if isCodexGoalToolName(name) {
			toolName = name
			if json.Valid([]byte(rawArguments)) && rawArguments != "" {
				body = compactRaw(json.RawMessage(rawArguments))
			} else {
				body = "{}"
			}
		} else {
			body = jsSliceUTF16(rawArguments, maxFunctionArgumentChars)
		}
	}

	hasChildSession := false
	if name == "spawn_agent" {
		subagent, _ := payload["subagent"].(map[string]any)
		hasChildSession = jsTrim(jsString(subagent["sessionId"])) != ""
	}
	result := ""
	if !hasChildSession && resultInfo != nil {
		result = resultInfo.output
	}
	content := "\n:::tool{name=\"" + toolName + "\"}\n" + body + "\n:::\n"
	if result != "" {
		content += "\n:::tool-result\n" + result + "\n:::\n"
	}
	return content, true
}

func parseFunctionArguments(raw any) (map[string]json.RawMessage, string) {
	text := jsString(raw)
	args := make(map[string]json.RawMessage)
	if text == "" {
		return args, ""
	}
	if err := json.Unmarshal([]byte(text), &args); err != nil {
		return make(map[string]json.RawMessage), text
	}
	return args, text
}

// primaryValue 只读结构化结果里的字段，不回落到原始参数。
//
// Node 的 exec_command 分支是 parsedPrimary.path || parsedPrimary.name || args.cmd，
// parsedPrimary 缺失时不会去读 args.path。
func primaryValue(primary map[string]any, key string) any {
	if primary == nil {
		return nil
	}
	return primary[key]
}

func argument(args map[string]json.RawMessage, key string) any {
	raw, ok := args[key]
	if !ok {
		return nil
	}
	return decodeAny(raw)
}

func decodeAny(raw json.RawMessage) any {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return value
}

func argArray(args map[string]json.RawMessage, key string) (json.RawMessage, bool) {
	raw, ok := args[key]
	if !ok {
		return nil, false
	}
	var array []json.RawMessage
	if err := json.Unmarshal(raw, &array); err != nil || array == nil {
		// null 反序列化到 slice 也是 nil；Array.isArray(null) 为 false。
		return nil, false
	}
	return raw, true
}

func firstArrayArgument(args map[string]json.RawMessage, keys ...string) (json.RawMessage, bool) {
	for _, key := range keys {
		if raw, ok := argArray(args, key); ok {
			return raw, true
		}
	}
	return nil, false
}

func rawArgumentOr(args map[string]json.RawMessage, key, fallback string) string {
	raw, ok := args[key]
	if !ok || !truthy(decodeAny(raw)) {
		return fallback
	}
	return compactRaw(raw)
}

func compactRaw(raw json.RawMessage) string {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return string(raw)
	}
	return buffer.String()
}

func spawnAgentBody(args map[string]json.RawMessage, subagent map[string]any) string {
	childSessionID := ""
	agentPath := ""
	agentNickname := ""
	agentRole := ""
	status := ""
	createdAt := 0.0
	updatedAt := 0.0
	if subagent != nil {
		childSessionID = jsTrim(jsString(firstTruthy(subagent["sessionId"])))
		agentPath = jsTrim(jsString(firstTruthy(subagent["agentPath"])))
		agentNickname = jsTrim(jsString(firstTruthy(subagent["agentNickname"])))
		agentRole = jsTrim(jsString(firstTruthy(subagent["agentRole"])))
		status = jsTrim(jsString(firstTruthy(subagent["status"])))
		createdAt = jsNumber(subagent["createdAt"])
		updatedAt = jsNumber(subagent["updatedAt"])
	}
	taskName := jsTrim(jsString(firstTruthy(argument(args, "task_name"))))
	return "{\"task_name\":" + jsJSONString(taskName) +
		",\"child_session_id\":" + jsJSONString(childSessionID) +
		",\"agent_path\":" + jsJSONString(agentPath) +
		",\"agent_nickname\":" + jsJSONString(agentNickname) +
		",\"agent_role\":" + jsJSONString(agentRole) +
		",\"status\":" + jsJSONString(status) +
		",\"created_at\":" + jsNumberString(createdAt) +
		",\"updated_at\":" + jsNumberString(updatedAt) + "}"
}

func jsNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case bool:
		if typed {
			return 1
		}
		return 0
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return 0
		}
		return number
	case float64:
		return typed
	case string:
		number, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0
		}
		return number
	default:
		return 0
	}
}

func jsNumberString(value float64) string {
	if value == 0 {
		return "0"
	}
	// ECMAScript 在 |x| < 1e21 时用十进制，不使用 1.7e+12 这类科学计数法。
	if !math.IsInf(value, 0) && !math.IsNaN(value) && math.Abs(value) < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// buildCodexExecCommandResult 复刻 Node 对 exec_command_end 结果段的提取。
func buildCodexExecCommandResult(payload map[string]any) codexCallResult {
	aggregatedOutput := jsTrim(jsString(payload["aggregated_output"]))
	formattedOutput := jsTrim(jsString(payload["formatted_output"]))
	stdout := jsTrim(jsString(payload["stdout"]))
	stderr := jsTrim(jsString(payload["stderr"]))
	rawOutput := jsString(firstTruthy(aggregatedOutput, formattedOutput, stdout, stderr))

	parsedCmd := []any{}
	if items, ok := payload["parsed_cmd"].([]any); ok {
		parsedCmd = items
	}
	return codexCallResult{
		output:    trimToolResultOutput(cleanCodexExecCommandOutput(rawOutput)),
		parsedCmd: parsedCmd,
		cwd:       jsTrim(jsString(payload["cwd"])),
	}
}

func trimToolResultOutput(text string) string {
	normalized := jsTrim(text)
	if normalized == "" {
		return ""
	}
	if utf16Length(normalized) <= maxToolOutputChars {
		return normalized
	}
	return jsSliceUTF16(normalized, maxToolOutputChars) + "..."
}

func cleanCodexExecCommandOutput(output string) string {
	text := strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(output)
	if jsTrim(text) == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	sections := make([]string, 0)
	index := 0
	for index < len(lines) {
		if !chunkIDLinePattern.MatchString(lines[index]) {
			index++
			continue
		}
		index++
		for index < len(lines) && !outputLinePattern.MatchString(lines[index]) {
			if chunkIDLinePattern.MatchString(lines[index]) {
				break
			}
			index++
		}
		if index >= len(lines) || chunkIDLinePattern.MatchString(lines[index]) {
			continue
		}
		match := outputLinePattern.FindStringSubmatch(lines[index])
		body := make([]string, 0)
		if len(match) > 1 && match[1] != "" {
			body = append(body, match[1])
		}
		index++
		for index < len(lines) && !chunkIDLinePattern.MatchString(lines[index]) {
			body = append(body, lines[index])
			index++
		}
		sectionText := jsTrim(strings.Join(body, "\n"))
		if sectionText != "" {
			sections = append(sections, sectionText)
		}
	}
	if len(sections) > 0 {
		return strings.Join(sections, "\n\n")
	}
	outputIndex := -1
	for lineIndex, line := range lines {
		if outputLinePattern.MatchString(line) {
			outputIndex = lineIndex
			break
		}
	}
	if outputIndex >= 0 {
		match := outputLinePattern.FindStringSubmatch(lines[outputIndex])
		body := make([]string, 0, len(lines)-outputIndex)
		if len(match) > 1 && match[1] != "" {
			body = append(body, match[1])
		}
		body = append(body, lines[outputIndex+1:]...)
		return jsTrim(strings.Join(body, "\n"))
	}
	return jsTrim(text)
}

// jsSliceUTF16 按 JS String.prototype.slice 的 4000 字符口径截断（UTF-16 码元）。
//
// 与 JS 的差异：截断点落在代理对中间时，Go 会停在完整字符前，不产出孤立代理项。
func jsSliceUTF16(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := 0
	for index, char := range value {
		step := 1
		if char > 0xFFFF {
			step = 2
		}
		if units+step > limit {
			return value[:index]
		}
		units += step
	}
	return value
}
