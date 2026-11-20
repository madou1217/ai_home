package codex

import (
	"encoding/json"
	"strings"
	"time"
)

// subscriptionClaimTimeMS 只解析可选的展示时间。缺失、null 或坏值保持未知，
// 不能让非鉴权订阅元数据破坏有效登录，也不能把 Token 过期时间当作订阅时间。
func subscriptionClaimTimeMS(raw json.RawMessage) int64 {
	value, err := decodeOptionalStringClaim(raw)
	if err != nil {
		return 0
	}
	at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return 0
	}
	ms := at.UnixMilli()
	if ms <= 0 || ms > maxRFC3339UnixMillis {
		return 0
	}
	return ms
}
