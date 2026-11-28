// Package codexcontext 声明 Codex 响应上下文与账号归属的持久化端口。
//
// 进程内 journal 只能覆盖一次启动周期；服务重启后，客户端仍可能用重启前的
// previous_response_id 续接。持久层记录“响应 ID → 完整上下文 / 交付账号”，
// 让这类续接仍能展开为无状态请求，或优先钉回原账号。
package codexcontext

import (
	"context"
	"encoding/json"
	"time"
)

// Record 是一次已交付响应的持久化快照。
type Record struct {
	// Items 是展开用的完整上下文（请求输入 + 响应输出）。
	Items []json.RawMessage
	// AccountRef 是交付该响应的账号引用；可能为空（仅保存了上下文）。
	AccountRef string
	// Model 是交付该响应的模型；HTTP 续接帧可能省略 model，用它补回。
	Model string
	// UpdatedAt 是最后一次写入时间。
	UpdatedAt time.Time
}

// Store 持久化响应上下文与账号归属。
//
// 写操作在 WebSocket 热路径上调用，必须是非阻塞的（实现内部排队/丢弃），
// 不能因为磁盘慢而卡住推理流；读只在内存未命中时发生。
type Store interface {
	Load(ctx context.Context, responseID string) (Record, bool, error)
	SaveItems(responseID string, items []json.RawMessage, updatedAt time.Time)
	SaveBinding(responseID, accountRef, model string, updatedAt time.Time)
}
