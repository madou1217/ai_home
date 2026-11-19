package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/accounts/gemini"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
	"github.com/madou1217/ai_home/internal/runtime/upstreamdefaults"
	"github.com/madou1217/ai_home/internal/runtime/usagedaemons"
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

	var modelTTL time.Duration
	if ttlMS, ok, err := policyEnvInt64("AIH_SERVER_MODELS_CACHE_TTL_MS"); err != nil {
		panic(err)
	} else if ok && ttlMS > 0 {
		modelTTL = time.Duration(ttlMS) * time.Millisecond
	}
	var probeAccounts int
	if accounts, ok, err := policyEnvInt64("AIH_SERVER_MODELS_PROBE_ACCOUNTS"); err != nil {
		panic(err)
	} else if ok && accounts > 0 {
		probeAccounts = int(accounts)
	}
	if err := managementops.ConfigureModelDefaults(modelTTL, probeAccounts); err != nil {
		panic(fmt.Sprintf("模型缓存/探测环境变量无效: %v", err))
	}

	providerLimits := map[string]int{}
	for envName, provider := range map[string]string{
		"AIH_SERVER_CODEX_MAX_CONCURRENCY":    "codex",
		"AIH_SERVER_GEMINI_MAX_CONCURRENCY":   "gemini",
		"AIH_SERVER_CLAUDE_MAX_CONCURRENCY":   "claude",
		"AIH_SERVER_AGY_MAX_CONCURRENCY":      "agy",
		"AIH_SERVER_OPENCODE_MAX_CONCURRENCY": "opencode",
	} {
		value, ok, err := policyEnvInt64(envName)
		if err != nil {
			panic(err)
		}
		if ok && value > 0 {
			providerLimits[provider] = int(value)
		}
	}
	queueLimit, _, err := policyEnvInt64("AIH_SERVER_QUEUE_LIMIT")
	if err != nil {
		panic(err)
	}
	if err := inferencegateway.ConfigureProviderLimits(providerLimits, int(queueLimit)); err != nil {
		panic(fmt.Sprintf("Provider 并发/队列环境变量无效: %v", err))
	}
	if scope := strings.TrimSpace(os.Getenv("AIH_SERVER_PROVIDER_SCOPE")); scope != "" {
		if err := inferencegateway.ConfigureProviderScope(scope); err != nil {
			panic(fmt.Sprintf("AIH_SERVER_PROVIDER_SCOPE 无效: %v", err))
		}
	}

	affinityTTLMS, _, err := policyEnvInt64("AIH_SERVER_SESSION_AFFINITY_TTL_MS")
	if err != nil {
		panic(err)
	}
	affinityMax, _, err := policyEnvInt64("AIH_SERVER_SESSION_AFFINITY_MAX")
	if err != nil {
		panic(err)
	}
	if err := accountrouting.ConfigureSessionAffinity(time.Duration(affinityTTLMS)*time.Millisecond, int(affinityMax)); err != nil {
		panic(fmt.Sprintf("会话亲和环境变量无效: %v", err))
	}

	scanEnabled, scanEnabledSet, err := policyEnvBool("AIH_SERVER_MODEL_USAGE_SCAN")
	if err != nil {
		panic(err)
	}
	scanStartMS, scanStartSet, err := policyEnvInt64("AIH_SERVER_MODEL_USAGE_SCAN_START_DELAY_MS")
	if err != nil {
		panic(err)
	}
	scanIntervalMS, scanIntervalSet, err := policyEnvInt64("AIH_SERVER_MODEL_USAGE_SCAN_INTERVAL_MS")
	if err != nil {
		panic(err)
	}
	if scanEnabledSet || scanStartSet || scanIntervalSet {
		enabled := true
		if scanEnabledSet {
			enabled = scanEnabled
		}
		startDelay := usagedaemons.DefaultUsageScanStartDelay
		if scanStartSet {
			startDelay = time.Duration(scanStartMS) * time.Millisecond
		}
		interval := usagedaemons.DefaultUsageScanInterval
		if scanIntervalSet {
			interval = time.Duration(scanIntervalMS) * time.Millisecond
		}
		if err := usagedaemons.ConfigureUsageScan(enabled, startDelay, interval); err != nil {
			panic(fmt.Sprintf("用量扫描环境变量无效: %v", err))
		}
	}

	if requestLog, ok, err := policyEnvBool("AIH_SERVER_REQUEST_LOG"); err != nil {
		panic(err)
	} else if ok {
		aihserver.ConfigureRequestLogging(requestLog)
	}

	defaults := upstreamDefaultsFromEnvAndConfig()
	if err := codex.ConfigureDefaultAPIBaseURL(defaults.CodexBaseURL); err != nil {
		panic(fmt.Sprintf("Codex 上游默认地址无效: %v", err))
	}
	// OAuth 与 API Key 的官方默认不同（chatgpt.com/backend-api/codex 对
	// api.openai.com/v1），因此同一个 --codex-base-url 分别作为两条路径的兜底。
	if err := codex.ConfigureDefaultOAuthBaseURL(defaults.CodexBaseURL); err != nil {
		panic(fmt.Sprintf("Codex OAuth 上游默认地址无效: %v", err))
	}
	if err := claude.ConfigureDefaultAPIBaseURL(defaults.ClaudeBaseURL); err != nil {
		panic(fmt.Sprintf("Claude 上游默认地址无效: %v", err))
	}
	if err := agy.ConfigureDefaultBaseURL(defaults.AgyBaseURL); err != nil {
		panic(fmt.Sprintf("AGY 上游默认地址无效: %v", err))
	}
	if err := gemini.ConfigureDefaultBaseURL(defaults.GeminiBaseURL); err != nil {
		panic(fmt.Sprintf("Gemini 上游默认地址无效: %v", err))
	}
	if err := upstreamdefaults.Configure(defaults); err != nil {
		panic(fmt.Sprintf("上游默认地址无效: %v", err))
	}
}

func upstreamDefaultsFromEnvAndConfig() upstreamdefaults.Defaults {
	home := strings.TrimSpace(os.Getenv("AIH_HOME_DIR"))
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return upstreamdefaults.Defaults{}
		}
		home = userHome + string(os.PathSeparator) + ".ai_home"
	}
	stored := struct {
		CodexBaseURL  string `json:"codexBaseUrl"`
		ClaudeBaseURL string `json:"claudeBaseUrl"`
		AgyBaseURL    string `json:"agyBaseUrl"`
		GeminiBaseURL string `json:"geminiBaseUrl"`
	}{}
	if databasePath, err := appstate.DatabasePath(home); err == nil {
		if raw, found, readErr := appstate.ReadKV(context.Background(), databasePath, "config:server"); readErr == nil && found {
			_ = json.Unmarshal([]byte(raw), &stored)
		}
	}
	return upstreamdefaults.Defaults{
		CodexBaseURL:  firstNonEmptyEnv("AIH_SERVER_CODEX_BASE_URL", stored.CodexBaseURL),
		ClaudeBaseURL: firstNonEmptyEnv("AIH_SERVER_CLAUDE_BASE_URL", stored.ClaudeBaseURL),
		AgyBaseURL:    firstNonEmptyEnv("AIH_SERVER_AGY_BASE_URL", stored.AgyBaseURL),
		GeminiBaseURL: firstNonEmptyEnv("AIH_SERVER_GEMINI_BASE_URL", stored.GeminiBaseURL),
	}
}

func firstNonEmptyEnv(envName, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
		return value
	}
	return strings.TrimSpace(fallback)
}

func policyEnvBool(name string) (bool, bool, error) {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	if raw == "" {
		return false, false, nil
	}
	switch raw {
	case "1", "true", "yes", "on":
		return true, true, nil
	case "0", "false", "no", "off":
		return false, true, nil
	default:
		return false, false, fmt.Errorf("%s 不是布尔值: %q", name, raw)
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
