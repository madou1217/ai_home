package codexenvironments

import (
	"context"
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
			entries = append(entries, entry)
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
		outcome, err := SyncFile(options.CodexHome, entries, options.IncludeLocal)
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
	readyEntries := make([]Entry, 0, len(available))
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
