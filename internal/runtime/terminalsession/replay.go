package terminalsession

import "regexp"

// replayQueryPatterns 与 Node lib/server/terminal-replay.js 保持一致。
// tmux 外层客户端缓存的能力查询在重连时已经过期，回放出去会被 shell 当成输入；
// 直连 PTY 仍在等待首个浏览器回应，因此只在 durable 会话上剥离。
var replayQueryPatterns = []*regexp.Regexp{
	regexp.MustCompile("\x1b\\[[?>]?[0-9;]*c"),
	regexp.MustCompile("\x1b\\[\\??(?:5|6|15|25|26|53|55|56|62|63|75|85|996)n"),
	regexp.MustCompile("\x1b\\[(?:14|16|18|19|20|21)t"),
	regexp.MustCompile("\x1b\\[>q"),
	regexp.MustCompile("\x1b\\](?:10|11|12);\\?(?:\x07|\x1b\\\\)"),
}

// ReplayOutput 返回可安全回放的输出快照。
// durable 为 true 时剥离终端能力查询；否则原样返回（仍复制一份，避免调用方改到缓冲）。
func ReplayOutput(durable bool, output []byte) []byte {
	copied := append([]byte(nil), output...)
	if !durable || len(copied) == 0 {
		return copied
	}
	for _, pattern := range replayQueryPatterns {
		copied = pattern.ReplaceAll(copied, nil)
	}
	return copied
}
