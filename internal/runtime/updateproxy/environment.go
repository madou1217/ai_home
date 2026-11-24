// Package updateproxy scopes an explicit download proxy to one update process.
//
// 代理分层（不要把这些层混成一套配置）：
//  1. 服务端 HTTP 出口：internal/runtime/outboundproxy，读 config:server.proxyUrl，
//     供 AIH 自身的 HTTP 客户端轮询使用。
//  2. 安装/更新出口：本包只负责把一次任务的代理 URL 编码成 curl/npm/原生安装器
//     都能识别的环境变量；选择器解析分别由 CLI 的管理面 lease 与 Server 的
//     sshproxy.LeaseManager 完成。
//  3. 系统/宿主代理：toolkit/network 只做诊断展示，不参与这里的任务出口。
package updateproxy

import (
	"fmt"
	"net/url"
	"runtime"
	"strconv"
	"strings"
)

// Environment copies base and overrides curl, native installer and npm proxy
// settings together. An inherited NO_PROXY must not bypass an explicit proxy.
func Environment(base map[string]string, raw string) (map[string]string, error) {
	return EnvironmentWithAnonymous(base, raw, "")
}

// EnvironmentWithAnonymous 与 Environment 相同，额外写入一个匿名入口地址。
//
// anonymous 为空时行为完全等同于 Environment。非空时写入
// AIH_TASK_PROXY_ANONYMOUS：那些会把代理 URL 里 userinfo 丢掉、又不支持
// 显式凭据的客户端（winget 已实测）必须用这个入口，否则一律 407。
func EnvironmentWithAnonymous(base map[string]string, raw string, anonymous string) (map[string]string, error) {
	proxy, err := parse(raw)
	if err != nil {
		return nil, err
	}
	env := make(map[string]string, len(base)+12)
	for key, value := range base {
		env[key] = value
	}
	values := map[string]string{
		"http_proxy": proxy.String(), "https_proxy": proxy.String(),
		"no_proxy": "", "npm_config_proxy": proxy.String(), "npm_config_https_proxy": proxy.String(),
		"npm_config_noproxy": "", "node_use_env_proxy": "1",
		"AIH_TASK_PROXY": proxy.String(),
	}
	if strings.TrimSpace(anonymous) != "" {
		values["AIH_TASK_PROXY_ANONYMOUS"] = strings.TrimSpace(anonymous)
	}
	// all_proxy 在 Windows 上必须留空。
	//
	// Windows 自带的 curl（System32\curl.exe）把 all_proxy 当作 SOCKS 入口解析，
	// 遇到 http://user:pass@host:port 会直接拒绝：
	//   curl: (5) Unsupported proxy syntax in 'http://aih:tok@127.0.0.1:18080'
	//   curl: (3) URL rejected: Port number was not a decimal number
	// 于是所有走 curl 的 Windows 安装计划（cmd 脚本计划全都是）在设了代理后
	// 反而比不设代理更糟：连下载都发不出去。HTTP(S)_PROXY 已被 curl/npm 识别，
	// 不需要 all_proxy 兜底。
	if !taskRunsOnWindows(base) {
		values["all_proxy"] = proxy.String()
		values["ALL_PROXY"] = proxy.String()
	}
	for key := range env {
		if value, ok := values[strings.ToLower(key)]; ok {
			env[key] = value
		}
	}
	for key, value := range values {
		env[key] = value
	}
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"} {
		env[key] = values[strings.ToLower(key)]
	}
	if _, set := values["ALL_PROXY"]; !set {
		// Windows：必须彻底移除，不能设成空串。
		// Windows 自带 curl 对 ALL_PROXY 的存在极其敏感——即使值是空串，
		// 经 cmd/宿主环境传播后它会看到 " " 并拒绝：
		//   curl: (5) Unsupported proxy syntax in ' ': Bad hostname
		// 设成 "" 只会把「坏代理」换成「坏 proxy 语法」，仍然下载不了。
		delete(env, "ALL_PROXY")
		delete(env, "all_proxy")
	}
	return env, nil
}

// UnsetForTask 返回一次任务执行时必须从宿主环境里删除的变量名。
//
// Windows 自带 curl 只要看到 ALL_PROXY 就会尝试把它当作 SOCKS 入口解析，
// 即使我们把它设成空串，经 cmd 传播后仍会变成 " " 并报
//   curl: (5) Unsupported proxy syntax in ' ': Bad hostname
// 所以那里不能「设为空」，只能真正移除变量。HTTP(S)_PROXY 已足够 curl/npm 使用。
//
// 平台判定用「环境事实」而不是调用方传进来的 base：WebUI 作业的 base 常常是
// nil（服务端没有 deps.Env），按 base 判断会导致这条规则在服务端永远不会生效。
func UnsetForTask(base map[string]string) []string {
	if !taskRunsOnWindows(base) {
		return nil
	}
	return []string{"ALL_PROXY", "all_proxy"}
}

// taskRunsOnWindows 判断任务将在哪个平台执行。
//
// 顺序很重要：base 里如果**明确**说明了平台（Windows 事实 或 POSIX 事实），
// 以它为准——同一进程可能把作业派发到别的平台（SSH 远端执行）。
// 只有 base 完全没有平台线索时才回落到本进程 GOOS：安装作业默认就在
// server/CLI 所在的机器上执行，这也是 WebUI 作业的实际情况（deps.Env 为 nil）。
func taskRunsOnWindows(base map[string]string) bool {
	if platform, known := platformFromEnv(base); known {
		return platform == "windows"
	}
	return runtime.GOOS == "windows"
}

// platformFromEnv 从环境里读出目标平台，读不出时返回 known=false。
func platformFromEnv(base map[string]string) (string, bool) {
	for key, value := range base {
		switch strings.ToUpper(key) {
		case "OS":
			trimmed := strings.TrimSpace(value)
			if strings.EqualFold(trimmed, "Windows_NT") {
				return "windows", true
			}
			if trimmed != "" {
				// OS=Darwin / OS=Linux 等：明确的 POSIX 事实。
				return "posix", true
			}
		case "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR":
			if strings.TrimSpace(value) != "" {
				return "windows", true
			}
		}
	}
	// POSIX 侧没有像 SystemRoot 这样普遍存在的标记，只在明确见到时才认。
	if strings.TrimSpace(base["HOME"]) != "" && !strings.Contains(strings.TrimSpace(base["HOME"]), `\`) {
		return "posix", true
	}
	return "", false
}


func parse(raw string) (*url.URL, error) {
	proxy, err := url.Parse(raw)
	if err != nil || raw == "" || strings.ContainsAny(raw, " \t\r\n") || proxy == nil {
		return nil, fmt.Errorf("--proxy 需要有效的 HTTP(S) 代理 URL")
	}
	if proxy.Scheme != "http" && proxy.Scheme != "https" {
		return nil, fmt.Errorf("--proxy 仅支持 http:// 或 https://；SSH -D 的 SOCKS 代理需要先转换为 HTTP 代理")
	}
	if proxy.Hostname() == "" || proxy.Opaque != "" || proxy.RawQuery != "" || proxy.ForceQuery || proxy.Fragment != "" || (proxy.Path != "" && proxy.Path != "/") {
		return nil, fmt.Errorf("--proxy 需要 HTTP(S) 代理地址，不能包含路径、查询或片段")
	}
	if port := proxy.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return nil, fmt.Errorf("--proxy 端口必须在 1-65535 之间")
		}
	} else if strings.HasSuffix(proxy.Host, ":") {
		return nil, fmt.Errorf("--proxy 端口不能为空")
	}
	return proxy, nil
}

// Redact removes proxy credentials if an upstream installer includes its proxy
// URL or password in an error. Neither help nor progress prints the raw URL.
func Redact(message string, raw string) string {
	proxy, err := parse(raw)
	if err != nil || proxy.User == nil {
		return message
	}
	user := proxy.User
	proxy.User = nil
	message = strings.ReplaceAll(message, raw, proxy.String())
	message = strings.ReplaceAll(message, user.String()+"@", "[redacted]@")
	if password, ok := user.Password(); ok && password != "" {
		message = strings.ReplaceAll(message, password, "[redacted]")
		message = strings.ReplaceAll(message, url.QueryEscape(password), "[redacted]")
	}
	return message
}
