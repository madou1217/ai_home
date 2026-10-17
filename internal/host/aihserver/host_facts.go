package aihserver

import (
	"os"
	"runtime"
	"strings"
)

// 运行机器的静态事实：只在账号选择 host-derived 设备策略时才用得上。
//
// 单独放一个文件是为了让「Go 侧哪里读了宿主信息」一眼可见 —— 默认策略
// （stable-derived）不读这些值，因此正常情况下宿主信息不会进入上游请求。

// hostNameOrEmpty 取运行机器的主机名（失败返回空）。
func hostNameOrEmpty() string {
	value, err := os.Hostname()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// hostOSVersionOrEmpty 取运行机器的内核版本串。
func hostOSVersionOrEmpty() string {
	return strings.TrimSpace(runtime.GOOS + " " + runtime.GOARCH)
}

// hostDeviceModelOrEmpty 取运行机器的型号串。
//
// Go 侧拿不到「macOS 26.1 arm64」这类产品版本（那要执行系统命令），因此这里只报
// 平台与架构 —— 信息量少于 Node 侧是**有意的**：宁可少报，也不要为了对齐而执行
// 外部命令（那会带来启动延迟与失败面）。
func hostDeviceModelOrEmpty() string {
	return strings.TrimSpace(runtime.GOOS + " " + runtime.GOARCH)
}
