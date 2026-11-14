package chatruntime

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

// claudeStreamInput 把初始输入、steer 和 result 串成同一个有界生命周期。
// pending 包含正在执行的一轮；每次完整写入预登记一轮，每个成功 result 消一轮。
// 不保存输入队列；stdin 自身的背压决定调用方何时返回。
type claudeStreamInput struct {
	mu       sync.Mutex
	writeMu  sync.Mutex
	stdin    io.WriteCloser
	pending  uint64
	terminal bool
	aborted  bool
	failed   bool
	expected bool
}

func (input *claudeStreamInput) write(ctx context.Context, line string) error {
	// 等待 stdin 时不占状态锁，取消/错误 result 可以关闭管道解除阻塞。
	input.writeMu.Lock()
	defer input.writeMu.Unlock()
	input.mu.Lock()
	if ctx.Err() != nil {
		input.mu.Unlock()
		return ctx.Err()
	}
	if input.terminal || input.stdin == nil {
		input.mu.Unlock()
		return NewError("native_session_run_not_active", http.StatusConflict, nil)
	}
	if input.pending == ^uint64(0) {
		input.mu.Unlock()
		return NewError("native_steer_queue_full", http.StatusConflict, nil)
	}
	input.pending++
	stdin := input.stdin
	input.mu.Unlock()

	n, err := io.WriteString(stdin, line)
	if err == nil && n != len(line) {
		err = io.ErrShortWrite
	}
	if err != nil {
		// 部分 JSONL 已写入时不能退账后继续运行；失败关闭，绝不静默丢掉 steer。
		input.mu.Lock()
		input.failed = true
		input.terminal = true
		input.mu.Unlock()
		_ = stdin.Close()
	}
	return err
}

func (input *claudeStreamInput) steer(ctx context.Context, content string) error {
	content = strings.TrimSpace(content)
	if content == "" {
		return NewError("native_session_input_empty", http.StatusBadRequest, nil)
	}
	return input.write(ctx, sessionchat.BuildClaudeStreamJSONUserMessage(content, nil))
}

// result 在末次成功结果或错误结果上关闸；并发 steer 要么已登记，要么明确拒绝。
func (input *claudeStreamInput) result(failed bool) bool {
	input.mu.Lock()
	defer input.mu.Unlock()
	if failed {
		input.failed = true
		input.terminal = true
		return true
	}
	if input.terminal {
		return false
	}
	if input.pending > 0 {
		input.pending--
	}
	if input.pending != 0 {
		return false
	}
	input.expected = true
	input.terminal = true
	return true
}

func (input *claudeStreamInput) close() {
	input.mu.Lock()
	input.terminal = true
	stdin := input.stdin
	input.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
}

func (input *claudeStreamInput) abort() {
	input.mu.Lock()
	// 末次 result 已先关闸时，迟到 abort 不应将已完成结果反转为取消。
	if !input.terminal {
		input.aborted = true
	}
	input.terminal = true
	stdin := input.stdin
	input.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
}

func (input *claudeStreamInput) expectedExit() bool {
	input.mu.Lock()
	defer input.mu.Unlock()
	return input.expected && !input.failed && !input.aborted
}

func (input *claudeStreamInput) writeFailed() bool {
	input.mu.Lock()
	defer input.mu.Unlock()
	return input.failed
}

func (input *claudeStreamInput) incomplete() bool {
	input.mu.Lock()
	defer input.mu.Unlock()
	return input.pending != 0 || input.failed || input.aborted
}
