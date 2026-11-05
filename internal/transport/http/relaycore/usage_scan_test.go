package relaycore

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

const (
	openAIFirstChunk  = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}"
	openAIUsageChunk  = "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":45,\"prompt_tokens_details\":{\"cached_tokens\":20},\"completion_tokens_details\":{\"reasoning_tokens\":15}}}"
	anthropicStart    = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":300,\"cache_read_input_tokens\":100,\"cache_creation_input_tokens\":50,\"output_tokens\":1}}}"
	anthropicDelta    = "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":220}}"
	nonStreamingUsage = "{\"id\":\"x\",\"choices\":[{\"message\":{\"content\":\"ok\"}}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}"
)

func scanUsage(t *testing.T, payload string) (inference.Usage, bool) {
	t.Helper()
	scanner := &usageScanner{}
	if _, err := scanner.Write([]byte(payload)); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	return scanner.finish()
}

func assertUsage(t *testing.T, usage inference.Usage, ok bool, want inference.UsageInput) {
	t.Helper()
	if !ok {
		t.Fatal("没有解析出用量")
	}
	wantUsage, err := inference.NewUsage(want)
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	if usage != wantUsage {
		t.Fatalf("usage = %+v, want %+v", usage, wantUsage)
	}
}

// OpenAI 流：用量只在最后一个 chunk；前面的数据帧不能被误判成错误。
func TestUsageScannerReadsOpenAIStreamChunk(t *testing.T) {
	payload := strings.Join([]string{openAIFirstChunk, openAIUsageChunk, "data: [DONE]", ""}, "\n\n")
	usage, ok := scanUsage(t, payload)
	assertUsage(t, usage, ok, inference.UsageInput{
		InputTokens:       120,
		OutputTokens:      45,
		CachedInputTokens: 20,
		ReasoningTokens:   15,
	})
}

// Anthropic 流：输入在 message_start，输出在 message_delta；两帧要合并。
func TestUsageScannerMergesAnthropicFrames(t *testing.T) {
	payload := strings.Join([]string{
		"event: message_start",
		anthropicStart,
		"",
		"event: message_delta",
		anthropicDelta,
		"",
	}, "\n\n")
	usage, ok := scanUsage(t, payload)
	// input 300 已包含缓存读写，直接采用；output 取两帧最大值 220。
	assertUsage(t, usage, ok, inference.UsageInput{
		InputTokens:           300,
		OutputTokens:          220,
		CachedInputTokens:     100,
		CacheWriteInputTokens: 50,
	})
}

// 缓存大于输入时并入输入：否则领域模型校验失败，整条用量会丢。
func TestUsageScannerClampsCacheLargerThanInput(t *testing.T) {
	payload := "data: {\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":200}}\n\n"
	usage, ok := scanUsage(t, payload)
	assertUsage(t, usage, ok, inference.UsageInput{
		InputTokens:           1000,
		OutputTokens:          5,
		CachedInputTokens:     800,
		CacheWriteInputTokens: 200,
	})
}

// 多帧重复上报同一个累计值时不能相加，只能取最大。
func TestUsageScannerTakesMaximumAcrossFrames(t *testing.T) {
	payload := strings.Join([]string{
		"data: {\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":10}}",
		"data: {\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":40}}",
		"",
	}, "\n\n")
	usage, ok := scanUsage(t, payload)
	assertUsage(t, usage, ok, inference.UsageInput{InputTokens: 100, OutputTokens: 40})
}

// 非流式响应是一段完整 JSON，同样要能取到用量。
func TestUsageScannerReadsNonStreamingJSON(t *testing.T) {
	usage, ok := scanUsage(t, nonStreamingUsage+"\n")
	assertUsage(t, usage, ok, inference.UsageInput{InputTokens: 7, OutputTokens: 3})
}

// 没有用量字段时不能凭空造一条 0 用量记录。
func TestUsageScannerReportsNothingWithoutUsage(t *testing.T) {
	if _, ok := scanUsage(t, "data: {\"choices\":[]}\n\ndata: [DONE]\n\n"); ok {
		t.Fatal("没有 usage 字段却返回了用量")
	}
	if _, ok := scanUsage(t, "not json at all"); ok {
		t.Fatal("非 JSON 负载却返回了用量")
	}
}

type fakeUsageRecorder struct {
	records []inference.Usage
}

func (fake *fakeUsageRecorder) RecordAttemptUsage(
	_ context.Context,
	_ runtimecore.ModelRoute,
	usage inference.Usage,
) error {
	fake.records = append(fake.records, usage)
	return nil
}

// 结算必须幂等：Read 到 EOF 与 Close 都会触发，重复结算会把同一笔用量记两次。
func TestUsageTeeSettlesOnce(t *testing.T) {
	recorder := &fakeUsageRecorder{}
	body := strings.NewReader("data: {\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":6}}\n\n")
	tee := newUsageTee(io.NopCloser(body), func(usage inference.Usage) {
		recorder.records = append(recorder.records, usage)
	})
	if _, err := io.ReadAll(tee); err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if err := tee.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if len(recorder.records) != 1 {
		t.Fatalf("记录了 %d 次用量，want 1", len(recorder.records))
	}
}

// 读取出错（如上中断）时仍要保留已经解析到的用量。
func TestUsageTeeSettlesOnReadError(t *testing.T) {
	recorder := &fakeUsageRecorder{}
	source := &failingReader{
		payload: []byte("data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1}}\n\n"),
	}
	tee := newUsageTee(io.NopCloser(source), func(usage inference.Usage) {
		recorder.records = append(recorder.records, usage)
	})
	_, _ = io.ReadAll(tee)
	if err := tee.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if len(recorder.records) != 1 {
		t.Fatalf("记录了 %d 次用量，want 1", len(recorder.records))
	}
}

// failingReader 先吐完数据再返回错误（模拟上游中断）。
type failingReader struct {
	payload []byte
	done    bool
}

func (reader *failingReader) Read(p []byte) (int, error) {
	if reader.done {
		return 0, errors.New("upstream reset")
	}
	reader.done = true
	return copy(p, reader.payload), nil
}

// 挂载点必须真的挂上：挂不上等于账本永远为空，而且不会报任何错。
func TestTrackUsageWrapsBodyWhenRecorderConfigured(t *testing.T) {
	recorder := &fakeUsageRecorder{}
	handler := &Handler{usage: recorder}
	route := runtimecore.ModelRoute{} // 无效路由：这里只验证「挂载 + 结算」，不验证落库
	body := handler.trackUsage(context.Background(), route, io.NopCloser(
		strings.NewReader("data: {\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2}}\n\n"),
	))
	if body == nil {
		t.Fatal("trackUsage 返回空 body")
	}
	if _, err := io.ReadAll(body); err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if err := body.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if len(recorder.records) != 1 {
		t.Fatalf("记录了 %d 次用量，want 1（挂载点没生效）", len(recorder.records))
	}
}

// 没有用量端口时必须原样返回，不能把 body 吃掉。
func TestTrackUsagePassesThroughWithoutRecorder(t *testing.T) {
	handler := &Handler{}
	original := io.NopCloser(strings.NewReader("payload"))
	if handler.trackUsage(context.Background(), runtimecore.ModelRoute{}, original) != original {
		t.Fatal("没有 recorder 时不应包装 body")
	}
}
