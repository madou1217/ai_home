package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
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
func syncCodexEnvironments(ctx context.Context, aiHomeDir, codexHome string, stderr io.Writer) {
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
		// 宿主由常驻的 aih-server 维持；CLI 只写端口确实在监听的 url 条目。
		DetectURLHosts: true,
	})
	if err != nil {
		return
	}
	// 有连接被跳过时必须落一条可诊断的记录；不能只看 Written——
	// 全部连接都被拒绝时文件没有变化，Written 为 false。
	if len(report.Rejected) > 0 {
		recordCodexEnvironmentSync(stderr, report)
	}
}

// codexEnvironmentSyncBudget 是一次同步的总预算。
//
// 缓存命中时远用不到；缓存过期时需要真连 SSH，这里给足时间让探测完成并落盘，
// 但仍是有限值——宁可这次不写，也不让 CLI 永远卡住。
const codexEnvironmentSyncBudget = 45 * time.Second

// recordCodexEnvironmentSync 把被跳过的连接原因写到 stderr。
//
// 只写 stderr、不碰 stdout：codex 的 stdout 会被上层解析。code 是稳定常量，
// message 是已经脱敏的一行原因，两者都原样输出，方便用户直接搜索/报障。
func recordCodexEnvironmentSync(output io.Writer, report codexenvironments.SyncReport) {
	if output == nil {
		return
	}
	for _, rejection := range report.Rejected {
		label := strings.TrimSpace(rejection.Label)
		if label == "" {
			label = rejection.ConnectionID
		}
		_, _ = fmt.Fprintf(
			output,
			"[aih] codex 环境跳过 %s (%s): %s - %s\n",
			label,
			rejection.ConnectionID,
			rejection.Code,
			rejection.Message,
		)
	}
}

func hostHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}
