package webuisessioneventsapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// maxTranscriptLineBytes 与 Node 的 maxCarryChars 同量级：超长单行（异常文件）直接失败。
	maxTranscriptLineBytes = 64 << 20
	// maxFunctionArgumentChars 是非结构化工具参数进入事件正文的截断长度。
	maxFunctionArgumentChars = 4000
	// maxToolOutputChars 与 Node trimToolResultOutput 的默认上限一致。
	maxToolOutputChars = 300
	// codexMobileAttachmentMarker 是 Codex Mobile 转发附件的前导标记。
	codexMobileAttachmentMarker = "/tmp/codex-remote-attachments/"
)

var (
	imageTagPattern        = regexp.MustCompile(`(?i)</?image\b[^>]*>`)
	trailingSpacesPattern  = regexp.MustCompile(`[ \t]+\n`)
	leadingSpacesPattern   = regexp.MustCompile(`\n[ \t]+`)
	repeatedSpacesPattern  = regexp.MustCompile(`[ \t]{2,}`)
	repeatedNewlinePattern = regexp.MustCompile(`\n{3,}`)
	mobilePreamblePattern  = regexp.MustCompile(`(?s)^# Files mentioned by the user:.*?\n## My request for Codex:\s*\n+`)
	goalObjectivePattern   = regexp.MustCompile(`(?is)<objective(?:\s+[^>]*)?>.*?</objective>`)
	renderableImagePattern = regexp.MustCompile(`(?i)^(data:image/|blob:|https?://|/v0/webui/chat/attachments)`)
	remoteImagePattern     = regexp.MustCompile(`(?i)^(blob:|https?://)`)
)

// codexEventParser 保存一次增量解析的累积状态。
type codexEventParser struct {
	maxBytes             int
	eventBytes           int
	events               []Event
	requiresSnapshot     bool
	handledNoopEvent     bool
	hasAssistantToolCall bool
	overflow             bool
	activeModel          string
	seenUserKeys         map[string]bool
	seenReasoningKeys    map[string]bool
}

func newCodexEventParser(maxBytes int) *codexEventParser {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxEventBytes
	}
	return &codexEventParser{
		maxBytes:          maxBytes,
		eventBytes:        2, // JSON array brackets.
		events:            []Event{},
		seenUserKeys:      make(map[string]bool),
		seenReasoningKeys: make(map[string]bool),
	}
}

// readCodexEvents 读取 [cursor, fileSize) 区间并翻译成增量事件。
//
// 游标推进规则与 Node 的 forEachJsonlLineSyncFromOffset 一致：只消费完整行；
// 文件末尾没有换行但能解析成真值 JSON 的收尾行也会被消费，否则留到下一次读取。
func (reader *FileReader) readCodexEvents(ctx context.Context, filePath string, requestedCursor int64) (EventResult, error) {
	cursor := requestedCursor
	if cursor < 0 {
		cursor = 0
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return EventResult{}, ErrSessionNotFound
	}
	size := info.Size()
	if cursor > size {
		return EventResult{Events: []Event{}, Cursor: size, RequiresSnapshot: boolPointer(true)}, nil
	}
	if cursor == size {
		// Node 在这个早退分支不返回 requiresSnapshot。
		return EventResult{Events: []Event{}, Cursor: size}, nil
	}

	parser := newCodexEventParser(reader.maxEventBytes())
	nextCursor, err := parser.parse(ctx, filePath, cursor, size)
	if err != nil {
		return EventResult{}, err
	}
	requiresSnapshot := parser.requiresSnapshot
	if len(parser.events) == 0 && nextCursor > cursor && !parser.handledNoopEvent {
		requiresSnapshot = true
	}
	return EventResult{
		Events:               parser.events,
		Cursor:               nextCursor,
		RequiresSnapshot:     boolPointer(requiresSnapshot),
		HasAssistantToolCall: parser.hasAssistantToolCall,
	}, nil
}

func (parser *codexEventParser) parse(ctx context.Context, filePath string, start, size int64) (int64, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return start, err
	}
	defer file.Close()

	skipPartialFirstLine := false
	if start > 0 {
		previous := []byte{0}
		if read, readErr := file.ReadAt(previous, start-1); readErr != nil || read <= 0 {
			return start, errors.New("session_jsonl_snapshot_short_read")
		}
		skipPartialFirstLine = previous[0] != '\n'
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return start, err
	}

	buffered := bufio.NewReaderSize(io.LimitReader(file, size-start), 256*1024)
	lastCompleteCursor := start
	position := start
	for {
		if err := ctx.Err(); err != nil {
			return lastCompleteCursor, err
		}
		line, readErr := buffered.ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return lastCompleteCursor, readErr
		}
		if len(line) > maxTranscriptLineBytes {
			return lastCompleteCursor, errors.New("session_jsonl_line_too_large")
		}
		if errors.Is(readErr, io.EOF) {
			finalLine := strings.TrimSuffix(line, "\r")
			if !skipPartialFirstLine && strings.TrimSpace(finalLine) != "" && isTruthyJSON(finalLine) {
				parser.handleLine(finalLine)
				lastCompleteCursor = size
			}
			break
		}
		position += int64(len(line))
		content := strings.TrimSuffix(line[:len(line)-1], "\r")
		if !skipPartialFirstLine && strings.TrimSpace(content) != "" {
			parser.handleLine(content)
		}
		skipPartialFirstLine = false
		lastCompleteCursor = position
	}
	return lastCompleteCursor, nil
}

func (parser *codexEventParser) handleLine(line string) {
	record, ok := decodeJSONObject(line)
	if !ok {
		return
	}
	recordType, _ := record["type"].(string)
	payload, _ := record["payload"].(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}
	payloadType, _ := payload["type"].(string)
	role, _ := payload["role"].(string)
	timestamp := record["timestamp"]

	switch {
	case recordType == "turn_context":
		model := jsTrim(jsString(firstTruthy(payload["model"])))
		if model == "" {
			return
		}
		parser.activeModel = model
		for index := len(parser.events) - 1; index >= 0; index-- {
			event := parser.events[index]
			if event.Kind != "user_message" || event.Model != "" {
				continue
			}
			updated := event
			updated.Model = model
			parser.replaceEvent(index, updated)
			break
		}
	case recordType == "response_item" && payloadType == "message" && role == "user":
		content, images := extractCodexUserResponseMessage(payload)
		if content == "" && len(images) == 0 {
			return
		}
		parser.upsertUserEvent(timestamp, content, images)
	case recordType == "event_msg" && payloadType == "user_message":
		images := mergeUniqueStrings(nil, payload["images"])
		images = mergeUniqueStrings(toAnySlice(images), payload["local_images"])
		for index, source := range images {
			images[index] = toRenderableCodexImageSource(source)
		}
		parser.upsertUserEvent(timestamp, jsString(firstTruthy(payload["message"])), images)
	case recordType == "event_msg" && payloadType == "turn_aborted":
		parser.handledNoopEvent = true
	case recordType == "event_msg" && payloadType == "agent_reasoning":
		parser.appendReasoning(timestamp, extractCodexReasoningText(payload))
	case recordType == "response_item" && payloadType == "reasoning":
		parser.appendReasoning(timestamp, extractCodexReasoningText(payload))
	case recordType == "response_item" && role == "assistant":
		text := assistantResponseText(payload)
		if text == "" {
			return
		}
		parser.appendEvent(Event{Kind: "assistant_text", Timestamp: timestamp, Text: text})
	case recordType == "response_item" && payloadType == "function_call":
		content, ok := normalizeCodexFunctionCall(payload, nil)
		if !ok {
			return
		}
		parser.hasAssistantToolCall = true
		parser.appendEvent(Event{Kind: "assistant_tool_call", Timestamp: timestamp, CallID: payload["call_id"], Content: content})
	case recordType == "event_msg" && payloadType == "exec_command_end" && truthy(payload["call_id"]):
		resultInfo := buildCodexExecCommandResult(payload)
		command := ""
		if items, ok := payload["command"].([]any); ok && len(items) > 0 {
			command = jsString(firstTruthy(items[len(items)-1]))
		}
		synthetic := map[string]any{
			"type":      "function_call",
			"name":      "exec_command",
			"call_id":   payload["call_id"],
			"arguments": "{\"cmd\":" + jsJSONString(command) + ",\"workdir\":" + jsJSONString(jsString(firstTruthy(payload["cwd"]))) + "}",
		}
		content, ok := normalizeCodexFunctionCall(synthetic, &resultInfo)
		if !ok {
			return
		}
		parser.appendEvent(Event{Kind: "assistant_tool_result", Timestamp: timestamp, CallID: payload["call_id"], Content: content})
	case recordType == "response_item" && payloadType == "function_call_output" && truthy(payload["call_id"]):
		// 单独的 function_call_output 缺少结构化上下文，增量拼接会破坏格式；让前端回退 snapshot。
		parser.requiresSnapshot = true
	}
}

func (parser *codexEventParser) appendReasoning(timestamp any, text string) {
	key := jsString(firstTruthy(timestamp)) + "::" + text
	if text == "" || parser.seenReasoningKeys[key] {
		return
	}
	parser.seenReasoningKeys[key] = true
	parser.appendEvent(Event{Kind: "assistant_reasoning", Timestamp: timestamp, Text: text})
}

func (parser *codexEventParser) upsertUserEvent(timestamp any, rawContent any, rawImages []string) {
	images := mergeUniqueStrings(nil, toAnySlice(rawImages))
	strippedContent, source := extractCodexMobileAttachmentPreamble(jsString(firstTruthy(rawContent)))
	content := cleanCodexUserMessageContent(strippedContent)
	trimmedTimestamp := jsTrim(jsString(firstTruthy(timestamp)))
	messageKey := toCodexUserMessageKey(content)

	if isSyntheticCodexUserContent(content) {
		parser.handledNoopEvent = true
		return
	}
	if content == "" && len(images) == 0 {
		return
	}

	for index := len(parser.events) - 1; index >= 0; index-- {
		existing := parser.events[index]
		if existing.Kind != "user_message" {
			continue
		}
		if !areCloseTimestamps(existing.Timestamp, trimmedTimestamp) {
			continue
		}
		if toCodexUserMessageKey(existing.Content) != messageKey {
			continue
		}
		nextContent := existing.Content
		if utf16Length(content) > utf16Length(existing.Content) {
			nextContent = content
		}
		nextSource := existing.Source
		if nextSource == "" {
			nextSource = source
		}
		parser.replaceEvent(index, Event{
			Kind:      "user_message",
			Timestamp: existing.Timestamp,
			Content:   nextContent,
			Images:    mergeCodexUserImages(existing.Images, images),
			Source:    nextSource,
		})
		return
	}

	dedupeKey := trimmedTimestamp + "::" + messageKey
	if parser.seenUserKeys[dedupeKey] {
		return
	}
	parser.seenUserKeys[dedupeKey] = true
	parser.appendEvent(Event{
		Kind:      "user_message",
		Timestamp: trimmedTimestamp,
		Content:   content,
		Images:    mergeCodexUserImages(nil, images),
		Source:    source,
	})
}

func (parser *codexEventParser) appendEvent(event Event) bool {
	if parser.overflow {
		return false
	}
	if parser.activeModel != "" && strings.HasPrefix(event.Kind, "assistant_") && event.Model == "" {
		event.Model = parser.activeModel
	}
	size := marshaledLength(event)
	separator := 0
	if len(parser.events) > 0 {
		separator = 1
	}
	if parser.eventBytes+separator+size > parser.maxBytes {
		parser.markOverflow()
		return false
	}
	parser.events = append(parser.events, event)
	parser.eventBytes += separator + size
	return true
}

func (parser *codexEventParser) replaceEvent(index int, event Event) bool {
	if parser.overflow || index < 0 || index >= len(parser.events) {
		return false
	}
	nextBytes := parser.eventBytes - marshaledLength(parser.events[index]) + marshaledLength(event)
	if nextBytes > parser.maxBytes {
		parser.markOverflow()
		return false
	}
	parser.events[index] = event
	parser.eventBytes = nextBytes
	return true
}

func (parser *codexEventParser) markOverflow() {
	parser.overflow = true
	parser.requiresSnapshot = true
	parser.events = []Event{}
	parser.eventBytes = 2
}

func marshaledLength(event Event) int {
	raw, err := json.Marshal(event)
	if err != nil {
		return math.MaxInt32
	}
	return len(raw)
}

func extractCodexUserResponseMessage(payload map[string]any) (string, []string) {
	blocks, _ := payload["content"].([]any)
	textParts := make([]string, 0, len(blocks))
	images := make([]string, 0)
	for _, rawBlock := range blocks {
		block, ok := rawBlock.(map[string]any)
		if !ok {
			continue
		}
		switch blockType, _ := block["type"].(string); blockType {
		case "input_text":
			if text := jsString(firstTruthy(block["text"])); text != "" {
				textParts = append(textParts, text)
			}
		case "input_image":
			if image := jsTrim(jsString(firstTruthy(block["image_url"]))); image != "" {
				images = append(images, image)
			}
		}
	}
	return cleanCodexUserMessageContent(strings.Join(textParts, "\n")), images
}

func assistantResponseText(payload map[string]any) string {
	blocks, _ := payload["content"].([]any)
	parts := make([]string, 0, len(blocks))
	for _, rawBlock := range blocks {
		block, ok := rawBlock.(map[string]any)
		if !ok {
			continue
		}
		if blockType, _ := block["type"].(string); blockType != "output_text" || !truthy(block["text"]) {
			continue
		}
		parts = append(parts, jsString(block["text"]))
	}
	return jsTrim(strings.Join(parts, "\n"))
}

func extractCodexReasoningText(payload map[string]any) string {
	if summary, ok := payload["summary"].([]any); ok {
		parts := make([]string, 0, len(summary))
		for _, rawItem := range summary {
			item, ok := rawItem.(map[string]any)
			if !ok {
				continue
			}
			if itemType, _ := item["type"].(string); itemType != "summary_text" || !truthy(item["text"]) {
				continue
			}
			if text := jsTrim(jsString(item["text"])); text != "" {
				parts = append(parts, text)
			}
		}
		if text := jsTrim(strings.Join(parts, "\n\n")); text != "" {
			return text
		}
	}
	return jsTrim(jsString(firstTruthy(payload["text"])))
}

func extractCodexMobileAttachmentPreamble(rawContent string) (string, string) {
	if !strings.Contains(rawContent, codexMobileAttachmentMarker) {
		return rawContent, ""
	}
	return mobilePreamblePattern.ReplaceAllString(rawContent, ""), "codex-mobile"
}

func cleanCodexUserMessageContent(content string) string {
	text := imageTagPattern.ReplaceAllString(content, "\n")
	text = trailingSpacesPattern.ReplaceAllString(text, "\n")
	text = leadingSpacesPattern.ReplaceAllString(text, "\n")
	text = repeatedSpacesPattern.ReplaceAllString(text, " ")
	text = repeatedNewlinePattern.ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}

func toCodexUserMessageKey(content string) string {
	return strings.Join(strings.Fields(cleanCodexUserMessageContent(content)), " ")
}

func isSyntheticCodexUserContent(content string) bool {
	text := strings.Join(strings.Fields(content), " ")
	if text == "" {
		return false
	}
	if isCodexGoalContextContent(content) {
		return false
	}
	for _, prefix := range []string{
		"# AGENTS.md instructions",
		"<environment_context",
		"<codex_internal_context",
		"<goal_context",
		"<turn_aborted",
		"<user_instructions",
		"<user_shell_command",
	} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return strings.Contains(text, "<INSTRUCTIONS>")
}

func isCodexGoalContextContent(content string) bool {
	raw := strings.TrimSpace(content)
	normalized := strings.Join(strings.Fields(raw), " ")
	if !strings.HasPrefix(normalized, "<codex_internal_context") && !strings.HasPrefix(normalized, "<goal_context") {
		return false
	}
	return goalObjectivePattern.MatchString(raw)
}

func areCloseTimestamps(left, right any) bool {
	leftMs, leftOK := timestampMillis(left)
	rightMs, rightOK := timestampMillis(right)
	if leftOK && rightOK {
		return math.Abs(leftMs-rightMs) <= 1000
	}
	return jsString(firstTruthy(left)) == jsString(firstTruthy(right))
}

func timestampMillis(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return number, number != 0
	case float64:
		return typed, typed != 0
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, typed)
		if err != nil || parsed.UnixMilli() == 0 {
			return 0, false
		}
		return float64(parsed.UnixMilli()), true
	default:
		return 0, false
	}
}

// toRenderableCodexImageSource 把宿主机绝对图片路径内联成 data URI；其余来源原样返回。
func toRenderableCodexImageSource(source string) string {
	value := jsTrim(source)
	if value == "" {
		return ""
	}
	if renderableImagePattern.MatchString(value) {
		return value
	}
	if !filepath.IsAbs(value) {
		return value
	}
	info, err := os.Stat(value)
	if err != nil || !info.Mode().IsRegular() {
		return value
	}
	mimeType := guessImageMimeTypeFromPath(value)
	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return value
	}
	raw, err := os.ReadFile(value)
	if err != nil {
		return value
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(raw)
}

func guessImageMimeTypeFromPath(filePath string) string {
	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	default:
		return "application/octet-stream"
	}
}

func mergeCodexUserImages(existing []string, incoming []string) []string {
	existingList := mergeUniqueStrings(nil, toAnySlice(existing))
	incomingList := mergeUniqueStrings(nil, toAnySlice(incoming))
	length := len(existingList)
	if len(incomingList) > length {
		length = len(incomingList)
	}
	merged := make([]string, 0, length)
	for index := 0; index < length; index++ {
		left, right := "", ""
		if index < len(existingList) {
			left = existingList[index]
		}
		if index < len(incomingList) {
			right = incomingList[index]
		}
		merged = append(merged, preferCodexImageSource(left, right))
	}
	return mergeUniqueStrings(nil, toAnySlice(merged))
}

func preferCodexImageSource(existing, incoming string) string {
	if existing == "" {
		return incoming
	}
	if incoming == "" {
		return existing
	}
	if codexImagePriority(incoming) > codexImagePriority(existing) {
		return incoming
	}
	return existing
}

func codexImagePriority(source string) int {
	value := jsTrim(source)
	switch {
	case strings.HasPrefix(strings.ToLower(value), "data:image/"):
		return 5
	case remoteImagePattern.MatchString(value):
		return 4
	case strings.HasPrefix(value, "/v0/webui/chat/attachments"):
		return 3
	case filepath.IsAbs(value) && fileExists(value):
		return 2
	case value != "":
		return 1
	default:
		return 0
	}
}

func mergeUniqueStrings(existing []any, incoming any) []string {
	merged := make([]string, 0)
	seen := make(map[string]bool)
	appendValue := func(item any) {
		value := jsTrim(jsString(item))
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		merged = append(merged, value)
	}
	for _, item := range existing {
		appendValue(item)
	}
	if items, ok := incoming.([]any); ok {
		for _, item := range items {
			appendValue(item)
		}
	}
	return merged
}

func toAnySlice(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return typed != ""
	case bool:
		return typed
	case json.Number:
		number, err := typed.Float64()
		return err == nil && number != 0 && !math.IsNaN(number)
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		// 数组/对象在 JS 里恒为真。
		return true
	}
}

func firstTruthy(values ...any) any {
	for _, value := range values {
		if truthy(value) {
			return value
		}
	}
	return ""
}

func jsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			parts[index] = jsString(item)
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return ""
	}
}

func jsTrim(value string) string {
	return strings.TrimSpace(value)
}

func jsJSONString(value string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(buffer.String(), "\n")
}

func decodeJSONObject(line string) (map[string]any, bool) {
	if !json.Valid([]byte(line)) {
		return nil, false
	}
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.UseNumber()
	var record map[string]any
	if err := decoder.Decode(&record); err != nil {
		return nil, false
	}
	return record, true
}

func isTruthyJSON(line string) bool {
	if !json.Valid([]byte(line)) {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return false
	}
	return truthy(value)
}

func utf16Length(value string) int {
	length := 0
	for _, char := range value {
		if char > 0xFFFF {
			length += 2
		} else {
			length++
		}
	}
	return length
}

func fileExists(filePath string) bool {
	_, err := os.Stat(filePath)
	return err == nil
}
