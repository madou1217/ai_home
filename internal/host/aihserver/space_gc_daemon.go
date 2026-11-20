package aihserver

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/spacegc"
)

const (
	// spaceGCInterval 是空间治理周期；规则按"空闲时长"判定，跑太勤没有收益。
	spaceGCInterval = 6 * time.Hour
	// spaceGCStartupDelay 让服务先完成启动，避免与冷启动抢 IO。
	spaceGCStartupDelay = 5 * time.Minute
)

// spaceGCDaemon 周期性回收可再生的临时目录、整树源码副本、旧 DB 快照与过期证据。
// 规则与保护名单在 internal/runtime/spacegc；这里只负责调度与落报告。
type spaceGCDaemon struct {
	aiHomeDir string
}

func (daemon spaceGCDaemon) Start(ctx context.Context) {
	if daemon.aiHomeDir == "" {
		return
	}
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(spaceGCStartupDelay):
		}
		daemon.runOnce()
		ticker := time.NewTicker(spaceGCInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				daemon.runOnce()
			}
		}
	}()
}

func (daemon spaceGCDaemon) runOnce() {
	report, err := spacegc.Run(daemon.aiHomeDir, spacegc.DefaultOptions())
	if err != nil {
		log.Printf("[space-gc] 巡检失败: %v", err)
		return
	}
	writeSpaceGCReport(daemon.aiHomeDir, report)
	removed := 0
	for _, entry := range report.Entries {
		if entry.Action == "removed" {
			removed++
		}
	}
	if removed == 0 && len(report.Errors) == 0 {
		return
	}
	log.Printf("[space-gc] 回收 %d 项，释放 %.1f MiB（错误 %d）",
		removed, float64(report.FreedBytes)/(1024*1024), len(report.Errors))
}

// writeSpaceGCReport 把最近一轮结果写到 diagnostics/space-gc/last.json（原子替换）。
func writeSpaceGCReport(aiHomeDir string, report spacegc.Report) {
	dir := filepath.Join(aiHomeDir, "diagnostics", "space-gc")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return
	}
	target := filepath.Join(dir, "last.json")
	temp := target + ".tmp"
	if err := os.WriteFile(temp, append(encoded, '\n'), 0o600); err != nil {
		return
	}
	_ = os.Rename(temp, target)
}
