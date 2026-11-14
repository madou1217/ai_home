package webuiopenappapi

import (
	"context"
	"net/url"
	"strings"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

type egressManagerAdapter struct {
	manager   *runtimeegress.Manager
	aiHomeDir string
	guard     *runtimeegress.GatewayNetworkGuard
}

func newEgressManagerAdapter(manager *runtimeegress.Manager, aiHomeDir string) *egressManagerAdapter {
	if manager == nil {
		return nil
	}
	return &egressManagerAdapter{
		manager:   manager,
		aiHomeDir: strings.TrimSpace(aiHomeDir),
		guard:     runtimeegress.NewGatewayNetworkGuard(manager),
	}
}

func (a *egressManagerAdapter) Resolve(ctx context.Context, provider, accountRef, platform string) EgressResolution {
	if a == nil || a.manager == nil {
		return EgressResolution{OK: true}
	}
	res, err := a.manager.ResolveAccountEgress(ctx, runtimeegress.ResolveAccountEgressOptions{
		Provider:   provider,
		AccountRef: accountRef,
		Platform:   normalizeEgressPlatform(platform),
	})
	if err != nil {
		errCode := "account_egress_unavailable"
		if strings.EqualFold(provider, "zcode") {
			errCode = "zcode_egress_unavailable"
		}
		return EgressResolution{
			OK:      false,
			Bound:   res.Bound,
			Error:   errCode,
			Reason:  err.Error(),
			Message: err.Error(),
		}
	}
	out := EgressResolution{
		OK:          res.OK,
		Bound:       res.Bound,
		Source:      res.Source,
		ProxyServer: strings.TrimSpace(res.ProxyServer),
		Direct:      res.Direct,
		Error:       strings.TrimSpace(res.Error),
		Reason:      strings.TrimSpace(res.Reason),
	}
	if !out.OK {
		out.Error = normalizeEgressErrorCode(provider, out.Error, out.Reason)
		return out
	}
	out.Warning = describeEgressWarning(out)
	return out
}

func (a *egressManagerAdapter) CheckLaunchNetwork(
	ctx context.Context,
	aiHomeDir string,
	provider string,
	accountRef string,
	env []string,
	res EgressResolution,
) (bool, string) {
	if a == nil || a.guard == nil {
		return false, ""
	}
	if res.Source == "pool" {
		return false, ""
	}
	baseURLs := readEnvBaseUrls(env)
	for _, raw := range baseURLs {
		if isLoopbackBaseURL(raw) {
			return false, ""
		}
	}

	proxyURL := ""
	noProxy := ""
	if res.Bound {
		if res.Direct {
			proxyURL = ""
			noProxy = "*"
		} else {
			proxyURL = strings.TrimSpace(res.ProxyServer)
		}
	} else {
		proxyURL = firstEnvProxy(env)
	}

	acc := runtimeegress.AccountRecord{
		Provider:   provider,
		AccountRef: accountRef,
	}
	if len(baseURLs) > 0 {
		acc.APIKeyMode = true
		acc.BaseURL = baseURLs[0]
		acc.OpenAIBaseURL = baseURLs[0]
	}
	denial := a.guard.CheckGatewayNetwork(ctx, runtimeegress.GatewayNetworkCheckInput{
		Account:      acc,
		EgressSource: res.Source,
		ProxyURL:     proxyURL,
		NoProxy:      noProxy,
	})
	if denial != nil && denial.Denied {
		return true, strings.TrimSpace(denial.Reason)
	}
	return false, ""
}

func normalizeEgressPlatform(platform string) string {
	switch normalizePlatformKey(platform) {
	case "darwin":
		return "darwin"
	case "windows":
		return "win32"
	default:
		return "linux"
	}
}

func normalizeEgressErrorCode(provider, code, reason string) string {
	isZcode := strings.EqualFold(strings.TrimSpace(provider), "zcode")
	switch strings.TrimSpace(code) {
	case "account_egress_binding_unavailable", "zcode_egress_binding_unavailable":
		if isZcode {
			return "zcode_egress_binding_unavailable"
		}
		return "account_egress_binding_unavailable"
	case "":
		if strings.Contains(reason, "binding") {
			if isZcode {
				return "zcode_egress_binding_unavailable"
			}
			return "account_egress_binding_unavailable"
		}
		if isZcode {
			return "zcode_egress_unavailable"
		}
		return "account_egress_unavailable"
	default:
		if isZcode && strings.HasPrefix(code, "account_egress_") {
			return "zcode_egress_" + strings.TrimPrefix(code, "account_egress_")
		}
		return code
	}
}

func describeEgressWarning(res EgressResolution) string {
	if !res.Bound {
		return ""
	}
	if res.Source == "tun" {
		return "当前账号绑定了外部 TUN 出口；AIH 将按直连通道启动应用，不注入 HTTP 代理。"
	}
	if res.Source == "system" && res.Direct {
		return "当前系统代理为直连模式，AIH 已校验后按直连启动应用。"
	}
	return ""
}

func describeAlreadyRunningWarning(existingWarning string, res EgressResolution) string {
	base := strings.TrimSpace(existingWarning)
	if !res.Bound {
		return base
	}
	note := "该桌面实例已在运行，已切回前台；新配置的账号出口需关闭后重新打开才会生效。"
	if res.Direct || res.ProxyServer != "" {
		if base == "" {
			return note
		}
		return base + " " + note
	}
	return base
}

var proxyEnvKeys = []string{
	"HTTP_PROXY", "http_proxy",
	"HTTPS_PROXY", "https_proxy",
	"ALL_PROXY", "all_proxy",
}

var allProxyEnvKeys = []string{
	"HTTP_PROXY", "http_proxy",
	"HTTPS_PROXY", "https_proxy",
	"ALL_PROXY", "all_proxy",
	"NO_PROXY", "no_proxy",
}

var chromiumProxyPrefixes = []string{
	"--proxy-server=",
	"--proxy-bypass-list=",
	"--no-proxy-server",
}

// applyAccountEgressProxyEnv 将解析好的账号出口写入环境变量。
// ZCode 统一消费 setting.json 内的 httpProxy/httpProxyNoProxy，必须先清空继承代理且不额外注入环境变量。
func applyAccountEgressProxyEnv(provider string, env []string, res EgressResolution) []string {
	m := envSliceToMap(env)
	if strings.EqualFold(strings.TrimSpace(provider), "zcode") {
		for _, key := range allProxyEnvKeys {
			deleteEnvKey(m, key)
		}
		return mapToEnvSlice(m)
	}
	if res.Bound {
		if res.Direct {
			for _, key := range proxyEnvKeys {
				deleteEnvKey(m, key)
			}
		} else if res.ProxyServer != "" {
			for _, key := range proxyEnvKeys {
				setEnvKey(m, key, res.ProxyServer)
			}
			mergeNoProxyMap(m)
		}
	} else {
		mergeNoProxyMap(m)
	}
	return mapToEnvSlice(m)
}

func decorateChromiumEgressArgs(provider string, args []string, res EgressResolution) []string {
	out := make([]string, 0, len(args)+2)
	for _, arg := range args {
		skip := false
		for _, prefix := range chromiumProxyPrefixes {
			if strings.HasPrefix(arg, prefix) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, arg)
		}
	}
	if strings.EqualFold(strings.TrimSpace(provider), "zcode") || !res.Bound {
		return out
	}
	if res.Direct {
		return append(out, "--no-proxy-server")
	}
	if strings.TrimSpace(res.ProxyServer) != "" {
		return append(out,
			"--proxy-server="+strings.TrimSpace(res.ProxyServer),
			"--proxy-bypass-list=localhost;127.0.0.1;[::1]",
		)
	}
	return out
}

func mergeNoProxyMap(m map[string]envEntry) {
	existing := firstEnvValue(m, "NO_PROXY", "no_proxy")
	seen := make(map[string]struct{})
	items := make([]string, 0, 8)
	for _, token := range append(strings.Split(existing, ","), "localhost", "127.0.0.1", "::1") {
		trimmed := strings.TrimSpace(token)
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if _, exists := seen[lower]; exists {
			continue
		}
		seen[lower] = struct{}{}
		items = append(items, trimmed)
	}
	joined := strings.Join(items, ",")
	setEnvKey(m, "NO_PROXY", joined)
	setEnvKey(m, "no_proxy", joined)
}

func readEnvBaseUrls(env []string) []string {
	var out []string
	for _, entry := range env {
		name, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		upper := strings.ToUpper(strings.TrimSpace(name))
		if strings.HasPrefix(upper, "AIH_") || !strings.HasSuffix(upper, "_BASE_URL") {
			continue
		}
		val := strings.TrimSpace(value)
		lower := strings.ToLower(val)
		if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
			out = append(out, val)
		}
	}
	return out
}

func isLoopbackBaseURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	return host == "localhost" || host == "::1" || strings.HasPrefix(host, "127.")
}

func firstEnvProxy(env []string) string {
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"} {
		for _, entry := range env {
			name, value, found := strings.Cut(entry, "=")
			if found && name == key && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	return ""
}

type envEntry struct {
	name  string
	value string
}

func envSliceToMap(env []string) map[string]envEntry {
	out := make(map[string]envEntry, len(env))
	for _, raw := range env {
		name, value, ok := strings.Cut(raw, "=")
		if !ok || strings.TrimSpace(name) == "" {
			continue
		}
		out[strings.ToUpper(name)] = envEntry{name: name, value: value}
	}
	return out
}

func setEnvKey(m map[string]envEntry, name, value string) {
	m[strings.ToUpper(name)] = envEntry{name: name, value: value}
}

func deleteEnvKey(m map[string]envEntry, name string) {
	delete(m, strings.ToUpper(name))
}

func firstEnvValue(m map[string]envEntry, keys ...string) string {
	for _, key := range keys {
		if entry, ok := m[strings.ToUpper(key)]; ok && strings.TrimSpace(entry.value) != "" {
			return entry.value
		}
	}
	return ""
}

func mapToEnvSlice(m map[string]envEntry) []string {
	out := make([]string, 0, len(m))
	for _, entry := range m {
		out = append(out, entry.name+"="+entry.value)
	}
	return out
}
