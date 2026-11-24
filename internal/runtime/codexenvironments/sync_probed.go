package codexenvironments

import (
	"context"
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
}

// SyncProbed 探测全部连接，只把可用的写进 environments.toml。
//
// 探测走 AIH 自己的拨号能力（凭据、known_hosts、跳板都与用户点「测试连接」一致），
// 因此不可达的连接不会被写进去、也就不会在 Codex 里变成长期报错项。
func SyncProbed(ctx context.Context, options ProbeOptions) (SyncReport, error) {
	report := SyncReport{}
	connections := LoadConnectionsForProbe(ctx, options.AIHomeDir)
	entries := make([]Entry, 0, len(connections))
	candidates := make([]Connection, 0, len(connections))
	for _, connection := range connections {
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
	dialer := options.Dialer
	if dialer == nil {
		dialer = SSHRemoteExecutor{HomeDir: options.HomeDir}
	}
	report.Probes = ProbeAll(ctx, dialer, candidates)
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
