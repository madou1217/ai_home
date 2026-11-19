package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/host/aihserver"
)

// init applies the process-wide failure policy overrides exposed by
// `aih server serve --cooldown-ms/--failure-threshold`.
//
// The CLI adapter validates the values before spawning this binary; a direct
// launch with malformed environment fails closed here instead of silently
// running with different cooldown semantics.
func init() {
	cooldownMS, ok, err := policyEnvInt64("AIH_SERVER_COOLDOWN_MS")
	if err != nil {
		panic(err)
	}
	threshold, okThreshold, err := policyEnvInt64("AIH_SERVER_FAILURE_THRESHOLD")
	if err != nil {
		panic(err)
	}
	cooldown := time.Duration(0)
	if ok && cooldownMS > 0 {
		cooldown = time.Duration(cooldownMS) * time.Millisecond
	}
	var thresholdValue uint8
	if okThreshold && threshold > 0 {
		thresholdValue = uint8(threshold)
	}
	if err := runtimecore.ConfigurePolicyDefaults(cooldown, thresholdValue); err != nil {
		panic(fmt.Sprintf("失败策略环境变量无效: %v", err))
	}

	if attempts, ok, err := policyEnvInt64("AIH_SERVER_MAX_ATTEMPTS"); err != nil {
		panic(err)
	} else if ok {
		if err := inferencegateway.ConfigureUpstreamAttemptLimit(int(attempts)); err != nil {
			panic(fmt.Sprintf("AIH_SERVER_MAX_ATTEMPTS 无效: %v", err))
		}
	}

	if timeoutMS, ok, err := policyEnvInt64("AIH_SERVER_UPSTREAM_TIMEOUT_MS"); err != nil {
		panic(err)
	} else if ok && timeoutMS > 0 {
		if err := aihserver.ConfigureUpstreamTimeout(time.Duration(timeoutMS) * time.Millisecond); err != nil {
			panic(fmt.Sprintf("AIH_SERVER_UPSTREAM_TIMEOUT_MS 无效: %v", err))
		}
	}
}

func policyEnvInt64(name string) (int64, bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, false, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false, fmt.Errorf("%s 不是整数: %q", name, raw)
	}
	return value, true, nil
}
