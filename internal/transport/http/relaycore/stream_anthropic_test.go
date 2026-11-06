package relaycore

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// anthropicStreamFixture 是 zcode 真机事件的回放：thinking → text → tool_use，
// 工具参数分两片下发。
//
// 内容块序号刻意排成 0/1/2：工具调用排在第三个块，用来证明 OpenAI 的
// tool_calls[].index 是**重新编号**的，而不是照抄 Anthropic 的块序号。
const anthropicStreamFixture = `event: message_start
data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"glm-5.3-flash","content":[],"stop_reason":null,"usage":{"input_tokens":1000,"output_tokens":1,"cache_read_input_tokens":80,"cache_creation_input_tokens":3}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想一下"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"世界"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":2}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}

event: message_stop
data: {"type":"message_stop"}

`

// openAIStreamFixture 是 OpenAI 兼容上游的既有形态：带上游私有字段 x_vendor，
// 用来证明透传分支一个字节都没动。
const openAIStreamFixture = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"x_vendor":"keep-me"}

data: [DONE]

`

// anthropicNoArgumentToolFixture 是「无参工具」：上游没有任何 input_json_delta。
// 也刻意不带 message_start，用来覆盖兜底 id 与块首事件判定。
const anthropicNoArgumentToolFixture = `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"list_dir","input":{}}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`

// streamedChunk 是客户端视角的 chunk 形态，字段名与 OpenAI 协议一致。
type streamedChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role             string `json:"role"`
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		TotalTokens         int `json:"total_tokens"`
		PromptTokensDetails struct {
			CachedTokens     int `json:"cached_tokens"`
			CacheWriteTokens int `json:"cache_write_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
}

// runStreamingRelay 走真实的 writeResponse 流式分支（上游 200 + text/event-stream）。
//
// 为什么不直接调转换器：这次修复的一半是**分派**（按上游协议决定转换还是透传），
// 只测转换器会漏掉「OpenAI 上游被误转」这类回归。
func runStreamingRelay(t *testing.T, upstreamBody string) *httptest.ResponseRecorder {
	t.Helper()
	handler := &Handler{clock: fixedClock}
	upstream := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(upstreamBody)),
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("{}"))
	recorder := httptest.NewRecorder()
	handler.writeResponse(recorder, request, attemptOutcome{response: upstream}, true)
	return recorder
}

// parseChatChunks 把响应正文按 SSE 帧切开，并断言每一帧都是 data: 形式。
func parseChatChunks(t *testing.T, body string) ([]streamedChunk, bool) {
	t.Helper()
	chunks := make([]streamedChunk, 0, 8)
	sawDone := false
	for _, frame := range strings.Split(body, "\n\n") {
		frame = strings.TrimSpace(frame)
		if frame == "" {
			continue
		}
		if !strings.HasPrefix(frame, "data: ") {
			t.Fatalf("帧不是 data: 形式: %q", frame)
		}
		payload := strings.TrimSpace(strings.TrimPrefix(frame, "data: "))
		if payload == "[DONE]" {
			sawDone = true
			continue
		}
		var chunk streamedChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			t.Fatalf("帧不是合法 JSON: %v (%q)", err, payload)
		}
		chunks = append(chunks, chunk)
	}
	return chunks, sawDone
}

// 真机事故的回归守卫：Anthropic 事件流必须变成 OpenAI chunk 序列。
func TestWriteUpstreamStreamConvertsAnthropicToChatChunks(t *testing.T) {
	recorder := runStreamingRelay(t, anthropicStreamFixture)
	body := recorder.Body.String()

	// 任何 Anthropic 事件漏出来都会让客户端读不到 choices，这里直接兜住。
	if strings.Contains(body, "event: ") || strings.Contains(body, "message_start") {
		t.Fatalf("响应里仍有 Anthropic 事件原文:\n%s", body)
	}

	chunks, sawDone := parseChatChunks(t, body)
	if !sawDone {
		t.Fatal("流末尾缺少 data: [DONE]")
	}
	if len(chunks) == 0 {
		t.Fatal("没有产出任何 chunk")
	}
	first := chunks[0]
	if first.Object != "chat.completion.chunk" {
		t.Fatalf("object = %q, want chat.completion.chunk", first.Object)
	}
	if first.ID != "msg_01" || first.Model != "glm-5.3-flash" {
		t.Fatalf("首帧 id/model = %q/%q, want msg_01/glm-5.3-flash", first.ID, first.Model)
	}
	if want := fixedClock().UnixMilli() / 1000; first.Created != want {
		t.Fatalf("created = %d, want %d", first.Created, want)
	}
	if got := first.Choices[0].Delta.Role; got != "assistant" {
		t.Fatalf("首帧 role = %q, want assistant", got)
	}

	var content, reasoning, arguments strings.Builder
	var toolIndexes []int
	var toolID, toolName string
	for _, chunk := range chunks {
		if chunk.Object != "chat.completion.chunk" {
			t.Fatalf("帧不是 chat.completion.chunk: %+v", chunk)
		}
		for _, choice := range chunk.Choices {
			content.WriteString(choice.Delta.Content)
			reasoning.WriteString(choice.Delta.ReasoningContent)
			for _, call := range choice.Delta.ToolCalls {
				toolIndexes = append(toolIndexes, call.Index)
				if call.ID != "" {
					toolID = call.ID
				}
				if call.Function.Name != "" {
					toolName = call.Function.Name
				}
				arguments.WriteString(call.Function.Arguments)
			}
		}
	}
	if got := content.String(); got != "你好世界" {
		t.Fatalf("content 增量拼起来 = %q, want 你好世界", got)
	}
	// thinking 只走流式：OpenAI 生态用 reasoning_content 承载，丢了客户端就看不到推理。
	if got := reasoning.String(); got != "先想一下" {
		t.Fatalf("reasoning_content 增量拼起来 = %q, want 先想一下", got)
	}
	if len(toolIndexes) == 0 {
		t.Fatal("没有产出 tool_calls 增量")
	}
	for _, index := range toolIndexes {
		if index != 0 {
			t.Fatalf("tool_calls[].index = %d, want 0（块序号 2 必须重编成工具序号 0）", index)
		}
	}
	if toolID != "toolu_1" || toolName != "read_file" {
		t.Fatalf("tool id/name = %q/%q, want toolu_1/read_file", toolID, toolName)
	}
	if got := arguments.String(); got != `{"path":"a.txt"}` {
		t.Fatalf("arguments 分片拼起来 = %q", got)
	}

	finish := chunks[len(chunks)-1]
	if finish.Choices[0].FinishReason == nil || *finish.Choices[0].FinishReason != "tool_calls" {
		t.Fatalf("finish_reason = %v, want tool_calls", finish.Choices[0].FinishReason)
	}
	if finish.Usage == nil {
		t.Fatal("收尾帧缺少 usage")
	}
	// 与非流式同一口径：prompt_tokens = input + cache_read + cache_write。
	if got := finish.Usage.PromptTokens; got != 1083 {
		t.Fatalf("prompt_tokens = %d, want 1083", got)
	}
	if got := finish.Usage.CompletionTokens; got != 9 {
		t.Fatalf("completion_tokens = %d, want 9", got)
	}
	if got := finish.Usage.TotalTokens; got != 1092 {
		t.Fatalf("total_tokens = %d, want 1092", got)
	}
	if got := finish.Usage.PromptTokensDetails.CachedTokens; got != 80 {
		t.Fatalf("cached_tokens = %d, want 80", got)
	}
	if got := finish.Usage.PromptTokensDetails.CacheWriteTokens; got != 3 {
		t.Fatalf("cache_write_tokens = %d, want 3", got)
	}
}

// 回归：OpenAI 兼容上游必须逐字节透传——分派逻辑不能把它们也转一遍。
func TestWriteUpstreamStreamPassesOpenAIStreamThrough(t *testing.T) {
	recorder := runStreamingRelay(t, openAIStreamFixture)
	if got := recorder.Body.String(); got != openAIStreamFixture {
		t.Fatalf("OpenAI 兼容上游被改写:\n got: %q\nwant: %q", got, openAIStreamFixture)
	}
}

// 心跳在前：协议判定必须跳过 ping，不能因为首帧是心跳就放弃转换。
func TestWriteUpstreamStreamConvertsAfterPing(t *testing.T) {
	prefixed := "event: ping\ndata: {\"type\":\"ping\"}\n\n" + anthropicStreamFixture
	recorder := runStreamingRelay(t, prefixed)
	chunks, sawDone := parseChatChunks(t, recorder.Body.String())
	if !sawDone || len(chunks) == 0 {
		t.Fatalf("心跳之后的 Anthropic 事件没有被转换（chunks=%d, done=%v）", len(chunks), sawDone)
	}
	if got := chunks[0].Choices[0].Delta.Role; got != "assistant" {
		t.Fatalf("首帧 role = %q, want assistant", got)
	}
}

// 无参工具必须补 "{}"：客户端会对空 arguments 做 JSON.parse 而报错。
func TestWriteUpstreamStreamFillsEmptyToolArguments(t *testing.T) {
	recorder := runStreamingRelay(t, anthropicNoArgumentToolFixture)
	chunks, _ := parseChatChunks(t, recorder.Body.String())
	var arguments []string
	for _, chunk := range chunks {
		for _, choice := range chunk.Choices {
			for _, call := range choice.Delta.ToolCalls {
				arguments = append(arguments, call.Function.Arguments)
			}
		}
	}
	var joined strings.Builder
	for _, value := range arguments {
		joined.WriteString(value)
	}
	if got := joined.String(); got != "{}" {
		t.Fatalf("无参工具的 arguments = %q, want {}", got)
	}
}
