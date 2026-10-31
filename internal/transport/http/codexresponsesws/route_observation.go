package codexresponsesws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// RouteObserver 在每轮选号成功后收到「哪个会话用了哪个账号 / 模型」。
//
// 原生 WS 是 Node 不可见的原始 socket 管道，Node 的路由观测（lib/server/route-observer.js）
// 看不到每轮选号；终端标题的「当前路由」帧因此只能由 Go 写同一份观测文件。
type RouteObserver interface {
	ObserveRoute(sessionKey string, accountRef string, model string)
}

var routeObservationUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// FileRouteObserver 写 `<aiHomeDir>/run/route-observation/<sessionKey>.json`，与 Node 的
// lib/runtime/route-observation.js 同一格式。只写寻址元数据，绝不写凭据。accountRef 是
// Go 侧引用；显示序号由读侧（CLI）按 Node 账号库反查，Go 不重复实现那张表。
type FileRouteObserver struct {
	AIHomeDir string
	Clock     func() time.Time
}

// ObserveRoute 写入失败一律吞掉：观测是诊断面，绝不影响请求。
func (observer FileRouteObserver) ObserveRoute(sessionKey string, accountRef string, model string) {
	dir := strings.TrimSpace(observer.AIHomeDir)
	safe := routeObservationUnsafe.ReplaceAllString(strings.TrimSpace(sessionKey), "-")
	safe = strings.TrimLeft(safe, ".-")
	if len(safe) > 120 {
		safe = safe[:120]
	}
	if dir == "" || safe == "" || strings.TrimSpace(accountRef) == "" {
		return
	}
	clock := observer.Clock
	if clock == nil {
		clock = time.Now
	}
	payload, err := json.Marshal(map[string]any{
		"accountRef": strings.TrimSpace(accountRef),
		"model":      strings.TrimSpace(model),
		"at":         clock().UnixMilli(),
		"source":     "go-core",
	})
	if err != nil {
		return
	}
	target := filepath.Join(dir, "run", "route-observation", safe+".json")
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return
	}
	temp := target + ".tmp"
	if err := os.WriteFile(temp, payload, 0o600); err != nil {
		return
	}
	_ = os.Rename(temp, target)
}
