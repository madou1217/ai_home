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
	"strconv"
	"strings"
)

// Environment copies base and overrides curl, native installer and npm proxy
// settings together. An inherited NO_PROXY must not bypass an explicit proxy.
func Environment(base map[string]string, raw string) (map[string]string, error) {
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
	// all_proxy 在 Windows 上必须留空。
	//
	// Windows 自带的 curl（System32\curl.exe）把 all_proxy 当作 SOCKS 入口解析，
	// 遇到 http://user:pass@host:port 会直接拒绝：
	//   curl: (5) Unsupported proxy syntax in 'http://aih:tok@127.0.0.1:18080'
	//   curl: (3) URL rejected: Port number was not a decimal number
	// 于是所有走 curl 的 Windows 安装计划（cmd 脚本计划全都是）在设了代理后
	// 反而比不设代理更糟：连下载都发不出去。HTTP(S)_PROXY 已被 curl/npm 识别，
	// 不需要 all_proxy 兜底。
	if !isWindowsEnv(base) {
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
func UnsetForTask(base map[string]string) []string {
	if !isWindowsEnv(base) {
		return nil
	}
	return []string{"ALL_PROXY", "all_proxy"}
}

// isWindowsEnv 从环境本身判断目标平台，避免让本包依赖 GOOS。
// 调用方在 Windows 上的安装作业一律带 SystemRoot/OS=Windows_NT。
func isWindowsEnv(base map[string]string) bool {
	for key, value := range base {
		switch strings.ToUpper(key) {
		case "OS":
			if strings.EqualFold(strings.TrimSpace(value), "Windows_NT") {
				return true
			}
		case "SYSTEMROOT", "SYSTEMDRIVE":
			return true
		}
	}
	return false
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
