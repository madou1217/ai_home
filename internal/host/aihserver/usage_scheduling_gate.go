package aihserver

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// usageThresholdDefaultPct 与 Node DEFAULTS.threshold_pct 一致：剩余 ≤5% 停池。
	usageThresholdDefaultPct = 95
	// usageThresholdCacheTTL 与 Node THRESHOLD_TTL_MS 一致。
	usageThresholdCacheTTL = 5 * time.Second
	// usageThresholdReadTimeout 限制门禁读配置的最长阻塞；失败沿用上一份值。
	usageThresholdReadTimeout = 2 * time.Second
	// usageConfigKey 是 Node 的 config:usage 键（lib/usage/config-store.js）。
	usageConfigKey = "config:usage"
)

// usageSchedulingGate 把额度服务暴露成征召器的请求前门禁。
//
// Node 在选号前用最新快照拦截 blocked_by_quota / blocked_by_policy，Go 之前只有
// 快照耗尽后的运行态投影；这里补上同一道门禁，阈值读 Node 的 config:usage。
type usageSchedulingGate struct {
	service    *usageapp.Service
	thresholds *usageThresholdSource

	mu        sync.Mutex
	decisions map[string]usageCachedDecision
}

// usageCachedDecision 缓存一次判定；TTL 与 Node SNAPSHOT_READER_TTL_MS 一致，
// 避免每个请求对每个候选都查一次 SQLite。
type usageCachedDecision struct {
	decision accountrouting.UsageDecision
	at       time.Time
}

var _ accountrouting.UsageGate = (*usageSchedulingGate)(nil)

func newUsageSchedulingGate(
	service *usageapp.Service,
	aiHomeDir string,
	now func() time.Time,
) *usageSchedulingGate {
	return &usageSchedulingGate{
		service:    service,
		thresholds: newUsageThresholdSource(aiHomeDir, now),
		decisions:  make(map[string]usageCachedDecision),
	}
}

// EvaluateScheduling 返回账号对真实模型的额度判定；错误按 fail-closed 上抛。
func (gate *usageSchedulingGate) EvaluateScheduling(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
) (accountrouting.UsageDecision, error) {
	if gate == nil || gate.service == nil {
		return accountrouting.UsageDecision{}, nil
	}
	cacheKey := accountRef.String() + "\x00" + providerID + "\x00" + modelID.String()
	now := gate.thresholds.now()
	gate.mu.Lock()
	cached, found := gate.decisions[cacheKey]
	gate.mu.Unlock()
	if found && now.Sub(cached.at) < usageThresholdCacheTTL {
		return cached.decision, nil
	}
	decision, err := gate.service.EvaluateScheduling(
		ctx,
		providerID,
		accountRef,
		modelID,
		gate.thresholds.minimumBasisPoints(ctx),
	)
	if err != nil {
		return accountrouting.UsageDecision{}, err
	}
	result := accountrouting.UsageDecision{
		Blocked: decision.Blocked,
		Status:  decision.Status,
		Reason:  decision.Reason,
	}
	gate.mu.Lock()
	gate.decisions[cacheKey] = usageCachedDecision{decision: result, at: now}
	gate.mu.Unlock()
	return result, nil
}

// usageThresholdSource 读 config:usage 的 threshold_pct，并按 Node 的 5s TTL 缓存。
//
// 读失败、键缺失或值非法都沿用上一份成功值（首次为默认 95）：门禁不能因为配置
// 短暂不可读就把所有账号放行。
type usageThresholdSource struct {
	databasePath string
	now          func() time.Time

	mu       sync.Mutex
	cached   uint16
	loadedAt time.Time
	loaded   bool
}

func newUsageThresholdSource(aiHomeDir string, now func() time.Time) *usageThresholdSource {
	if now == nil {
		now = time.Now
	}
	source := &usageThresholdSource{
		now:    now,
		cached: usageapp.MinimumRemainingBasisPoints(usageThresholdDefaultPct),
	}
	if strings.TrimSpace(aiHomeDir) != "" {
		if path, err := appstate.DatabasePath(aiHomeDir); err == nil {
			source.databasePath = path
		}
	}
	return source
}

func (source *usageThresholdSource) minimumBasisPoints(ctx context.Context) uint16 {
	if source == nil {
		return usageapp.MinimumRemainingBasisPoints(usageThresholdDefaultPct)
	}
	now := source.now()
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.loaded && now.Sub(source.loadedAt) < usageThresholdCacheTTL {
		return source.cached
	}
	source.loaded = true
	source.loadedAt = now
	if source.databasePath == "" {
		return source.cached
	}
	readCtx, cancel := context.WithTimeout(ctx, usageThresholdReadTimeout)
	defer cancel()
	raw, found, err := appstate.ReadKV(readCtx, source.databasePath, usageConfigKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return source.cached
	}
	if threshold, ok := parseUsageThresholdPct(raw); ok {
		source.cached = usageapp.MinimumRemainingBasisPoints(threshold)
	}
	return source.cached
}

// parseUsageThresholdPct 从 config:usage 文档里取 threshold_pct，接受数字与数字字符串。
func parseUsageThresholdPct(raw string) (float64, bool) {
	var document struct {
		Threshold any `json:"threshold_pct"`
	}
	if json.Unmarshal([]byte(raw), &document) != nil || document.Threshold == nil {
		return 0, false
	}
	switch value := document.Threshold.(type) {
	case float64:
		return value, true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}
