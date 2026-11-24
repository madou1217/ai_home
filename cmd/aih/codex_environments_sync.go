package main

import (
	"context"
	"os"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexenvironments"
)

// syncCodexEnvironments 把 AIH 的 SSH 连接同步成 Codex 的远端执行环境。
//
// 两条硬约束：
//   - 绝不阻断 CLI 启动：environments.toml 是 Codex 的未文档化接口，同步失败
//     不能影响 codex 能不能跑，因此所有错误都被吞掉。
//   - 绝不拖慢启动：探测结论有落盘缓存，命中时只做一次本地写（毫秒级）；
//     只有缓存过期或出现新连接时才真的连 SSH，且那段有硬超时兜底。
//
// 这里保持同步调用而不是后台 goroutine：CLI 进程往往一两秒就退出，后台任务
// 会被一起杀掉，文件永远写不出来（实测过，功能等于失效）。
func syncCodexEnvironments(ctx context.Context, aiHomeDir, codexHome string) {
	if aiHomeDir == "" || codexHome == "" {
		return
	}
	syncCtx, cancel := context.WithTimeout(context.Background(), codexEnvironmentSyncBudget)
	defer cancel()
	_ = ctx
	report, err := codexenvironments.SyncProbed(syncCtx, codexenvironments.ProbeOptions{
		AIHomeDir:    aiHomeDir,
		CodexHome:    codexHome,
		HomeDir:      hostHomeDir(),
		IncludeLocal: true,
	})
	if err != nil {
		return
	}
	if report.Outcome.Written {
		recordCodexEnvironmentSync(report)
	}
}

// codexEnvironmentSyncBudget 是一次同步的总预算。
//
// 缓存命中时远用不到；缓存过期时需要真连 SSH，这里给足时间让探测完成并落盘，
// 但仍是有限值——宁可这次不写，也不让 CLI 永远卡住。
const codexEnvironmentSyncBudget = 45 * time.Second

// recordCodexEnvironmentSync 是唯一的观测出口；默认不输出，避免污染 CLI 的
// stdout/stderr（codex 的管道输出会被上层解析）。
func recordCodexEnvironmentSync(report codexenvironments.SyncReport) {
	codexEnvironmentSyncSink(report)
}

func hostHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// codexEnvironmentSyncSink 可在测试或诊断模式替换。
var codexEnvironmentSyncSink = func(codexenvironments.SyncReport) {}
