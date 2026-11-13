// Package sessionread 提供全 Provider 只读会话读取核心能力（项目列表、消息历史、增量光标、模型与预览）。
//
// 契约对齐 Node lib/sessions/session-reader*.js 与 lib/server/webui-session-routes.js，
// 供 webuisessionslistapi、webuisessionmessagesapi、webuisessionpreviewsapi、
// webuisessioneventsapi 与 webuisessionmodelapi 共用，消除多端实现漂移。
package sessionread

import (
	"encoding/json"
	"errors"
)

var (
	// ErrUnsupportedProvider 表示调用方传入的 Provider 不在已知会话载体清单内。
	ErrUnsupportedProvider = errors.New("不支持的会话 Provider")
	// ErrSessionNotFound 表示未能定位到目标会话。
	ErrSessionNotFound = errors.New("会话不存在")
	// ErrInvalidSessionRef 表示 sessionId 或 projectDirName 存在非法路径字符。
	ErrInvalidSessionRef = errors.New("会话引用不合法")
	// ErrReadFailed 表示会话文件存在但读取或解析失败。
	ErrReadFailed = errors.New("会话读取失败")
)

// Options 汇总读取会话与资源路径规范化所需的宿主及 AIH 目录上下文。
type Options struct {
	HostHomeDir    string
	AIHomeDir      string
	AccountRef     string
	AppStateDBPath string
}

// Project 是对齐 Node { id, name, path, sessions, provider } 的项目视图。
type Project struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Sessions []Session `json:"sessions"`
	Provider string    `json:"provider"`
}

// Session 是对齐 Node { id, title, updatedAt, provider, projectDirName } 的会话条目。
type Session struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	UpdatedAt      int64  `json:"updatedAt"`
	Provider       string `json:"provider"`
	ProjectDirName string `json:"projectDirName"`
}

// ImageAttachment 表示消息中内联或引用的图片附件。
type ImageAttachment struct {
	DataURL   string `json:"dataUrl,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
}

// Message 表示一条规范化前的原始会话消息。
type Message struct {
	Role      string            `json:"role"`
	Content   string            `json:"content"`
	Thinking  string            `json:"thinking,omitempty"`
	Model     string            `json:"model,omitempty"`
	Timestamp any               `json:"timestamp,omitempty"`
	Images    []ImageAttachment `json:"images,omitempty"`
	Subagents []any             `json:"subagents,omitempty"`
}

// Snapshot 表示带文件字节光标的完整消息快照。
type Snapshot struct {
	Messages []json.RawMessage
	Cursor   int64
}

// Preview 表示单个会话的惰性模型与尾部摘要结果。
type Preview struct {
	Model   string
	Preview string
}

// NonCodexEventsResult 表示非 Codex Provider 的轮询光标事件结果（返回空事件数组与快照重拉标记）。
type NonCodexEventsResult struct {
	Events               []any `json:"events"`
	Cursor               int64 `json:"cursor"`
	RequiresSnapshot     bool  `json:"requiresSnapshot"`
	HasAssistantToolCall bool  `json:"hasAssistantToolCall"`
}

// ModelTimelineEntry 表示 app-state.db model_usage_records 里记录的原生回合模型点位。
type ModelTimelineEntry struct {
	Model       string
	TimestampMs int64
}
