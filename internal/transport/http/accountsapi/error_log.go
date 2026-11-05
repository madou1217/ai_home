package accountsapi

import (
	"log"
	"strings"
	"unicode/utf8"
)

// maxLoggedErrorRunes 限制单条错误日志的长度：上游错误可能带着整段响应体
// （例如 Provider 的错误 JSON），原样落盘既难读也有泄密风险。
const maxLoggedErrorRunes = 600

// logServerError 把未映射的应用错误写到进程日志（stderr → logs/go-core.log）。
//
// 为什么要单独记：writeApplicationError 的兜底只回 `internal_error` 与一句通用文案，
// 真实原因（哪一步、哪个 Provider、codec 报了什么）在客户端看不到。2026-11-06 排查
// cline 账号导入 500 时，Go 日志里只有"账号服务内部错误"，只能靠逐段二分定位。
// 客户端仍只拿到稳定错误码；这里只写服务端日志。
func logServerError(operation string, err error) {
	if err == nil {
		return
	}
	text := strings.TrimSpace(err.Error())
	if text == "" {
		text = "(empty error)"
	}
	if utf8.RuneCountInString(text) > maxLoggedErrorRunes {
		runes := []rune(text)
		text = string(runes[:maxLoggedErrorRunes]) + "…"
	}
	log.Printf("accountsapi: %s: %s", operation, text)
}
