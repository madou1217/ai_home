package pluginhost

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// nodeVersionProbeTimeout 限制探测 node 版本的最长时间，探测失败不阻断任何宿主操作。
const nodeVersionProbeTimeout = 3 * time.Second

// ResolveNodeVersion 返回本机 JS 运行时版本（去掉 "v" 前缀）。
//
// 宿主事实只有一个来源：宿主显式注入的 AIH_NODE_VERSION 优先（部署侧已知版本时
// 不必为探测再起进程），其次执行 `node --version`。两者都拿不到时返回空串，
// 由调用方按「未知版本」处理——manifest 的 engines.node 约束不能被无根据地放行。
func ResolveNodeVersion(lookupEnv func(string) (string, bool)) string {
	if lookupEnv != nil {
		if value, ok := lookupEnv("AIH_NODE_VERSION"); ok {
			if trimmed := strings.TrimPrefix(strings.TrimSpace(value), "v"); trimmed != "" {
				return trimmed
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), nodeVersionProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "node", "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(string(output)), "v")
}
