package codexenvironments

import (
	"crypto/sha256"
	"encoding/binary"
	"sort"
	"strings"
)

// Mode 决定一条连接用哪种方式呈现给 Codex。
type Mode string

const (
	// ModeProgram 让 Codex 自己 spawn ssh —— 不需要 AIH 常驻。
	ModeProgram Mode = "program"
	// ModeURL 由 AIH 维持通道宿主 —— 需要常驻，但能承接 program 表达不了的连接。
	ModeURL Mode = "url"
)

// Reason 说明为什么必须走 url 模式（为空表示可以用 program）。
type Reason string

const (
	ReasonNone            Reason = ""
	ReasonPasswordAuth    Reason = "password_auth"
	ReasonJumpNeedsKey    Reason = "jump_needs_identity"
	ReasonJumpNeedsPasswd Reason = "jump_needs_password"
)

// SelectMode 判断一条连接该用哪种模式。
//
// program 模式把跳板压成 ProxyJump，而 ProxyJump 只能接受 [user@]host[:port]，
// 无法逐跳指定 -i 或密码（实测：跳板需要专用私钥时得到 Permission denied）。
// 这些连接只能交给 AIH 自己拨号，也就是 url 模式。
func SelectMode(connection Connection) (Mode, Reason) {
	if normalizeAuth(connection.AuthType) == AuthPassword {
		return ModeURL, ReasonPasswordAuth
	}
	for _, hop := range linearJumpChain(connection) {
		if strings.TrimSpace(hop.IdentityFile) != "" {
			return ModeURL, ReasonJumpNeedsKey
		}
		if normalizeAuth(hop.AuthType) == AuthPassword {
			return ModeURL, ReasonJumpNeedsPasswd
		}
	}
	return ModeProgram, ReasonNone
}

// SplitByMode 按模式把连接分成两组；url 组附带必须走 url 的原因。
func SplitByMode(connections []Connection) (program []Connection, url []Connection, reasons map[string]Reason) {
	reasons = make(map[string]Reason)
	for _, connection := range connections {
		mode, reason := SelectMode(connection)
		if mode == ModeURL {
			url = append(url, connection)
			reasons[connection.ID] = reason
			continue
		}
		program = append(program, connection)
	}
	return program, url, reasons
}

// stableHostPort 为一条连接分配固定的本机监听端口。
//
// 端口必须稳定：地址要写进 environments.toml，每次重启换端口就得重写文件、
// 并让 Codex 的旧连接失效。这里在 [20000,40000) 内做确定性映射，
// 冲突由调用方（分配时检测）解决。
func stableHostPort(connectionID string) int {
	sum := sha256.Sum256([]byte("aih-codex-env:" + strings.TrimSpace(connectionID)))
	offset := binary.BigEndian.Uint32(sum[:4])
	return 20000 + int(offset%20000)
}

// AllocateHostPorts 为每条连接分配互不相同的固定端口。
//
// 冲突时在原值上线性探测，结果是确定的（同一组输入每次得到同一组端口），
// 因此重复同步不会让地址漂移。
func AllocateHostPorts(connectionIDs []string) map[string]int {
	sorted := append([]string{}, connectionIDs...)
	sort.Strings(sorted)
	used := make(map[int]string, len(sorted))
	out := make(map[string]int, len(sorted))
	for _, id := range sorted {
		port := stableHostPort(id)
		for {
			owner, taken := used[port]
			if !taken || owner == id {
				break
			}
			port++
			if port >= 40000 {
				port = 20000
			}
		}
		used[port] = id
		out[id] = port
	}
	return out
}
