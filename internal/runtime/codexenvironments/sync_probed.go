package codexenvironments

import (
	"context"
	"net"
	"strconv"
	"time"
)

// ProbeOptions 是一次「探测后同步」的输入。
type ProbeOptions struct {
	AIHomeDir string
	CodexHome string
	// HomeDir 用于 ~ 展开与默认 known_hosts。
	HomeDir string
	// IncludeLocal 控制是否在 environments.toml 里保留本机环境。
	IncludeLocal bool
	// Dialer 为空时使用 AIH 自己的 sshremote 拨号。
	Dialer SSHDialer
	// SkipProbe 为真时跳过探测，直接写入全部可渲染的连接（离线/调试用）。
	SkipProbe bool
	// URLHosts 为空时 url 模式条目不写入（表示没有通道宿主在跑）。
	// 非空时 key 是连接 ID，值是该连接实际监听的本机端口。
	URLHosts map[string]int
	// HostSupervisor 非空时会先把需要 url 模式的连接交给它常驻，
	// 再按它的实际端口写入条目。这样调用方不需要自己管端口分配。
	HostSupervisor *HostSupervisor
	// DetectURLHosts 为真时，按固定端口探测本机是否已有常驻宿主在监听。
	//
	// CLI 进程不拥有常驻宿主（它几秒就退出），宿主由 Server 的后台守护
	// 维持；CLI 只写那些端口确实已经在监听的 url 条目。
	DetectURLHosts bool
}

// SyncProbed 探测全部连接，只把可用的写进 environments.toml。
//
// 探测走 AIH 自己的拨号能力（凭据、known_hosts、跳板都与用户点「测试连接」一致），
// 因此不可达的连接不会被写进去、也就不会在 Codex 里变成长期报错项。
//
// 探测结论会缓存到 AIH 的 run 目录：CLI 进程活不久，缓存让「上次探过」的结论
// 在下次启动时立即生效，不必每条连接都重连一次 SSH。
func SyncProbed(ctx context.Context, options ProbeOptions) (SyncReport, error) {
	report := SyncReport{}
	report.CacheHit = false
	connections := LoadConnectionsForProbe(ctx, options.AIHomeDir)
	report.URLReasons = map[string]Reason{}
	switch {
	case options.HostSupervisor != nil:
		options.URLHosts = ensureURLHosts(ctx, options, connections)
	case options.DetectURLHosts:
		options.URLHosts = detectRunningURLHosts(ctx, connections)
	}

	// url 条目和 program 条目必须分开保存：program 条目还要过探测，
	// 而探测分支只重建 program 的最终列表。混在一起会在有 program 连接时
	// 把已经就绪的 url 条目悄悄丢掉（真机验证时踩到）。
	urlEntries := make([]Entry, 0, len(connections))
	entries := make([]Entry, 0, len(connections))
	candidates := make([]Connection, 0, len(connections))
	for _, connection := range connections {
		mode, reason := SelectMode(connection)
		if mode == ModeURL {
			// url 模式只有在真的有宿主监听时才写；否则 Codex 会连一个空端口。
			port, running := options.URLHosts[connection.ID]
			if !running || port <= 0 {
				report.Rejected = append(report.Rejected, Rejection{
					ConnectionID: connection.ID,
					Label:        firstNonEmpty(connection.Label, connection.ID),
					Code:         CodeURLHostRequired,
					Message:      urlReasonMessage(reason),
				})
				continue
			}
			entry, rejection := BuildURLEntry(URLEnvironment{ConnectionID: connection.ID, LocalPort: port})
			if rejection != nil {
				report.Rejected = append(report.Rejected, *rejection)
				continue
			}
			report.URLReasons[connection.ID] = reason
			urlEntries = append(urlEntries, entry)
			continue
		}
		entry, rejection := BuildEntry(connection)
		if rejection != nil {
			report.Rejected = append(report.Rejected, *rejection)
			continue
		}
		entries = append(entries, entry)
		candidates = append(candidates, connection)
	}
	if options.SkipProbe || len(candidates) == 0 {
		outcome, err := SyncFile(options.CodexHome, append(append([]Entry{}, urlEntries...), entries...), options.IncludeLocal)
		if err != nil {
			return report, err
		}
		report.Outcome = outcome
		return report, nil
	}
	if cached, ok := LoadCache(options.AIHomeDir, time.Now()); ok && coversConnections(cached, candidates) {
		report.Probes = cached
		report.CacheHit = true
	} else {
		dialer := options.Dialer
		if dialer == nil {
			dialer = SSHRemoteExecutor{HomeDir: options.HomeDir}
		}
		report.Probes = ProbeAll(ctx, dialer, candidates)
		_ = SaveCache(options.AIHomeDir, report.Probes, time.Now())
	}
	available, probeRejected := FilterAvailable(candidates, report.Probes)
	report.Rejected = append(report.Rejected, probeRejected...)

	// 用探测到的绝对路径渲染，避免 Codex 命中 PATH 里不可用的同名程序。
	codexPathByID := make(map[string]string, len(report.Probes))
	for _, probe := range report.Probes {
		codexPathByID[probe.ConnectionID] = probe.CodexPath
	}
	readyEntries := make([]Entry, 0, len(available)+len(urlEntries))
	readyEntries = append(readyEntries, urlEntries...)
	for _, connection := range available {
		entry, rejection := BuildEntryFor(connection, codexPathByID[connection.ID])
		if rejection != nil {
			continue
		}
		readyEntries = append(readyEntries, entry)
	}

	outcome, err := SyncFile(options.CodexHome, readyEntries, options.IncludeLocal)
	if err != nil {
		return report, err
	}
	report.Outcome = outcome
	return report, nil
}

// urlReasonMessage 把模式原因翻译成可展示的说明。
func urlReasonMessage(reason Reason) string {
	switch reason {
	case ReasonPasswordAuth:
		return "该连接使用密码认证，需要 AIH 常驻通道宿主（url 模式）才能接入 Codex"
	case ReasonJumpNeedsKey:
		return "跳板使用专用私钥，ProxyJump 无法逐跳指定凭据，需要 url 模式"
	case ReasonJumpNeedsPasswd:
		return "跳板使用密码认证，ProxyJump 无法提供密码，需要 url 模式"
	default:
		return "该连接需要 url 模式"
	}
}

// ensureURLHosts 把需要 url 模式的连接交给监督器，并返回稳定端口映射。
//
// 端口由连接 ID 决定，因此重复调用得到同一组端口；监督器内部按「已存在的
// 不再重启」处理。已经在监督器里的连接不再重复探测——Server 的常驻守护会
// 周期性调用这里，重复探测会让每条连接每轮都多一次 SSH 往返。
func ensureURLHosts(ctx context.Context, options ProbeOptions, connections []Connection) map[string]int {
	_, urlConnections, _ := SplitByMode(connections)
	if len(urlConnections) == 0 {
		options.HostSupervisor.Apply(ctx, nil, options.HomeDir)
		return nil
	}
	tracked := make(map[string]struct{})
	for _, status := range options.HostSupervisor.Status() {
		tracked[status.ConnectionID] = struct{}{}
	}
	pending := make([]Connection, 0, len(urlConnections))
	for _, connection := range urlConnections {
		if _, running := tracked[connection.ID]; !running {
			pending = append(pending, connection)
		}
	}
	// url 型连接同样要先探测出远端 codex 路径，否则会在远端跑 PATH 里第一个
	// 同名程序——Windows 上实测那可能是不兼容的旧 exe。只探测新连接。
	codexPaths := make(map[string]string, len(pending))
	if len(pending) > 0 {
		dialer := options.Dialer
		if dialer == nil {
			dialer = SSHRemoteExecutor{HomeDir: options.HomeDir}
		}
		for _, probe := range ProbeAll(ctx, dialer, pending) {
			if probe.Available() {
				codexPaths[probe.ConnectionID] = probe.CodexPath
			}
		}
	}
	ids := make([]string, 0, len(urlConnections))
	for _, connection := range urlConnections {
		ids = append(ids, connection.ID)
	}
	ports := AllocateHostPorts(ids)
	specs := make([]HostSpec, 0, len(urlConnections))
	hosts := make(map[string]int, len(urlConnections))
	for _, connection := range urlConnections {
		port := ports[connection.ID]
		specs = append(specs, HostSpec{
			Connection: connection,
			ListenPort: port,
			CodexPath:  codexPaths[connection.ID],
		})
		hosts[connection.ID] = port
	}
	options.HostSupervisor.Apply(ctx, specs, options.HomeDir)
	return hosts
}

// ReconcileURLHosts 让监督器上的 url 宿主与当前 SSH 连接集合一致。
//
// 只负责宿主生命周期，不写 environments.toml：Server 没有 CLI 的 per-launch
// CODEX_HOME，写文件仍由 CLI 的 SyncProbed 完成。
func ReconcileURLHosts(ctx context.Context, options ProbeOptions) map[string]int {
	if options.HostSupervisor == nil {
		return nil
	}
	connections := LoadConnectionsForProbe(ctx, options.AIHomeDir)
	if connections == nil {
		// 读取失败（或从未配置）不能当成「用户删光了连接」：否则一次瞬时
		// 数据库错误就会把所有 url 宿主关掉再重建。真正的空列表是非 nil 的。
		return nil
	}
	return ensureURLHosts(ctx, options, connections)
}

// urlHostDetectWait 是 CLI 等待 Server 拉起新宿主的预算。
//
// 已有宿主时端口本来就在监听，不会等；只有新连接（Server 还在建通道）才会
// 用满这段预算。超时后该连接按「宿主未就绪」拒绝写入，不会产生坏地址。
const (
	urlHostDetectWait = 6 * time.Second
	urlHostDialWait   = 200 * time.Millisecond
	urlHostDetectPoll = 200 * time.Millisecond
)

// detectRunningURLHosts 只返回本机确实在监听的固定端口。
//
// CLI 不持有宿主，也不能凭「Server 应该起过」就写 url 地址——写一个没人在
// 监听的端口，Codex 只会得到 connection refused。
func detectRunningURLHosts(ctx context.Context, connections []Connection) map[string]int {
	_, urlConnections, _ := SplitByMode(connections)
	if len(urlConnections) == 0 {
		return nil
	}
	ids := make([]string, 0, len(urlConnections))
	for _, connection := range urlConnections {
		ids = append(ids, connection.ID)
	}
	ports := AllocateHostPorts(ids)
	deadline := time.Now().Add(urlHostDetectWait)
	for {
		hosts := make(map[string]int, len(ports))
		for id, port := range ports {
			if loopbackListening(port) {
				hosts[id] = port
			}
		}
		if len(hosts) == len(ports) || !time.Now().Before(deadline) {
			return hosts
		}
		select {
		case <-ctx.Done():
			return hosts
		case <-time.After(urlHostDetectPoll):
		}
	}
}

func loopbackListening(port int) bool {
	if port <= 0 {
		return false
	}
	connection, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		urlHostDialWait,
	)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}
