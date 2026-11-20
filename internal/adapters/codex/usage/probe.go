package usage

import (
	"net/url"
	"os"
	"strings"

	"github.com/madou1217/ai_home/core/accounts/codex"
)

// codexUsageProbeEnv 是 Codex 额度探针的运维上下文，与 Node 的
// CODEX_PROBE_ENV（lib/cli/services/usage/codex-probe-context.js）同名同格式：
// 逗号分隔的 key=value，值做 URL 解码。
const codexUsageProbeEnv = "AIH_CODEX_USAGE_PROBE"

const (
	// defaultUsagePath 是官方 rate-limit 端点路径。
	defaultUsagePath = "/wham/usage"
	// chatGPTBackendBaseURL 是 /wham/* 系列路径挂载的根（与 Codex OAuth 基址同源）。
	chatGPTBackendBaseURL = codex.ChatGPTBackendBaseURL
)

// probeField 读取探针上下文里的一个字段；缺失返回空串。
func probeField(key string) string {
	for _, part := range strings.Split(os.Getenv(codexUsageProbeEnv), ",") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		if strings.TrimSpace(part[:index]) != key {
			continue
		}
		raw := strings.TrimSpace(part[index+1:])
		if raw == "" {
			continue
		}
		if decoded, err := url.QueryUnescape(raw); err == nil {
			return decoded
		}
		return raw
	}
	return ""
}

// directEnabled 报告是否允许直连 rate-limit 端点（Node 的 readCodexDirectMode）。
//
// direct=0 时 Node 不产出直连快照，这里同样按「凭据没有可信额度接口」处理。
func directEnabled() bool {
	return strings.TrimSpace(probeField("direct")) != "0"
}

// usagePath 返回 rate-limit 路径（Node 的 resolveCodexDirectRateLimitPath）。
func usagePath() string {
	if configured := strings.TrimSpace(probeField("path")); configured != "" {
		if strings.HasPrefix(configured, "/") {
			return configured
		}
		return "/" + configured
	}
	return defaultUsagePath
}

// usageEndpoint 按 Node 的 resolveCodexDirectBaseUrl 语义拼出前缀。
//
// 显式 baseUrl 优先；否则 /wham/* 挂 backend-api 根，其它路径挂 codex 前缀。
func usageEndpoint() string {
	base := strings.TrimRight(strings.TrimSpace(probeField("baseUrl")), "/")
	path := usagePath()
	if base == "" {
		base = chatGPTBackendBaseURL
		if !strings.HasPrefix(path, "/wham/") {
			base += "/codex"
		}
	}
	return base + path
}
