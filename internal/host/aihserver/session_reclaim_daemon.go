package aihserver

import (
	"context"
	"log"
	"time"

	"github.com/madou1217/ai_home/internal/host/codexlocalappserver"
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
	// 先清空壳：tmux 服务还在、会话已不存在的注册表条目（supervisor 异常退出留下）。
	// 整个 tmux 服务都没了属于重启场景，注册表要留给 restore，不动。
	if pruned, pruneErr := sessionreclaim.PruneStale(ctx, daemon.aiHomeDir, 10*time.Minute); pruneErr != nil {
		log.Printf("[session-reclaim] 清理空壳注册表失败: %v", pruneErr)
	} else if pruned > 0 {
		log.Printf("[session-reclaim] 清理空壳注册表 %d 条", pruned)
	}
	// 共享 codex 后端在没有租约后不会自己退出：没有新会话就不会触发下一次回收，
	// 这里随巡检一起清理，避免几百 MB 的空后端长期驻留。
	if reaped := codexlocalappserver.ReapIdleBackends(daemon.aiHomeDir); reaped > 0 {
		log.Printf("[housekeeping] 回收空闲 codex 共享后端 %d 个", reaped)
	}
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
