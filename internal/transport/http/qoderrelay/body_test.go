package qoderrelay

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
)

const testNowMS int64 = 1762300000000

var testUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func testEntry() modelcatalog.Entry {
	return modelcatalog.Entry{
		Key:            "qfmodel",
		DisplayName:    "Qwen3.8-Flash",
		Format:         "openai",
		Source:         "system",
		IsVl:           false,
		IsReasoning:    false,
		MaxInputTokens: 200000,
	}
}

func testAutoEntry() modelcatalog.Entry {
	return modelcatalog.Entry{
		Key:            "auto",
		DisplayName:    "Auto",
		Format:         "openai",
		Source:         "system",
		IsVl:           true,
		IsReasoning:    false,
		IsDefault:      true,
		MaxInputTokens: 200000,
	}
}

func buildTestBody(t *testing.T, request map[string]any, entry modelcatalog.Entry, model, provider, version string) BuildResult {
	t.Helper()
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	result, err := BuildBody(raw, entry, model, provider, version, testNowMS)
	if err != nil {
		t.Fatalf("BuildBody: %v", err)
	}
	return result
}

func decodeTestBody(t *testing.T, result BuildResult) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(result.Body))
	decoder.UseNumber()
	var body map[string]any
	if err := decoder.Decode(&body); err != nil {
		t.Fatalf("decode body: %v (raw=%s)", err, result.Body)
	}
	return body
}

func testObject(t *testing.T, value any, name string) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s = %#v, want object", name, value)
	}
	return object
}

func testArray(t *testing.T, value any, name string) []any {
	t.Helper()
	array, ok := value.([]any)
	if !ok {
		t.Fatalf("%s = %#v, want array", name, value)
	}
	return array
}

func testNumber(t *testing.T, value any, name string) float64 {
	t.Helper()
	number, ok := value.(json.Number)
	if !ok {
		t.Fatalf("%s = %#v, want number", name, value)
	}
	parsed, err := number.Float64()
	if err != nil {
		t.Fatalf("%s = %v: %v", name, number, err)
	}
	return parsed
}

func testStrings(t *testing.T, value any, name string) []string {
	t.Helper()
	array := testArray(t, value, name)
	texts := make([]string, 0, len(array))
	for _, item := range array {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("%s item = %#v, want string", name, item)
		}
		texts = append(texts, text)
	}
	return texts
}

func TestBuildBodySingleUser(t *testing.T) {
	request := map[string]any{
		"model": "Qwen3.8-Flash",
		"messages": []any{
			map[string]any{"role": "user", "content": "  你好，介绍一下自己  "},
		},
	}
	result := buildTestBody(t, request, testEntry(), "Qwen3.8-Flash", "qoder", "1.1.82")

	if result.Transcript != "你好，介绍一下自己" {
		t.Fatalf("Transcript = %q, want 原样正文（去首尾空白）", result.Transcript)
	}
	if result.SystemText != defaultSystemText {
		t.Fatalf("SystemText = %q, want %q", result.SystemText, defaultSystemText)
	}
	if result.ModelKey != "qfmodel" || result.DisplayName != "Qwen3.8-Flash" {
		t.Fatalf("model = %q/%q", result.ModelKey, result.DisplayName)
	}
	if result.ModelSource != "catalog" {
		t.Fatalf("ModelSource = %q, want catalog", result.ModelSource)
	}
	if !testUUIDPattern.MatchString(result.RequestID) {
		t.Fatalf("RequestID = %q, want uuid v4", result.RequestID)
	}

	body := decodeTestBody(t, result)
	required := []string{
		"request_id", "request_set_id", "chat_record_id", "session_id", "stream",
		"chat_task", "chat_context", "is_reply", "is_retry", "source", "version",
		"agent_id", "task_id", "session_type", "aliyun_user_type", "model_config",
		"system", "messages", "tools", "parameters", "business",
	}
	if len(body) != len(required) {
		t.Fatalf("body fields = %d (%v), want %d", len(body), body, len(required))
	}
	for _, key := range required {
		if _, ok := body[key]; !ok {
			t.Fatalf("body 缺少字段 %q", key)
		}
	}
	if body["request_id"] != result.RequestID || body["chat_record_id"] != result.RequestID {
		t.Fatalf("request_id/chat_record_id = %v/%v", body["request_id"], body["chat_record_id"])
	}
	if body["session_type"] != "qodercli" {
		t.Fatalf("session_type = %v, want qodercli", body["session_type"])
	}
	if body["stream"] != true || body["is_reply"] != true || body["is_retry"] != false {
		t.Fatalf("stream/is_reply/is_retry = %v/%v/%v", body["stream"], body["is_reply"], body["is_retry"])
	}
	if testNumber(t, body["source"], "source") != 1 || body["version"] != "3" {
		t.Fatalf("source/version = %v/%v", body["source"], body["version"])
	}
	if body["chat_task"] != "FREE_INPUT" || body["agent_id"] != "agent_common" || body["task_id"] != "common" {
		t.Fatalf("chat_task/agent_id/task_id = %v/%v/%v", body["chat_task"], body["agent_id"], body["task_id"])
	}

	chatContext := testObject(t, body["chat_context"], "chat_context")
	if chatContext["text"] != result.Transcript {
		t.Fatalf("chat_context.text = %v, want transcript", chatContext["text"])
	}
	if chatContext["chatPrompt"] != "" || chatContext["imageUrls"] != nil {
		t.Fatalf("chatPrompt/imageUrls = %v/%v", chatContext["chatPrompt"], chatContext["imageUrls"])
	}
	if len(testArray(t, chatContext["features"], "features")) != 0 {
		t.Fatalf("features = %v, want []", chatContext["features"])
	}
	extra := testObject(t, chatContext["extra"], "chat_context.extra")
	if len(testArray(t, extra["context"], "extra.context")) != 0 {
		t.Fatalf("extra.context = %v, want []", extra["context"])
	}
	if extra["originalContent"] != result.Transcript {
		t.Fatalf("extra.originalContent = %v", extra["originalContent"])
	}
	extraModel := testObject(t, extra["modelConfig"], "extra.modelConfig")
	if extraModel["key"] != "qfmodel" || extraModel["is_reasoning"] != false {
		t.Fatalf("extra.modelConfig = %v", extraModel)
	}

	system := testArray(t, body["system"], "system")
	if len(system) != 1 {
		t.Fatalf("system = %v", system)
	}
	systemPart := testObject(t, system[0], "system[0]")
	if systemPart["type"] != "text" || systemPart["text"] != defaultSystemText {
		t.Fatalf("system[0] = %v", systemPart)
	}

	messages := testArray(t, body["messages"], "messages")
	if len(messages) != 2 {
		t.Fatalf("messages = %v", messages)
	}
	systemMessage := testObject(t, messages[0], "messages[0]")
	if systemMessage["role"] != "system" {
		t.Fatalf("messages[0].role = %v", systemMessage["role"])
	}
	messageSystem := testArray(t, systemMessage["content"], "messages[0].content")
	if len(messageSystem) != 1 || testObject(t, messageSystem[0], "messages[0].content[0]")["text"] != defaultSystemText {
		t.Fatalf("messages[0].content = %v", messageSystem)
	}
	userMessage := testObject(t, messages[1], "messages[1]")
	if userMessage["role"] != "user" || userMessage["content"] != result.Transcript {
		t.Fatalf("messages[1] = %v", userMessage)
	}

	if len(testArray(t, body["tools"], "tools")) != 0 {
		t.Fatalf("tools = %v, want []", body["tools"])
	}
	parameters := testObject(t, body["parameters"], "parameters")
	if testNumber(t, parameters["max_tokens"], "max_tokens") != 32000 {
		t.Fatalf("max_tokens = %v, want 32000", parameters["max_tokens"])
	}
	if _, exists := parameters["temperature"]; exists {
		t.Fatalf("未显式给 temperature 却写入了 %v", parameters["temperature"])
	}

	business := testObject(t, body["business"], "business")
	if business["product"] != "cli" || business["type"] != "agent" || business["stage"] != "start" {
		t.Fatalf("business = %v", business)
	}
	if business["version"] != "1.1.82" || business["model_key"] != "qfmodel" {
		t.Fatalf("business version/model_key = %v/%v", business["version"], business["model_key"])
	}
	if business["name"] != "你好，介绍一下自己" {
		t.Fatalf("business.name = %v", business["name"])
	}
	if business["id"] != body["request_set_id"] {
		t.Fatalf("business.id = %v, want request_set_id %v", business["id"], body["request_set_id"])
	}
	if testNumber(t, business["begin_at"], "begin_at") != float64(testNowMS) {
		t.Fatalf("business.begin_at = %v, want %d", business["begin_at"], testNowMS)
	}
}

func TestBuildBodyTranscriptWithToolCalls(t *testing.T) {
	request := map[string]any{
		"model": "Qwen3.8-Flash",
		"messages": []any{
			map[string]any{"role": "system", "content": "你是助手。"},
			map[string]any{"role": "developer", "content": []any{
				map[string]any{"type": "text", "text": "保持简洁。"},
			}},
			map[string]any{"role": "user", "content": "查一下北京天气"},
			map[string]any{
				"role":    "assistant",
				"content": "",
				"tool_calls": []any{
					map[string]any{
						"id":   "call_1",
						"type": "function",
						"function": map[string]any{
							"name":      "get_weather",
							"arguments": `{"city":"北京"}`,
						},
					},
				},
			},
			map[string]any{"role": "tool", "content": "晴，25 度"},
			map[string]any{"role": "user", "content": "谢谢"},
		},
	}
	result := buildTestBody(t, request, testEntry(), "Qwen3.8-Flash", "qoder", "1.1.82")

	if result.SystemText != "你是助手。\n\n保持简洁。" {
		t.Fatalf("SystemText = %q", result.SystemText)
	}
	wantTranscript := "User:\n查一下北京天气\n\nAssistant:\n[调用工具 get_weather]\n" +
		`{"city":"北京"}` +
		"\n\nTool:\n晴，25 度\n\nUser:\n谢谢"
	if result.Transcript != wantTranscript {
		t.Fatalf("Transcript = %q,\nwant %q", result.Transcript, wantTranscript)
	}
}

func TestBuildBodyToolsNormalization(t *testing.T) {
	request := map[string]any{
		"model":    "Qwen3.8-Flash",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{
			map[string]any{
				"type": "function",
				"function": map[string]any{
					"name": "lookup",
					"parameters": map[string]any{
						"properties": map[string]any{
							"q": map[string]any{"type": "string"},
						},
					},
				},
			},
			map[string]any{"type": "function", "function": map[string]any{"name": "bad name"}},
			map[string]any{"type": "function", "function": map[string]any{"name": strings.Repeat("a", 65)}},
			map[string]any{"type": "retrieval", "function": map[string]any{"name": "search"}},
			map[string]any{"name": "legacy_tool", "description": "legacy", "input_schema": map[string]any{"type": "object"}},
		},
	}
	result := buildTestBody(t, request, testEntry(), "Qwen3.8-Flash", "qoder", "1.1.82")
	body := decodeTestBody(t, result)
	tools := testArray(t, body["tools"], "tools")
	if len(tools) != 2 {
		t.Fatalf("tools = %v, want 2 条（非法名与非 function 类型被丢弃）", tools)
	}

	first := testObject(t, tools[0], "tools[0]")
	if first["type"] != "function" {
		t.Fatalf("tools[0].type = %v", first["type"])
	}
	firstFunction := testObject(t, first["function"], "tools[0].function")
	if firstFunction["name"] != "lookup" {
		t.Fatalf("tools[0].function.name = %v", firstFunction["name"])
	}
	if firstFunction["description"] != "lookup" {
		t.Fatalf("tools[0].function.description = %v, want 缺省用名字", firstFunction["description"])
	}
	firstParameters := testObject(t, firstFunction["parameters"], "tools[0].function.parameters")
	if firstParameters["type"] != "object" {
		t.Fatalf("tools[0].function.parameters.type = %v, want 补 object", firstParameters["type"])
	}
	if _, ok := firstParameters["properties"]; !ok {
		t.Fatalf("tools[0].function.parameters 丢了 properties: %v", firstParameters)
	}

	second := testObject(t, tools[1], "tools[1]")
	secondFunction := testObject(t, second["function"], "tools[1].function")
	if secondFunction["name"] != "legacy_tool" || secondFunction["description"] != "legacy" {
		t.Fatalf("tools[1].function = %v", secondFunction)
	}
	if testObject(t, secondFunction["parameters"], "tools[1].parameters")["type"] != "object" {
		t.Fatalf("tools[1].parameters.type != object")
	}
}

func TestBuildBodyParameters(t *testing.T) {
	entry := testEntry()
	entry.IsReasoning = true
	request := map[string]any{
		"model":            "Qwen3.8-Flash",
		"messages":         []any{map[string]any{"role": "user", "content": "hi"}},
		"max_tokens":       64000,
		"temperature":      0.3,
		"top_p":            0.9,
		"stop":             []any{"STOP", "END"},
		"reasoning_effort": "none",
	}
	result := buildTestBody(t, request, entry, "Qwen3.8-Flash", "qoder", "1.1.82")
	if result.IsReasoning {
		t.Fatalf("显式 reasoning_effort=none 时 IsReasoning 必须降级为 false")
	}
	body := decodeTestBody(t, result)
	parameters := testObject(t, body["parameters"], "parameters")
	if testNumber(t, parameters["max_tokens"], "max_tokens") != 32000 {
		t.Fatalf("max_tokens = %v, want 32000 上限", parameters["max_tokens"])
	}
	if testNumber(t, parameters["temperature"], "temperature") != 0.3 {
		t.Fatalf("temperature = %v, want 0.3", parameters["temperature"])
	}
	if testNumber(t, parameters["top_p"], "top_p") != 0.9 {
		t.Fatalf("top_p = %v, want 0.9", parameters["top_p"])
	}
	if got := testStrings(t, parameters["stop"], "stop"); !reflect.DeepEqual(got, []string{"STOP", "END"}) {
		t.Fatalf("stop = %v", got)
	}
	if parameters["enable_thinking"] != false {
		t.Fatalf("enable_thinking = %v, want false", parameters["enable_thinking"])
	}
	if _, exists := parameters["reasoning_effort"]; exists {
		t.Fatalf("thinkingDisabled 时不应写 reasoning_effort: %v", parameters["reasoning_effort"])
	}
	modelConfig := testObject(t, body["model_config"], "model_config")
	if modelConfig["is_reasoning"] != false {
		t.Fatalf("model_config.is_reasoning = %v, want false", modelConfig["is_reasoning"])
	}

	t.Run("string stop", func(t *testing.T) {
		single := map[string]any{
			"model":    "Qwen3.8-Flash",
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
			"stop":     "STOP",
		}
		got := decodeTestBody(t, buildTestBody(t, single, testEntry(), "Qwen3.8-Flash", "qoder", "1.1.82"))
		if testObject(t, got["parameters"], "parameters")["stop"] != "STOP" {
			t.Fatalf("stop = %v", testObject(t, got["parameters"], "parameters")["stop"])
		}
	})

	t.Run("explicit reasoning effort", func(t *testing.T) {
		reasoning := map[string]any{
			"model":            "Qwen3.8-Flash",
			"messages":         []any{map[string]any{"role": "user", "content": "hi"}},
			"reasoning_effort": "HIGH",
		}
		got := decodeTestBody(t, buildTestBody(t, reasoning, entry, "Qwen3.8-Flash", "qoder", "1.1.82"))
		params := testObject(t, got["parameters"], "parameters")
		if params["reasoning_effort"] != "high" {
			t.Fatalf("reasoning_effort = %v, want high", params["reasoning_effort"])
		}
		if _, exists := params["enable_thinking"]; exists {
			t.Fatalf("仅 explicit effort 时不应写 enable_thinking: %v", params["enable_thinking"])
		}
	})

	t.Run("explicit thinking enabled", func(t *testing.T) {
		thinking := map[string]any{
			"model":    "Qwen3.8-Flash",
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
			"thinking": map[string]any{"enabled": true},
		}
		got := decodeTestBody(t, buildTestBody(t, thinking, entry, "Qwen3.8-Flash", "qoder", "1.1.82"))
		params := testObject(t, got["parameters"], "parameters")
		if params["enable_thinking"] != true {
			t.Fatalf("enable_thinking = %v, want true", params["enable_thinking"])
		}
	})
}

func TestBuildBodyModelResolution(t *testing.T) {
	request := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}

	t.Run("unknown model fails closed", func(t *testing.T) {
		raw, err := json.Marshal(request)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		_, err = BuildBody(raw, testEntry(), "gpt-4o", "qoder", "1.1.82", testNowMS)
		if !errors.Is(err, ErrModelNotInCatalog) {
			t.Fatalf("err = %v, want ErrModelNotInCatalog", err)
		}
	})

	t.Run("auto uses passed auto entry", func(t *testing.T) {
		result := buildTestBody(t, request, testAutoEntry(), "auto", "qoder", "1.1.82")
		if result.ModelSource != "auto" || result.ModelKey != "auto" {
			t.Fatalf("ModelSource/ModelKey = %q/%q", result.ModelSource, result.ModelKey)
		}
		modelConfig := testObject(t, decodeTestBody(t, result)["model_config"], "model_config")
		if modelConfig["is_vl"] != true || modelConfig["source"] != "system" {
			t.Fatalf("model_config = %v", modelConfig)
		}
	})

	t.Run("empty model uses auto entry", func(t *testing.T) {
		result := buildTestBody(t, request, testAutoEntry(), "", "qodercn", "1.1.72")
		if result.ModelSource != "auto" {
			t.Fatalf("ModelSource = %q", result.ModelSource)
		}
		if got := decodeTestBody(t, result)["session_type"]; got != "qoderclicn" {
			t.Fatalf("session_type = %v, want qoderclicn", got)
		}
	})

	t.Run("provider name resolves to auto", func(t *testing.T) {
		result := buildTestBody(t, request, testAutoEntry(), "Qoder", "qoder", "1.1.82")
		if result.ModelSource != "auto" {
			t.Fatalf("ModelSource = %q", result.ModelSource)
		}
	})

	t.Run("key match is case insensitive", func(t *testing.T) {
		result := buildTestBody(t, request, testEntry(), "QFMODEL", "qoder", "1.1.82")
		if result.ModelKey != "qfmodel" || result.ModelSource != "catalog" {
			t.Fatalf("ModelKey/ModelSource = %q/%q", result.ModelKey, result.ModelSource)
		}
	})
}

func TestBuildBodyModelConfigFollowsEntry(t *testing.T) {
	entry := modelcatalog.Entry{
		Key:            "qvl",
		DisplayName:    "Qwen3-VL",
		Format:         "openai",
		Source:         "system",
		IsVl:           true,
		IsReasoning:    true,
		MaxInputTokens: 128000,
	}
	request := map[string]any{
		"model":    "Qwen3-VL",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}
	result := buildTestBody(t, request, entry, "Qwen3-VL", "qoder", "1.1.82")
	want := map[string]any{
		"key":              "qvl",
		"display_name":     "Qwen3-VL",
		"model":            "",
		"format":           "openai",
		"is_vl":            true,
		"is_reasoning":     true,
		"api_key":          "",
		"url":              "",
		"source":           "system",
		"max_input_tokens": 128000,
	}
	if !reflect.DeepEqual(result.ModelConfig, want) {
		t.Fatalf("ModelConfig = %#v, want %#v", result.ModelConfig, want)
	}
	body := decodeTestBody(t, result)
	modelConfig := testObject(t, body["model_config"], "model_config")
	if modelConfig["is_vl"] != true || modelConfig["is_reasoning"] != true || modelConfig["max_input_tokens"] != json.Number("128000") {
		t.Fatalf("body.model_config = %v", modelConfig)
	}
	if !result.IsReasoning {
		t.Fatalf("IsReasoning = false, want true")
	}
}

func TestBuildBodyPromptRequired(t *testing.T) {
	cases := map[string]map[string]any{
		"no messages": {"model": "Qwen3.8-Flash"},
		"system only": {
			"model":    "Qwen3.8-Flash",
			"messages": []any{map[string]any{"role": "system", "content": "你是助手。"}},
		},
	}
	for name, request := range cases {
		t.Run(name, func(t *testing.T) {
			raw, err := json.Marshal(request)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			_, err = BuildBody(raw, testEntry(), "Qwen3.8-Flash", "qoder", "1.1.82", testNowMS)
			if !errors.Is(err, ErrPromptRequired) {
				t.Fatalf("err = %v, want ErrPromptRequired", err)
			}
		})
	}
}
