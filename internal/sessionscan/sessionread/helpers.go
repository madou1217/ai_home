package sessionread

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	trailingModelJSONPattern = regexp.MustCompile(`"model"\s*:\s*"([^"]{1,80})"`)
	whitespaceRunPattern     = regexp.MustCompile(`\s+`)
)

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func compactWhitespace(value string) string {
	return strings.TrimSpace(whitespaceRunPattern.ReplaceAllString(value, " "))
}

func compactMultilineText(value string) string {
	replaced := strings.ReplaceAll(value, "\r\n", "\n")
	replaced = strings.ReplaceAll(replaced, "\r", "\n")
	return strings.TrimSpace(replaced)
}

func safeChildPath(root, child string) (string, bool) {
	cleanRoot := filepath.Clean(root)
	cleanTarget := filepath.Join(cleanRoot, child)
	rel, err := filepath.Rel(cleanRoot, cleanTarget)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return cleanTarget, true
}

func fileExistsRegular(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func dirExists(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func fileSizeAndMtimeMs(path string) (int64, int64, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return 0, 0, false
	}
	return info.Size(), info.ModTime().UnixMilli(), true
}

func forEachJSONLLine(filePath string, handle func(line []byte) bool) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()

	reader := bufio.NewReaderSize(file, 64*1024)
	for {
		line, readErr := reader.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			if !handle(trimmed) {
				return nil
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return readErr
		}
	}
	return nil
}

func readFileTail(filePath string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return nil, err
	}
	size := info.Size()
	offset := int64(0)
	if maxBytes > 0 && size > maxBytes {
		offset = size - maxBytes
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}

func extractLastModelFromFileTail(filePath string, maxBytes int64) string {
	tail, err := readFileTail(filePath, maxBytes)
	if err != nil || len(tail) == 0 {
		return ""
	}
	matches := trailingModelJSONPattern.FindAllSubmatch(tail, -1)
	for i := len(matches) - 1; i >= 0; i-- {
		if len(matches[i]) >= 2 {
			model := NormalizeMessageModel(string(matches[i][1]))
			if model != "" {
				return model
			}
		}
	}
	return ""
}

func escapeToolName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		trimmed = "Unknown"
	}
	return strings.ReplaceAll(trimmed, `"`, `\"`)
}

func renderToolBlock(name, body, result string) string {
	content := compactMultilineText(body)
	output := compactMultilineText(result)
	rendered := ":::tool{name=\"" + escapeToolName(name) + "\"}\n" + content + "\n:::"
	if output != "" {
		rendered += "\n\n:::tool-result\n" + output + "\n:::"
	}
	return rendered
}

func renderThinkingBlock(title, text string) string {
	titleText := compactMultilineText(title)
	bodyText := compactMultilineText(text)
	var combined string
	switch {
	case titleText != "" && bodyText != "":
		combined = "## " + titleText + "\n\n" + bodyText
	case titleText != "":
		combined = "## " + titleText
	default:
		combined = bodyText
	}
	if combined == "" {
		return ""
	}
	return ":::thinking\n" + combined + "\n:::"
}

func renderProviderBlocks(blocks []map[string]any) string {
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block == nil {
			continue
		}
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			if text := compactMultilineText(stringFromAny(block["text"])); text != "" {
				parts = append(parts, text)
			}
		case "reasoning":
			if rendered := renderThinkingBlock(stringFromAny(block["title"]), stringFromAny(block["text"])); rendered != "" {
				parts = append(parts, rendered)
			}
		case "hidden_reasoning":
			parts = append(parts, ":::thinking\nReasoning hidden by provider.\n:::")
		case "tool_call":
			var body string
			if rawArgs, ok := block["args"].(string); ok {
				body = rawArgs
			} else if block["args"] != nil {
				raw, _ := json.Marshal(block["args"])
				body = string(raw)
			}
			parts = append(parts, renderToolBlock(stringFromAny(block["name"]), body, stringFromAny(block["result"])))
		case "tool_result":
			name := firstNonEmpty(stringFromAny(block["name"]), "ToolResult")
			res := firstNonEmpty(stringFromAny(block["text"]), stringFromAny(block["result"]))
			parts = append(parts, renderToolBlock(name, stringFromAny(block["body"]), res))
		case "plan_text":
			if text := compactMultilineText(stringFromAny(block["text"])); text != "" {
				parts = append(parts, "<proposed_plan>\n"+text+"\n</proposed_plan>")
			}
		case "image":
			mediaType := firstNonEmpty(stringFromAny(block["mediaType"]), stringFromAny(block["mimeType"]))
			if mediaType != "" {
				parts = append(parts, "[image "+mediaType+"]")
			} else {
				parts = append(parts, "[image]")
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

// ExtractSessionPreview 返回最近一条 assistant（无则退回 user）的截断预览（最多 140 rune）。
func ExtractSessionPreview(messages []Message) string {
	for _, role := range []string{"assistant", "user"} {
		for i := len(messages) - 1; i >= 0; i-- {
			if messages[i].Role != role {
				continue
			}
			text := compactWhitespace(messages[i].Content)
			if text == "" {
				continue
			}
			runes := []rune(text)
			if len(runes) > 140 {
				return string(runes[:140])
			}
			return text
		}
	}
	return ""
}

// ExtractPreviewFromRawMessages 从已序列化的 JSON 消息中提取最后预览（支持 chat-sessions 的分块 content）。
func ExtractPreviewFromRawMessages(rawMessages []json.RawMessage) string {
	for _, role := range []string{"assistant", "user"} {
		for i := len(rawMessages) - 1; i >= 0; i-- {
			var item struct {
				Role    string `json:"role"`
				Content any    `json:"content"`
			}
			if json.Unmarshal(rawMessages[i], &item) != nil || item.Role != role {
				continue
			}
			text := compactWhitespace(flattenMessageContentAny(item.Content))
			if text == "" {
				continue
			}
			runes := []rune(text)
			if len(runes) > 140 {
				return string(runes[:140])
			}
			return text
		}
	}
	return ""
}

func flattenMessageContentAny(content any) string {
	switch typed := content.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				if trimmed := strings.TrimSpace(text); trimmed != "" {
					parts = append(parts, trimmed)
				}
				continue
			}
			if obj, ok := item.(map[string]any); ok {
				if kind, _ := obj["type"].(string); kind == "text" {
					if text := strings.TrimSpace(stringFromAny(obj["text"])); text != "" {
						parts = append(parts, text)
					}
				}
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

func encodeBase64RawURL(value string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(value))
}

func encodeBase64StdUnderscore(value string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(value))
	replacer := strings.NewReplacer("/", "_", "+", "_", "=", "_")
	return replacer.Replace(encoded)
}

func stringFromAny(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return ""
		}
		if typed == math.Trunc(typed) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(typed, 10)
	case int:
		return strconv.Itoa(typed)
	default:
		return ""
	}
}

// ToTimestampMs 把数字（秒/毫秒）或 RFC3339/ISO 时间字符串转成 Unix 毫秒时间戳。
func ToTimestampMs(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return normalizeEpochNumber(float64(typed))
	case int:
		return normalizeEpochNumber(float64(typed))
	case float64:
		return normalizeEpochNumber(typed)
	case json.Number:
		if f, err := typed.Float64(); err == nil {
			return normalizeEpochNumber(f)
		}
		return 0
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		if isDigitsOnly(trimmed) {
			if n, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
				return normalizeEpochNumber(float64(n))
			}
		}
		return parseISOTimestampMs(trimmed)
	default:
		return 0
	}
}

func normalizeEpochNumber(value float64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	if value > 100000000000 {
		return int64(math.Round(value))
	}
	return int64(math.Round(value * 1000))
}

func parseISOTimestampMs(value string) int64 {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999Z07:00",
		"2006-01-02 15:04:05",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			ms := parsed.UnixMilli()
			if ms > 0 {
				return ms
			}
		}
	}
	return 0
}

func formatISOFromMs(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

func isDigitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func sanitizeProjects(projects []Project) []Project {
	out := make([]Project, 0, len(projects))
	for _, proj := range projects {
		sessions := make([]Session, 0, len(proj.Sessions))
		for _, sess := range proj.Sessions {
			if strings.TrimSpace(sess.ID) == "" {
				continue
			}
			sessions = append(sessions, sess)
		}
		if len(sessions) == 0 {
			continue
		}
		sort.SliceStable(sessions, func(i, j int) bool {
			return sessions[i].UpdatedAt > sessions[j].UpdatedAt
		})
		proj.Sessions = sessions
		out = append(out, proj)
	}
	sort.SliceStable(out, func(i, j int) bool {
		li := projectMaxUpdatedAt(out[i])
		rj := projectMaxUpdatedAt(out[j])
		if li != rj {
			return li > rj
		}
		return out[i].Path < out[j].Path
	})
	return out
}

func projectMaxUpdatedAt(project Project) int64 {
	var maxTs int64
	for _, sess := range project.Sessions {
		if sess.UpdatedAt > maxTs {
			maxTs = sess.UpdatedAt
		}
	}
	return maxTs
}

func projectBaseName(projectPath string) string {
	norm := NormalizeProjectPath(projectPath)
	if norm == "" {
		return ""
	}
	base := filepath.Base(norm)
	if base == "" || base == "." {
		return norm
	}
	return base
}
