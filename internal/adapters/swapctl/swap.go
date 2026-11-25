// Package swapctl 管理当前主机的交换空间。
//
// 只有 Linux 支持「按需创建/调整交换文件」；macOS 的交换由系统动态管理，
// Windows 没有同等的交换文件语义，两者一律返回 supported=false，
// WebUI 据此不渲染入口（而不是渲染一个点了会失败的控件）。
package swapctl

// Status 是交换空间的当前状态。
type Status struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	File      string `json:"file,omitempty"`
	Active    bool   `json:"active"`
	TotalMB   int    `json:"totalMb"`
	UsedMB    int    `json:"usedMb"`
	FreeMB    int    `json:"freeMb"`
	Persisted bool   `json:"persisted"`
	// CanChange 表示当前进程能执行变更（Linux + 免密 sudo + 工具齐全）。
	CanChange bool `json:"canChange"`
}

// CommandRunner 执行一条特权命令；实现负责超时与输出收集。
type CommandRunner func(name string, args ...string) (string, error)

// Manager 是交换空间管理器。
type Manager struct {
	Run CommandRunner
}

// New 创建管理器；run 为 nil 时使用真实执行器。
func New(run CommandRunner) *Manager {
	return &Manager{Run: run}
}
