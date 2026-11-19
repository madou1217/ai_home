package usagedaemons

import (
	"errors"
	"sync"
	"time"
)

type usageScanConfig struct {
	enabled    bool
	startDelay time.Duration
	interval   time.Duration
}

var (
	usageScanConfigMu    sync.RWMutex
	usageScanConfigSet   bool
	usageScanConfigValue usageScanConfig
)

// ConfigureUsageScan sets the process defaults used when a scheduler is built
// without explicit options. It is called once before the server starts.
func ConfigureUsageScan(enabled bool, startDelay, interval time.Duration) error {
	if startDelay < 0 || startDelay > 24*time.Hour {
		return errors.New("用量扫描启动延迟必须在 0 到 24h 之间")
	}
	if interval < MinUsageScanInterval || interval > 24*time.Hour {
		return errors.New("用量扫描周期必须在 1m 到 24h 之间")
	}
	usageScanConfigMu.Lock()
	usageScanConfigSet = true
	usageScanConfigValue = usageScanConfig{
		enabled:    enabled,
		startDelay: startDelay,
		interval:   interval,
	}
	usageScanConfigMu.Unlock()
	return nil
}

func currentUsageScanConfig() (usageScanConfig, bool) {
	usageScanConfigMu.RLock()
	defer usageScanConfigMu.RUnlock()
	return usageScanConfigValue, usageScanConfigSet
}
