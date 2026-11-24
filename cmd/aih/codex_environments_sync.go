package main

import (
	"context"
	"os"

	"github.com/madou1217/ai_home/internal/runtime/codexenvironments"
)

// syncCodexEnvironments 把 AIH 的 SSH 连接同步成 Codex 的远端执行环境。
//
// environments.toml 是 Codex 的未文档化接口，字段可能随版本变化。因此这里的
// 定位是「尽力而为但绝不阻断」：任何失败都只记录，绝不让 codex CLI 起不来。
// 探测本身有超时，最坏情况也只是启动慢几秒。
func syncCodexEnvironments(ctx context.Context, aiHomeDir, codexHome string) {
	if aiHomeDir == "" || codexHome == "" {
		return
	}
	report, err := codexenvironments.SyncProbed(ctx, codexenvironments.ProbeOptions{
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
