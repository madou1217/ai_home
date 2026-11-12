package egress

import (
	"context"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// 本文件对应 Node 的两个探测实现：
//
//   - lib/cli/services/toolkit/proxy-manager.js + system-proxy-plugins/macos.js
//     的 detectProxy：scutil --proxy 的汇总视图；未启用时回退 networksetup
//     按网络服务逐项读（TUN/网络扩展接管时汇总视图可能为空，但服务上配着代理）；
//   - lib/cli/services/toolkit/system-network-manager.js 的 detectTun：
//     ifconfig / netstat -rn / ps 三条命令，interface 命中且（route 命中或存在
//     网络内核进程）才算 active，否则 inactive / unknown。
//
// 命令超时与输出上限沿用 Node 的 4s / 256KB；读路径失败一律降级成「探测不到」，
// 由调用方 fail-closed，不抛到 OAuth 刷新链以外。

const (
	detectionCommandTimeout = 4 * time.Second
	detectionOutputLimit    = 256 * 1024
)

// SystemProxyStatus 是系统代理探测结果（只保留出口解析需要的字段）。
type SystemProxyStatus struct {
	Enabled     bool
	HTTPProxy   string
	HTTPSProxy  string
	SOCKSProxy  string
	ProbeStatus string
	Source      string
}

// TUNStatus 是外部 TUN 探测结果，State 取值 active / inactive / unknown。
type TUNStatus struct {
	State string
	Owner string
}

// SystemProxyDetector 探测当前系统代理；注入点用于测试与宿主替换。
type SystemProxyDetector func(ctx context.Context) (SystemProxyStatus, error)

// TUNDetector 探测外部 TUN 状态；注入点用于测试与宿主替换。
type TUNDetector func(ctx context.Context) (TUNStatus, error)

var (
	scutilHTTPEnabledPattern  = regexp.MustCompile("(?i)HTTPEnable\\s*:\\s*1")
	scutilHTTPSEnabledPattern = regexp.MustCompile("(?i)HTTPSEnable\\s*:\\s*1")
	scutilSOCKSEnabledPattern = regexp.MustCompile("(?i)SOCKSEnable\\s*:\\s*1")
	scutilHTTPHostPattern     = regexp.MustCompile("(?i)HTTPProxy\\s*:\\s*([^\\s]+)")
	scutilHTTPPortPattern     = regexp.MustCompile("(?i)HTTPPort\\s*:\\s*([0-9]+)")
	scutilHTTPSHostPattern    = regexp.MustCompile("(?i)HTTPSProxy\\s*:\\s*([^\\s]+)")
	scutilHTTPSPortPattern    = regexp.MustCompile("(?i)HTTPSPort\\s*:\\s*([0-9]+)")
	scutilSOCKSHostPattern    = regexp.MustCompile("(?i)SOCKSProxy\\s*:\\s*([^\\s]+)")
	scutilSOCKSPortPattern    = regexp.MustCompile("(?i)SOCKSPort\\s*:\\s*([0-9]+)")
	serviceOrderPattern       = regexp.MustCompile("^\\([0-9]+\\)\\s+(.+?)\\s*$")
	serviceDisabledPattern    = regexp.MustCompile("^\\s*\\(\\*\\)")
	serviceEnabledPattern     = regexp.MustCompile("(?i)Enabled:\\s*Yes")
	serviceServerPattern      = regexp.MustCompile("(?i)Server:\\s*([^\\s]+)")
	servicePortPattern        = regexp.MustCompile("(?i)Port:\\s*([0-9]+)")
	tunInterfacePattern       = regexp.MustCompile("(?m)^utun[0-9]+:")
	tunRoutePattern           = regexp.MustCompile("(?i)utun[0-9]+")
	tunClashVergePattern      = regexp.MustCompile("clash[- ]?verge|verge[- ]mihomo")
)

// detectMacOSSystemProxy 是 SystemProxyDetector 的默认实现。
func detectMacOSSystemProxy(ctx context.Context) (SystemProxyStatus, error) {
	status := SystemProxyStatus{ProbeStatus: "unsupported", Source: "scutil --proxy"}
	output, err := runProbeCommand(ctx, "scutil", "--proxy")
	if err != nil {
		return status, err
	}
	applyScutilProxyOutput(output, &status)
	// Node 只在 scutil 成功且有输出、但汇总视图未启用时回退到按网络服务读。
	if !status.Enabled && output != "" {
		if service, ok := detectServiceProxy(ctx); ok {
			status.Source = "networksetup -getwebproxy"
			status.Enabled = true
			status.ProbeStatus = "available"
			status.HTTPProxy = service.HTTPProxy
			status.HTTPSProxy = service.HTTPSProxy
			status.SOCKSProxy = service.SOCKSProxy
		}
	}
	return status, nil
}

// applyScutilProxyOutput 解析 scutil --proxy 的汇总视图。
func applyScutilProxyOutput(output string, status *SystemProxyStatus) {
	status.Enabled = scutilHTTPEnabledPattern.MatchString(output) ||
		scutilHTTPSEnabledPattern.MatchString(output) ||
		scutilSOCKSEnabledPattern.MatchString(output)
	if status.Enabled {
		status.ProbeStatus = "available"
	} else {
		status.ProbeStatus = "unset"
	}
	if scutilHTTPEnabledPattern.MatchString(output) {
		status.HTTPProxy = proxyAddress(
			firstGroup(scutilHTTPHostPattern, output),
			firstGroup(scutilHTTPPortPattern, output),
			false,
		)
	}
	if scutilHTTPSEnabledPattern.MatchString(output) {
		// Node 对 HTTPS 代理同样写 http://：macOS 的 HTTPSProxy 是 HTTP CONNECT。
		status.HTTPSProxy = proxyAddress(
			firstGroup(scutilHTTPSHostPattern, output),
			firstGroup(scutilHTTPSPortPattern, output),
			false,
		)
	}
	if scutilSOCKSEnabledPattern.MatchString(output) {
		status.SOCKSProxy = proxyAddress(
			firstGroup(scutilSOCKSHostPattern, output),
			firstGroup(scutilSOCKSPortPattern, output),
			true,
		)
	}
}

// proxyService 是 networksetup 里的一个网络服务。
type proxyService struct {
	Name       string
	HTTPProxy  string
	HTTPSProxy string
	SOCKSProxy string
}

// detectServiceProxy 对应 macos.js 的 detectServiceProxy()：按服务顺序逐项读，
// 汇总第一个非空代理。任一命令失败只跳过该项（Node 同样安静降级）。
func detectServiceProxy(ctx context.Context) (proxyService, bool) {
	orderOutput, err := runProbeCommand(ctx, "networksetup", "-listnetworkserviceorder")
	if err != nil || orderOutput == "" {
		return proxyService{}, false
	}
	services := parseServiceOrder(orderOutput)
	if len(services) == 0 {
		return proxyService{}, false
	}
	combined := proxyService{}
	for _, service := range services {
		probes := map[string]string{}
		for _, command := range []string{"-getwebproxy", "-getsecurewebproxy", "-getsocksfirewallproxy"} {
			probes[command], _ = runProbeCommand(ctx, "networksetup", command, service.Name)
		}
		if combined.HTTPProxy == "" {
			combined.HTTPProxy = enabledProxyAddress(probes["-getwebproxy"], false)
		}
		if combined.HTTPSProxy == "" {
			combined.HTTPSProxy = enabledProxyAddress(probes["-getsecurewebproxy"], false)
		}
		if combined.SOCKSProxy == "" {
			combined.SOCKSProxy = enabledProxyAddress(probes["-getsocksfirewallproxy"], true)
		}
	}
	if combined.HTTPProxy == "" && combined.HTTPSProxy == "" && combined.SOCKSProxy == "" {
		return proxyService{}, false
	}
	return combined, true
}

// parseServiceOrder 对应 Node parseServiceOrder()，含它对星号行的处理：
// 标记上一条服务为停用，停用的服务不参与探测。
func parseServiceOrder(output string) []proxyService {
	services := make([]proxyService, 0, 4)
	for _, line := range strings.Split(output, "\n") {
		if match := serviceOrderPattern.FindStringSubmatch(line); match != nil {
			name := strings.TrimSpace(match[1])
			if name != "" {
				services = append(services, proxyService{Name: name})
			}
			continue
		}
		if serviceDisabledPattern.MatchString(line) && len(services) > 0 {
			services = services[:len(services)-1]
		}
	}
	return services
}

// enabledProxyAddress 解析 networksetup -get*xproxy 的输出；未启用或缺字段返回 ”。
func enabledProxyAddress(output string, socks bool) string {
	if !serviceEnabledPattern.MatchString(output) {
		return ""
	}
	return proxyAddress(
		firstGroup(serviceServerPattern, output),
		firstGroup(servicePortPattern, output),
		socks,
	)
}

// proxyAddress 拼出代理地址；host/port 缺失返回 ”。
func proxyAddress(host string, port string, socks bool) string {
	if host == "" || port == "" {
		return ""
	}
	if socks {
		return "socks5://" + host + ":" + port
	}
	return "http://" + host + ":" + port
}

// firstGroup 返回第一个捕获组，未命中返回 ”。
func firstGroup(pattern *regexp.Regexp, value string) string {
	match := pattern.FindStringSubmatch(value)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

// detectMacOSTUN 是 TUNDetector 的默认实现。
//
// 命令失败按空输出处理：Node 的 tun.probe 也只用 stdout（失败时为空），
// 由 interface/route/process 三个证据的组合作出 inactive / unknown 结论。
func detectMacOSTUN(ctx context.Context) (TUNStatus, error) {
	interfaceOutput, _ := runProbeCommand(ctx, "ifconfig")
	routeOutput, _ := runProbeCommand(ctx, "netstat", "-rn")
	processOutput, _ := runProbeCommand(ctx, "ps", "-axo", "pid=,command=")
	return parseTUNOutputs(interfaceOutput, routeOutput, processOutput), nil
}

// parseTUNOutputs 对应 Node detectTun() + parseTunProcesses() 的判定。
//
// 注意 processActive 的语义与 Node 一致：只要 ps 有输出就视为存在网络内核进程
// （macOS 上 ps 永远有输出），因此 active 实际由 interface 命中决定。
func parseTUNOutputs(interfaceOutput string, routeOutput string, processOutput string) TUNStatus {
	interfaceDetected := tunInterfacePattern.MatchString(interfaceOutput)
	routeDetected := tunRoutePattern.MatchString(routeOutput)
	processActive, owner := parseTUNProcesses(processOutput)
	active := interfaceDetected && (routeDetected || processActive)
	if active {
		return TUNStatus{State: "active", Owner: owner}
	}
	if interfaceDetected || routeDetected {
		return TUNStatus{State: "unknown"}
	}
	return TUNStatus{State: "inactive"}
}

// parseTUNProcesses 对应 Node parseTunProcesses()：先认已知内核，再给 external。
func parseTUNProcesses(output string) (bool, string) {
	lower := strings.ToLower(output)
	if strings.TrimSpace(lower) == "" {
		return false, ""
	}
	switch {
	case tunClashVergePattern.MatchString(lower):
		return true, "clash-verge"
	case strings.Contains(lower, "mihomo") || strings.Contains(lower, "clash-meta"):
		return true, "mihomo"
	case strings.Contains(lower, "sing-box") || strings.Contains(lower, "singbox"):
		return true, "sing-box"
	default:
		return true, "external"
	}
}

// runProbeCommand 执行一条探测命令，返回 trim 后的 stdout。
//
// 超时与输出上限与 Node execCommand 一致（4s / 256KB），避免 TUN 探测把刷新链
// 卡在子进程上。
func runProbeCommand(ctx context.Context, name string, args ...string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	commandContext, cancel := context.WithTimeout(ctx, detectionCommandTimeout)
	defer cancel()
	output, err := exec.CommandContext(commandContext, name, args...).Output()
	if err != nil {
		return "", err
	}
	if len(output) > detectionOutputLimit {
		output = output[:detectionOutputLimit]
	}
	return strings.TrimSpace(string(output)), nil
}
