package managementops

import (
	"errors"
	"sync/atomic"
	"time"
)

var (
	configuredModelsCacheTTLMS  atomic.Int64
	configuredModelAccountLimit atomic.Int64
)

// ConfigureModelDefaults sets the process-wide /models cache window and probe
// account limit. Zero values keep the domain defaults; the CLI adapter passes
// Node's serve defaults explicitly.
func ConfigureModelDefaults(ttl time.Duration, accountLimit int) error {
	if ttl != 0 && (ttl < time.Second || ttl > 24*time.Hour) {
		return errors.New("模型缓存 TTL 必须在 1s 到 24h 之间")
	}
	if accountLimit < 0 || accountLimit > 8 {
		return errors.New("模型探测账号数必须在 0 到 8 之间")
	}
	configuredModelsCacheTTLMS.Store(ttl.Milliseconds())
	configuredModelAccountLimit.Store(int64(accountLimit))
	return nil
}

// ConfiguredModelsCacheTTL returns the current process default cache window.
func ConfiguredModelsCacheTTL() time.Duration {
	if ms := configuredModelsCacheTTLMS.Load(); ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return DefaultModelsCacheTTL
}

// ConfiguredModelAccountLimit returns the current process default probe limit.
func ConfiguredModelAccountLimit() int {
	if value := int(configuredModelAccountLimit.Load()); value > 0 {
		return value
	}
	return DefaultModelAccountLimit
}
