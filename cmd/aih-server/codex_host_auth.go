package main

import (
	"fmt"
	"os"

	"github.com/madou1217/ai_home/internal/runtime/codexhostauth"
)

// healHostCodexAuthCommand 在服务器启动时尽力修复宿主受管 Codex 认证命令。
//
// 受管块的 command 是绝对路径：升级到版本化目录或仓库搬家后旧 CLI 会被删除，
// 裸 codex 只会报内部模糊错误。服务器是常驻启动路径，因此在装配网关前统一自愈
// 一次；失败只输出可操作诊断，不阻断网关启动（服务器不依赖宿主 CLI 配置）。
func healHostCodexAuthCommand(runtime commandRuntime) {
	home, err := runtime.userHomeDir()
	if err != nil || home == "" {
		return
	}
	// 服务器二进制本身不承接 `codex gateway-auth`，发布布局中同目录的 aih-go 才是
	// 可被 Codex 调用的 CLI。找不到时传空路径：配置健康则保持静默，失效才报错。
	executable := ""
	if binary, err := os.Executable(); err == nil {
		if cli, cliErr := codexhostauth.SiblingCLI(binary); cliErr == nil {
			executable = cli
		}
	}
	result, err := codexhostauth.Ensure(codexhostauth.ConfigPath(home, nil), executable)
	if err != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih-server] 受管 Codex 配置自愈失败: %v\n", err)
		return
	}
	if result.Changed {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih-server] 受管 Codex 认证命令已失效（%s），已更新为 %s。\n", result.PreviousCommand, result.Command)
	}
}
