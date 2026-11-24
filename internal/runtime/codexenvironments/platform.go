package codexenvironments

// 远端探测脚本：必须与 Codex 的真实调用方式一致。
//
// Codex 是直接 spawn `ssh <target> codex exec-server ...`（非登录 shell），所以这里
// 也走非登录 shell。用 `sh -lc` 探测会得出假结论——本机登录 shell 的 PATH 里有
// ~/.local/bin/codex，而 Codex 拿不到。
//
// 平台在拨号前不可知（ssh_connections 上没有 dialect 字段），所以按顺序尝试：
// POSIX 的 `command -v` 失败后回退 Windows 的 `where`。两条都失败才判定不可用，
// 避免把 Windows 主机误判成"没装 codex"。
const (
	posixProbeScript   = `command -v codex 2>/dev/null`
	windowsProbeScript = `where codex 2>nul`
)

// probeScripts 是探测顺序；前一条不可用时才试下一条。
func probeScripts() []string {
	return []string{posixProbeScript, windowsProbeScript}
}
