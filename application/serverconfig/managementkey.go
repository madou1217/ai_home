package serverconfig

// Management Key 的长度约束，与 Node 的 MIN/MAX_MANAGEMENT_KEY_LENGTH 一致。
//
// 这个值同时约束服务端轮换入口、Go 客户端连接校验与运行时出站使用；
// 三处此前各写一份 32/8192，规则一旦调整必然漏改一处。
const (
	// ManagementKeyMinLength 是 Management Key 的最小字符数。
	ManagementKeyMinLength = 32
	// ManagementKeyMaxLength 是 Management Key 的最大字符数。
	ManagementKeyMaxLength = 8192
)

// HasValidManagementKeyLength 报告值是否落在 Management Key 的允许长度内。
//
// 字符集规则按用途补充：设置入口禁止换行与 NUL，出站使用还要求无空白与控制字符。
func HasValidManagementKeyLength(value string) bool {
	return len(value) >= ManagementKeyMinLength && len(value) <= ManagementKeyMaxLength
}
