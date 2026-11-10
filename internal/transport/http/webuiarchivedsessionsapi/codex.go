package webuiarchivedsessionsapi

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/codex/appserver"
)

const (
	// ScopeAll 表示响应同时覆盖历史归档与 Codex 原生归档。
	ScopeAll = "legacy+native"

	providerCodex = "codex"

	// codexTimeout 是单次归档读取（启动 + 握手 + 翻页）的总预算。
	codexTimeout = 15 * time.Second

	codeCodexCommandUnavailable = "codex_command_unavailable"
	codeCodexListFailed         = "codex_archived_list_failed"
)

var (
	// ErrCodexCommandUnavailable 表示没有可用的 app-server 启动命令。
	ErrCodexCommandUnavailable = errors.New("Codex app-server 命令不可用")
	// ErrCodexListFailed 表示原生归档读取失败（启动、握手或 thread/list）。
	ErrCodexListFailed = errors.New("Codex 原生归档读取失败")
)

// CodexCommand 描述一次 app-server 启动。二进制发现属于运行时策略，
// 由注入的 resolver 负责，本包不猜路径。
type CodexCommand struct {
	Command string
	Args    []string
	Dir     string
	// Env 为 nil 时继承当前进程环境。
	Env []string
}

// CodexCommandResolver 解析 Codex app-server 的启动方式；
// 返回错误即表示该运行时当前不可用。
type CodexCommandResolver func(ctx context.Context) (CodexCommand, error)

// listCodexArchived 通过 app-server stdio 读取原生归档线程。
//
// 任何一步失败都返回错误而不是空列表：调用方据此在 errors 里声明
// codex 的失败，避免把「读不到」伪装成「没有归档」。
func (handler *Handler) listCodexArchived(ctx context.Context) ([]Entry, error) {
	if handler.codexCommand == nil {
		return nil, fmt.Errorf("%w: 未注入 resolver", ErrCodexCommandUnavailable)
	}
	command, err := handler.codexCommand(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCodexCommandUnavailable, err)
	}
	if strings.TrimSpace(command.Command) == "" {
		return nil, fmt.Errorf("%w: resolver 返回空可执行文件", ErrCodexCommandUnavailable)
	}

	requestCtx, cancel := context.WithTimeout(ctx, codexTimeout)
	defer cancel()
	client, err := appserver.Dial(requestCtx, appserver.Config{
		Command: command.Command,
		Args:    command.Args,
		Dir:     command.Dir,
		Env:     command.Env,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCodexListFailed, err)
	}
	defer func() { _ = client.Close() }()

	threads, err := client.ListArchivedThreads(requestCtx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCodexListFailed, err)
	}
	entries := make([]Entry, 0, len(threads))
	for _, thread := range threads {
		entries = append(entries, nativeEntry(thread))
	}
	return entries, nil
}

// nativeEntry 把 adapter 的线程投影成归档条目。
// 原生归档没有独立的归档时间戳，ArchivedAt 保持 0，排序回退到 UpdatedAt。
func nativeEntry(thread appserver.ArchivedThread) Entry {
	return Entry{
		ID:           thread.ID,
		Title:        thread.Title,
		Provider:     thread.Provider,
		ProjectPath:  thread.ProjectPath,
		Origin:       thread.Origin,
		CanUnarchive: thread.CanUnarchive,
		UpdatedAt:    thread.UpdatedAt,
	}
}

// providerError 把错误归一到 errors 数组里的 provider 级条目。
func providerError(provider string, err error) archivedError {
	code := codeCodexListFailed
	if errors.Is(err, ErrCodexCommandUnavailable) {
		code = codeCodexCommandUnavailable
	}
	return archivedError{Provider: provider, Error: code, Message: err.Error()}
}
