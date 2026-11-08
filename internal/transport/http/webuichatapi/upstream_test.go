package webuichatapi

import (
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// lineBreak 是 LF。用常量而不是转义字面量，测试里的帧文本才读得清。
const lineBreak = string(byteLF)

// byteAtATimeReader 每次只返回一个字节，用来证明分帧不依赖单次 Read 的边界。
type byteAtATimeReader struct {
	data []byte
}

func (reader *byteAtATimeReader) Read(payload []byte) (int, error) {
	if len(reader.data) == 0 {
		return 0, io.EOF
	}
	payload[0] = reader.data[0]
	reader.data = reader.data[1:]
	return 1, nil
}

// frame 拼一个 SSE 数据帧（data + 空行）。
func frame(payload string) string {
	return "data: " + payload + lineBreak + lineBreak
}

// readAllChunks 读完整条流，返回所有正文增量与结束原因。
func readAllChunks(t *testing.T, reader io.Reader) ([]string, string, inference.Usage, bool) {
	t.Helper()
	stream := newChatStreamReader(reader)
	contents := make([]string, 0, 4)
	finishReason := ""
	for {
		next, ok, err := stream.Next()
		if err != nil {
			t.Fatalf("Next() error = %v", err)
		}
		if !ok {
			break
		}
		if next.Content != "" {
			contents = append(contents, next.Content)
		}
		if next.FinishReason != "" {
			finishReason = next.FinishReason
		}
	}
	usage, hasUsage := stream.Result()
	return contents, finishReason, usage, hasUsage
}

// 常规流：注释帧、首帧 role、两次正文、收尾帧带 usage、[DONE]。
func TestChatStreamReaderReadsDeltasAndUsage(t *testing.T) {
	payload := strings.Join([]string{
		": keep-alive" + lineBreak + lineBreak,
		frame(`{"choices":[{"delta":{"role":"assistant"}}]}`),
		frame(`{"choices":[{"delta":{"content":"你"}}]}`),
		frame(`{"choices":[{"delta":{"content":"好"}}]}`),
		frame(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}`),
		frame("[DONE]"),
	}, "")
	contents, finishReason, usage, hasUsage := readAllChunks(t, strings.NewReader(payload))
	if got := strings.Join(contents, ""); got != "你好" {
		t.Fatalf("正文 = %q, want 你好", got)
	}
	if finishReason != "stop" {
		t.Fatalf("finish_reason = %q, want stop", finishReason)
	}
	if !hasUsage {
		t.Fatal("没有读出用量")
	}
	if usage.InputTokens() != 12 || usage.OutputTokens() != 2 {
		t.Fatalf("usage = %d/%d, want 12/2", usage.InputTokens(), usage.OutputTokens())
	}
}

// 字节级分帧：每次 Read 只给一个字节，帧边界、CRLF、注释都不能影响结果。
func TestChatStreamReaderSurvivesByteWiseReads(t *testing.T) {
	crlf := string(byteCR) + string(byteLF)
	payload := strings.Join([]string{
		": heartbeat" + crlf + crlf,
		"event: message" + crlf,
		"data: " + `{"choices":[{"delta":{"content":"a"}}]}` + crlf + crlf,
		"data: " + `{"choices":[{"delta":{"content":"b"}}]}` + crlf + crlf,
		"data: [DONE]" + crlf + crlf,
	}, "")
	contents, _, _, _ := readAllChunks(t, &byteAtATimeReader{data: []byte(payload)})
	if got := strings.Join(contents, ""); got != "ab" {
		t.Fatalf("正文 = %q, want ab", got)
	}
}

// 同一批 Read 里出现多帧时不能丢帧。
func TestChatStreamReaderReadsSeveralFramesInOneChunk(t *testing.T) {
	payload := frame(`{"choices":[{"delta":{"content":"1"}}]}`) +
		frame(`{"choices":[{"delta":{"content":"2"}}]}`) +
		frame("[DONE]")
	contents, _, _, _ := readAllChunks(t, strings.NewReader(payload))
	if got := strings.Join(contents, ""); got != "12" {
		t.Fatalf("正文 = %q, want 12", got)
	}
}

// 没有空行收尾的最后一帧必须被交付，不能等下一个空行。
func TestChatStreamReaderFlushesTrailingFrame(t *testing.T) {
	payload := `data: {"choices":[{"delta":{"content":"尾巴"}}]}`
	contents, _, _, _ := readAllChunks(t, strings.NewReader(payload))
	if got := strings.Join(contents, ""); got != "尾巴" {
		t.Fatalf("正文 = %q, want 尾巴", got)
	}
}

// 上游用 200 + 错误信封代替内容时必须报错，不能当成空回复。
func TestChatStreamReaderRejectsErrorEnvelope(t *testing.T) {
	payload := frame(`{"error":{"message":"quota exceeded","type":"insufficient_quota"}}`)
	stream := newChatStreamReader(strings.NewReader(payload))
	_, _, err := stream.Next()
	if err == nil {
		t.Fatal("错误信封没有被识别")
	}
	var upstream *upstreamError
	if !errors.As(err, &upstream) {
		t.Fatalf("错误类型 = %T, want *upstreamError", err)
	}
	if upstream.Code != "chat_upstream_error" || upstream.Message != "quota exceeded" {
		t.Fatalf("upstreamError = %+v", upstream)
	}
}

// 无法解析的数据帧要报明确错误，而不是静默跳过整条流。
func TestChatStreamReaderRejectsMalformedFrame(t *testing.T) {
	stream := newChatStreamReader(strings.NewReader(frame("{not json}")))
	_, _, err := stream.Next()
	if err == nil {
		t.Fatal("损坏的帧没有报错")
	}
	var upstream *upstreamError
	if !errors.As(err, &upstream) || upstream.Code != "chat_upstream_frame_invalid" {
		t.Fatalf("错误 = %v, want chat_upstream_frame_invalid", err)
	}
}

// 用量取最大值而不是相加：上游既有累计值也有增量写法。
func TestUsageAccumulatorTakesMaximum(t *testing.T) {
	accumulator := usageAccumulator{}
	accumulator.absorb([]byte(`{"usage":{"prompt_tokens":10,"completion_tokens":3}}`))
	accumulator.absorb([]byte(`{"usage":{"prompt_tokens":10,"completion_tokens":9,"completion_tokens_details":{"reasoning_tokens":4}}}`))
	usage, ok := accumulator.result()
	if !ok {
		t.Fatal("没有读出用量")
	}
	if usage.InputTokens() != 10 || usage.OutputTokens() != 9 || usage.ReasoningTokens() != 4 {
		t.Fatalf("usage = %d/%d/%d", usage.InputTokens(), usage.OutputTokens(), usage.ReasoningTokens())
	}
}

// 缓存命中值大于输入时并入输入，否则领域校验会拒绝整条用量。
func TestUsageAccumulatorClampsCachedAboveInput(t *testing.T) {
	accumulator := usageAccumulator{}
	accumulator.absorb([]byte(`{"usage":{"prompt_tokens":5,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":40}}}`))
	usage, ok := accumulator.result()
	if !ok {
		t.Fatal("没有读出用量")
	}
	if usage.InputTokens() != 40 || usage.CachedInputTokens() != 40 {
		t.Fatalf("usage = %d/%d, want 40/40", usage.InputTokens(), usage.CachedInputTokens())
	}
}

// 非流式回退：整段 chat.completion 也要能读成一块增量并带来用量。
func TestReadChatCompletionDocument(t *testing.T) {
	document := `{"choices":[{"message":{"role":"assistant","content":"整段"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}`
	result, usage, hasUsage, err := readChatCompletionDocument(strings.NewReader(document))
	if err != nil {
		t.Fatalf("readChatCompletionDocument() error = %v", err)
	}
	if result.Content != "整段" {
		t.Fatalf("content = %q, want 整段", result.Content)
	}
	if !hasUsage || usage.OutputTokens() != 3 {
		t.Fatalf("usage = %+v, hasUsage = %v", usage, hasUsage)
	}
}
