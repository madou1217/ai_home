package relaycore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// usageScanLimit 是扫描器保留的最大字节数。
//
// 用量只出现在流的尾部（OpenAI 的最后一个 chunk、Anthropic 的 message_delta），
// 但流可能很长，不能整段缓存。保留滚动窗口：够覆盖一个超大 usage 事件即可。
const usageScanLimit = 64 * 1024

// UsageRecorder 接收一次透传请求的真实 token 用量。
//
// 为什么不在 success 里带上：成功记账要在**首个字节交付之前**完成（账号健康不能
// 等整条流），而用量只能等流结束才知道。两件事分开记，语义各自准确。
type UsageRecorder interface {
	RecordAttemptUsage(ctx context.Context, route runtimecore.ModelRoute, usage inference.Usage) error
}

// usageAccumulator 从响应字节里提取 token 用量。
//
// 支持两种主流形态，其余一律忽略（宁可不记，也不猜）：
//   - OpenAI chat.completion{,.chunk}：usage.{prompt_tokens,completion_tokens,
//     prompt_tokens_details.cached_tokens,completion_tokens_details.reasoning_tokens}
//   - Anthropic messages 流：message_start.message.usage.{input_tokens,
//     cache_read_input_tokens,cache_creation_input_tokens} + message_delta.usage.output_tokens
//
// 多帧重复上报时取**最大值**：上游既有「累计值」也有「本帧增量」的写法，
// 取最大值对两种都正确，相加则会把累计值重复计算。
type usageAccumulator struct {
	input      uint64
	output     uint64
	cached     uint64
	cacheWrite uint64
	reasoning  uint64
	found      bool
}

// observe 吸收一个 JSON 负载；返回是否读到了用量字段。
func (accumulator *usageAccumulator) observe(payload []byte) bool {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var event map[string]any
	if err := decoder.Decode(&event); err != nil {
		return false
	}
	changed := false
	// OpenAI 形态。
	if usage, ok := event["usage"].(map[string]any); ok {
		changed = accumulator.absorbOpenAIUsage(usage) || changed
	}
	// Anthropic 形态：message_start 的 usage 在 message 下，message_delta 的在顶层。
	if message, ok := event["message"].(map[string]any); ok {
		if usage, ok := message["usage"].(map[string]any); ok {
			changed = accumulator.absorbAnthropicUsage(usage) || changed
		}
	}
	if usage, ok := event["usage"].(map[string]any); ok {
		changed = accumulator.absorbAnthropicUsage(usage) || changed
	}
	return changed
}

func (accumulator *usageAccumulator) absorbOpenAIUsage(usage map[string]any) bool {
	changed := false
	changed = accumulator.maxInto(&accumulator.input, usage["prompt_tokens"]) || changed
	changed = accumulator.maxInto(&accumulator.output, usage["completion_tokens"]) || changed
	if details, ok := usage["prompt_tokens_details"].(map[string]any); ok {
		changed = accumulator.maxInto(&accumulator.cached, details["cached_tokens"]) || changed
	}
	if details, ok := usage["completion_tokens_details"].(map[string]any); ok {
		changed = accumulator.maxInto(&accumulator.reasoning, details["reasoning_tokens"]) || changed
	}
	return changed
}

func (accumulator *usageAccumulator) absorbAnthropicUsage(usage map[string]any) bool {
	changed := false
	changed = accumulator.maxInto(&accumulator.input, usage["input_tokens"]) || changed
	changed = accumulator.maxInto(&accumulator.output, usage["output_tokens"]) || changed
	changed = accumulator.maxInto(&accumulator.cached, usage["cache_read_input_tokens"]) || changed
	changed = accumulator.maxInto(&accumulator.cacheWrite, usage["cache_creation_input_tokens"]) || changed
	return changed
}

// maxInto 取最大值；字段不是非负整数时视为没有该字段。
func (accumulator *usageAccumulator) maxInto(target *uint64, value any) bool {
	number, ok := value.(json.Number)
	if !ok {
		return false
	}
	parsed, err := number.Int64()
	if err != nil || parsed < 0 {
		return false
	}
	if uint64(parsed) <= *target {
		return false
	}
	*target = uint64(parsed)
	accumulator.found = true
	return true
}

// result 生成领域用量。
//
// Anthropic 的 input_tokens 不含缓存读写，而领域模型要求
// cached + cacheWrite ≤ input；这里把缓存部分并进输入，避免整条记录被校验拒绝。
func (accumulator *usageAccumulator) result() (inference.Usage, bool) {
	if !accumulator.found {
		return inference.Usage{}, false
	}
	input := accumulator.input
	if cached := accumulator.cached + accumulator.cacheWrite; cached > input {
		input = cached
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           input,
		OutputTokens:          accumulator.output,
		CachedInputTokens:     accumulator.cached,
		CacheWriteInputTokens: accumulator.cacheWrite,
		ReasoningTokens:       accumulator.reasoning,
	})
	if err != nil {
		return inference.Usage{}, false
	}
	return usage, true
}

// usageScanner 是「边转发边解析」的写入端：只保留滚动窗口，流式场景不做整段缓存。
type usageScanner struct {
	mu          sync.Mutex
	buffer      []byte
	pending     []byte
	accumulator usageAccumulator
}

// Write 由 io.TeeReader 调用；只做缓冲与按行解析，不阻塞转发。
func (scanner *usageScanner) Write(payload []byte) (int, error) {
	scanner.mu.Lock()
	defer scanner.mu.Unlock()
	scanner.buffer = append(scanner.buffer, payload...)
	scanner.scanLines(false)
	if len(scanner.buffer) > usageScanLimit {
		scanner.buffer = scanner.buffer[len(scanner.buffer)-usageScanLimit:]
	}
	return len(payload), nil
}

// scanLines 按行解析 data: 负载；flush=true 时处理没有换行结尾的最后一行。
func (scanner *usageScanner) scanLines(flush bool) {
	for {
		index := bytes.IndexByte(scanner.buffer, '\n')
		if index < 0 {
			break
		}
		line := bytes.TrimSpace(scanner.buffer[:index])
		scanner.buffer = scanner.buffer[index+1:]
		scanner.consumeLine(line)
	}
	if flush {
		line := bytes.TrimSpace(scanner.buffer)
		scanner.buffer = nil
		scanner.consumeLine(line)
	}
}

func (scanner *usageScanner) consumeLine(line []byte) {
	if len(line) == 0 || bytes.Equal(line, []byte("data: [DONE]")) {
		return
	}
	if bytes.HasPrefix(line, []byte("data:")) {
		scanner.accumulator.observe(bytes.TrimSpace(line[len("data:"):]))
		return
	}
	// 非 SSE 的整段 JSON（非流式响应）：整段喂给解析器。
	if line[0] == '{' {
		scanner.accumulator.observe(line)
	}
}

// finish 收尾：把缓冲里剩下的内容解析掉，返回最终用量。
func (scanner *usageScanner) finish() (inference.Usage, bool) {
	scanner.mu.Lock()
	defer scanner.mu.Unlock()
	scanner.scanLines(true)
	// 非流式响应可能是一个多行 JSON：整段再试一次。
	if !scanner.accumulator.found && len(scanner.buffer) > 0 {
		scanner.accumulator.observe(scanner.buffer)
	}
	return scanner.accumulator.result()
}

// usageTee 在转发的同时解析用量；读尽或关闭时结算一次，绝不重复结算。
type usageTee struct {
	source  io.ReadCloser
	scanner *usageScanner
	once    sync.Once
	emit    func(inference.Usage)
}

func newUsageTee(source io.ReadCloser, emit func(inference.Usage)) *usageTee {
	return &usageTee{source: source, scanner: &usageScanner{}, emit: emit}
}

func (tee *usageTee) Read(payload []byte) (int, error) {
	read, err := tee.source.Read(payload)
	if read > 0 {
		_, _ = tee.scanner.Write(payload[:read])
	}
	if errors.Is(err, io.EOF) {
		tee.settle()
	}
	return read, err
}

func (tee *usageTee) Close() error {
	tee.settle()
	return tee.source.Close()
}

// settle 幂等：Read 到 EOF 与上层 Close 都会触发，重复结算会把同一笔用量记两次。
func (tee *usageTee) settle() {
	tee.once.Do(func() {
		if usage, ok := tee.scanner.finish(); ok && tee.emit != nil {
			tee.emit(usage)
		}
	})
}
