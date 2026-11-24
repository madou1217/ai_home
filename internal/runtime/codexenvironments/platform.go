package codexenvironments

// 远端探测分两步，缺一不可：
//
//  1. 找出候选可执行文件（POSIX 用 `command -v`，Windows 用 `where`）；
//  2. 对每个候选**实际执行一次 `--version`**。
//
// 第 2 步是必须的：本机实测过一台 Windows，`where codex` 命中的第一个 exe 是
// 不兼容的旧构建（"not compatible with the version of Windows"），而下一个候选
// （pnpm shim）工作正常。只看路径存在会把这条连接写成"可用"，然后在 Codex 里
// 长期报 "exec-server transport closed"。
//
// 平台在建连前不可知（ssh_connections 上没有 dialect 字段），所以按顺序尝试两种写法。
const (
	posixProbeScript   = `command -v codex 2>/dev/null`
	windowsProbeScript = `where codex 2>nul`
)

// probeScripts 返回候选查找脚本；前一条没有结果时才试下一条。
func probeScripts() []string {
	return []string{posixProbeScript, windowsProbeScript}
}

// maxProbeCandidates 限制逐候选验证的次数，避免 PATH 里堆积大量同名命令时拖慢启动。
const maxProbeCandidates = 4

// probeCandidates 是候选查找结果的最大保留数（where 可能返回多个）。
const probeCandidatesOutputLimit = 4 * 1024
