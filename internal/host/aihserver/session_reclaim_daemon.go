package aihserver

import (
	"context"
	"log"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionreclaim"
)

const (
	// sessionReclaimInterval 是巡检周期；判定本身需要采样窗口，太短没有意义。
	sessionReclaimInterval = 10 * time.Minute
	// sessionReclaimStartupDelay 让服务先完成启动与首轮业务，避免和冷启动抢资源。
	sessionReclaimStartupDelay = 45 * time.Second
	// sessionReclaimIdleThreshold 是宽限期：只有这么久没活动的会话才会被考虑。
	sessionReclaimIdleThreshold = 4 * time.Hour
)

// sessionReclaimDaemon 周期性回收"确认没人用"的持久会话。
// 判定与二次确认都在 sessionreclaim 包里：任何一项证据缺失或不确定都保留。
type sessionReclaimDaemon struct {
	aiHomeDir string
}

// Start 启动巡检循环；ctx 取消即结束。
func (daemon sessionReclaimDaemon) Start(ctx context.Context) {
	if daemon.aiHomeDir == "" {
		return
	}
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(sessionReclaimStartupDelay):
		}
		daemon.runOnce(ctx)
		ticker := time.NewTicker(sessionReclaimInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				daemon.runOnce(ctx)
			}
		}
	}()
}

func (daemon sessionReclaimDaemon) runOnce(ctx context.Context) {
	result, err := sessionreclaim.Reclaim(ctx, daemon.aiHomeDir, sessionreclaim.ReclaimOptions{
		Options: sessionreclaim.Options{IdleThreshold: sessionReclaimIdleThreshold},
		Apply:   true,
	})
	if err != nil {
		log.Printf("[session-reclaim] 巡检失败: %v", err)
		return
	}
	if len(result.Reclaimed) == 0 {
		return
	}
	log.Printf("[session-reclaim] 已回收 %d 个空闲会话: %v (跳过 %d)",
		len(result.Reclaimed), result.Reclaimed, len(result.Skipped))
}
