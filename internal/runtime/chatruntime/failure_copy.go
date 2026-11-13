package chatruntime

import (
	"fmt"
	"strings"
)

const genericRuntimeFailureCopy = "会话运行时启动失败，本轮未开始"

// RuntimeFailureCopy maps internal harness startup/transport codes to user-facing copy.
var RuntimeFailureCopy = map[string]string{
	"codex_app_server_rpc_error":     "会话运行时（Codex harness）通信失败，本轮未开始",
	"codex_app_server_closed":        "会话运行时（Codex harness）进程已退出，本轮未开始",
	"codex_app_server_spawn_failed":  "无法启动会话运行时（Codex harness）",
	"codex_app_server_ready_timeout": "会话运行时（Codex harness）启动超时",
	"runtime_prewarm_failed":         genericRuntimeFailureCopy,
}

// DescribeRuntimeFailure 把运行期内部错误码翻译为用户可读文案，并标明会话所属 provider。
func DescribeRuntimeFailure(code, provider string) string {
	normalized := strings.TrimSpace(code)
	prov := strings.TrimSpace(provider)
	base := RuntimeFailureCopy[normalized]
	if base == "" {
		base = genericRuntimeFailureCopy
	}
	if prov != "" {
		return fmt.Sprintf("%s（%s 会话，运行时与账号无关）", base, prov)
	}
	return base
}
