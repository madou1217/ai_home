package peer

import "errors"

const (
	// MessagePrefix 与 Node peer/store.js 生成的消息 ID 前缀保持一致。
	MessagePrefix = "pm-"
)

// ErrStoreUnavailable 表示未配置 AIHomeDir，无法定位 peer 队列目录。
var ErrStoreUnavailable = errors.New("peer_store_unavailable")

// ShortMessageID 返回消息 ID 的紧凑前缀（与 Node shortMessageId 对齐）。
func ShortMessageID(id string) string {
	maxLen := len(MessagePrefix) + 8
	if len(id) <= maxLen {
		return id
	}
	return id[:maxLen]
}
