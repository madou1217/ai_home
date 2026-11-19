package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/claudepreflight"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

const (
	claudePreflightProbeTimeout  = 4 * time.Second
	claudePreflightOnFreshness   = 6 * time.Hour
	claudePreflightAutoFreshness = 24 * time.Hour
)

// resolveClaudePreflight 读取 WebUI 保存的首屏检查策略，并给出本次启动的决策。
//
// auto 且从未探测过时按默认关闭启动，探测在后台完成后落盘，不拖慢首屏；开启时
// 结果过期会同步复检一次，确保"开启后环境不满足"的后果能当场提示。
func resolveClaudePreflight(ctx context.Context, runtime commandRuntime, aiHomeDir string) providercli.ClaudePreflight {
	if strings.TrimSpace(aiHomeDir) == "" {
		return providercli.ClaudePreflight{Suppress: true}
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return providercli.ClaudePreflight{Suppress: true}
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, claudepreflight.Key)
	if err != nil {
		return providercli.ClaudePreflight{Suppress: true}
	}
	record := claudepreflight.Normalize(raw, found)
	switch record.Mode {
	case claudepreflight.ModeOn:
		if !claudePreflightFresh(record, claudePreflightOnFreshness) {
			record = probeClaudePreflight(ctx, databasePath, record, claudePreflightProbeTimeout)
		}
		warning := ""
		if record.Reachable != nil && !*record.Reachable {
			warning = fmt.Sprintf(
				"首屏检查已开启，但当前环境无法访问 Anthropic（%s）；全新 Claude 配置首次启动会停在 403",
				record.Detail,
			)
		}
		return providercli.ClaudePreflight{Suppress: false, Warning: warning}
	case claudepreflight.ModeAuto:
		if !claudePreflightFresh(record, claudePreflightAutoFreshness) {
			go func() {
				probeCtx, cancel := context.WithTimeout(context.Background(), claudePreflightProbeTimeout+2*time.Second)
				defer cancel()
				probeClaudePreflight(probeCtx, databasePath, record, claudePreflightProbeTimeout)
			}()
		}
		return providercli.ClaudePreflight{Suppress: !record.Effective()}
	default:
		return providercli.ClaudePreflight{Suppress: true}
	}
}

// probeClaudePreflight 执行一次探测并落盘；失败时保留原记录。
func probeClaudePreflight(
	ctx context.Context,
	databasePath string,
	record claudepreflight.Record,
	timeout time.Duration,
) claudepreflight.Record {
	result := claudepreflight.Probe(ctx, claudepreflight.NewClient(timeout), timeout)
	reachable := result.Reachable
	record.Reachable = &reachable
	record.CheckedAt = time.Now().UnixMilli()
	record.Detail = result.Detail
	_ = appstate.WriteKV(context.WithoutCancel(ctx), databasePath, claudepreflight.Key, record.Encode(), time.Now().UnixMilli())
	return record
}

// claudePreflightFresh 判断最近一次探测是否仍在新鲜期内。
func claudePreflightFresh(record claudepreflight.Record, window time.Duration) bool {
	if record.Reachable == nil || record.CheckedAt <= 0 {
		return false
	}
	return time.Since(time.UnixMilli(record.CheckedAt)) < window
}
