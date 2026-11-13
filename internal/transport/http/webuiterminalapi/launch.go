package webuiterminalapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
)

// LaunchRequest 是进程内 Go 路由（如 SSH 工作区终端）复用 PTY 会话管理器的入参。
type LaunchRequest struct {
	SessionKey string
	Cwd        string
	File       string
	Args       []string
	Env        []string
	Cols       int
	Rows       int
	MuxID      string
	Persistent bool
	Remote     *terminalsession.RemoteSpec
}

// LaunchResult 是 LaunchSession 的成功输出。
type LaunchResult struct {
	TermID     string
	SessionKey string
	MuxID      string
	Durable    bool
	Reused     bool
}

// LaunchError 是 LaunchSession 的结构化错误。
type LaunchError struct {
	Status  int
	Code    string
	Message string
}

// LaunchSession 打开或复用持久化本地 PTY 或远端 SSH PTY，与 POST /launch 语义完全一致。
func (handler *Handler) LaunchSession(ctx context.Context, req LaunchRequest) (LaunchResult, *LaunchError) {
	if handler == nil || handler.sessions == nil {
		return LaunchResult{}, &LaunchError{
			Status:  http.StatusServiceUnavailable,
			Code:    "terminal_launcher_unavailable",
			Message: "终端管理器不可用。",
		}
	}
	file := strings.TrimSpace(req.File)
	if file == "" && req.Remote == nil {
		return LaunchResult{}, &LaunchError{
			Status:  http.StatusInternalServerError,
			Code:    errPTYSpawnFailed.code,
			Message: errPTYSpawnFailed.message,
		}
	}
	result, failure := handler.openSession(ctx, openInput{
		sessionKey: req.SessionKey,
		muxID:      req.MuxID,
		cwd:        req.Cwd,
		cols:       req.Cols,
		rows:       req.Rows,
		shell:      Shell{File: file, Args: append([]string(nil), req.Args...)},
		env:        append([]string(nil), req.Env...),
		persistent: req.Persistent,
		remote:     req.Remote,
	})
	if failure != nil {
		return LaunchResult{}, &LaunchError{
			Status:  statusForOpen(failure),
			Code:    failure.code,
			Message: failure.message,
		}
	}
	return LaunchResult{
		TermID:     result.snapshot.ID,
		SessionKey: result.snapshot.Key,
		MuxID:      result.muxID,
		Durable:    result.durable,
		Reused:     result.reused,
	}, nil
}
