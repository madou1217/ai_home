package codexenvironments

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// ProbeResult 是一条连接能否承载 Codex 执行环境的实测结论。
type ProbeResult struct {
	ConnectionID string
	Label        string
	// Reachable 为真表示 SSH 登录成功。
	Reachable bool
	// CodexFound 为真表示远端登录 shell 里能直接执行 codex。
	CodexFound bool
	// CodexPath 是探测到的可执行文件路径（为空表示没找到）。
	CodexPath string
	// Detail 是失败时的人类可读原因（不包含凭据）。
	Detail string
}

// Available 为真表示这条连接可以安全地写进 environments.toml。
func (result ProbeResult) Available() bool {
	return result.Reachable && result.CodexFound
}

// remoteProbeTimeout 覆盖整个探测（找出候选 + 逐个执行 --version）。
//
// 实测一次成功的 AWS 探测约 5.4s；探测要跑两条脚本、最多 4 个候选，
// 20s 在并发或慢链路上不够，会把可用连接误判为不可用。这里给足余量，
// 代价只是启动慢一点——但同步是异步旁路，不该为了快而误杀。
const remoteProbeTimeout = 60 * time.Second

// ProbeRunner 是执行远端探测的最小依赖；生产实现走 sshremote，测试可注入。
type ProbeRunner func(ctx context.Context, connection Connection, script string) (stdout string, stderr string, err error)

// ProbeConnection 探测一条连接是否可用作 Codex 执行环境。
//
// 分两步：先找出候选可执行文件，再逐个实际执行 `--version` 确认它真的能跑。
// 只看"路径存在"是不够的——实测有一台 Windows 的 PATH 里第一个 codex.exe 是
// 不兼容的旧构建，而下一个候选正常，只看路径会把这条连接误判为可用。
func ProbeConnection(ctx context.Context, runner ProbeRunner, connection Connection) ProbeResult {
	result := ProbeResult{ConnectionID: connection.ID, Label: connection.Label}
	if runner == nil {
		result.Detail = "未提供 SSH 探测实现"
		return result
	}
	probeCtx, cancel := context.WithTimeout(ctx, remoteProbeTimeout)
	defer cancel()
	reachable := false
	lastDetail := ""
	var candidates []string
	for _, script := range probeScripts() {
		stdout, stderr, err := runner(probeCtx, connection, script)
		if err != nil {
			if !reachable {
				lastDetail = firstNonEmpty(cleanSSHError(stderr), err.Error())
			}
			continue
		}
		reachable = true
		if list := nonEmptyLines(stdout); len(list) > 0 {
			candidates = list
			break
		}
	}
	if !reachable {
		result.Detail = firstNonEmpty(lastDetail, "SSH 连接失败")
		return result
	}
	result.Reachable = true
	if len(candidates) == 0 {
		result.Detail = "远端 shell 里找不到 codex（需要先在该主机安装 Codex CLI）"
		return result
	}
	if len(candidates) > maxProbeCandidates {
		candidates = candidates[:maxProbeCandidates]
	}
	// 逐个验证：真实执行 `--version`，第一个能跑通的就是可用路径。
	firstFailure := ""
	for _, candidate := range candidates {
		stdout, stderr, err := runner(probeCtx, connection, candidate+" --version")
		if err == nil && firstLine(stdout) != "" {
			result.CodexFound = true
			result.CodexPath = candidate
			return result
		}
		if firstFailure == "" {
			firstFailure = firstNonEmpty(cleanSSHError(stderr), errText(err))
		}
	}
	result.Detail = "远端找到 codex 但无法执行：" + firstNonEmpty(firstFailure, "所有候选都运行失败")
	return result
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// nonEmptyLines 取所有非空行，用于 `where` 返回多个候选的情况。
func nonEmptyLines(raw string) []string {
	out := []string{}
	for _, line := range strings.Split(TrimOutput(raw), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// firstLine 取首行：Windows 的 where 会返回多个候选，只留第一条。
func firstLine(raw string) string {
	for _, line := range strings.Split(TrimOutput(raw), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// cleanSSHError 只保留一行可读原因，避免把整段 ssh 日志塞给用户。
func cleanSSHError(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	for _, line := range strings.Split(trimmed, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return trimmed
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// SyncReport 是一次同步的结果汇总，供 UI/日志直接使用。
type SyncReport struct {
	Outcome  SyncOutcome
	Probes   []ProbeResult
	Rejected []Rejection
	// CacheHit 为真表示本次用的是落盘的探测结论，没有真的连 SSH。
	CacheHit bool
}

// Describe 产出不含凭据的一行摘要。
func (report SyncReport) Describe() string {
	total := len(report.Probes)
	available := 0
	for _, probe := range report.Probes {
		if probe.Available() {
			available++
		}
	}
	return fmt.Sprintf("已写入 %d 条环境（探测 %d 条，可用 %d 条，拒绝 %d 条）",
		report.Outcome.Entries, total, available, len(report.Rejected))
}

// coversConnections 判断缓存是否覆盖了当前全部候选连接。
// 只要有一条新连接不在缓存里，就重探，避免新加的连接被旧结论挡住。
func coversConnections(cached []ProbeResult, candidates []Connection) bool {
	byID := make(map[string]struct{}, len(cached))
	for _, probe := range cached {
		byID[probe.ConnectionID] = struct{}{}
	}
	for _, connection := range candidates {
		if _, ok := byID[connection.ID]; !ok {
			return false
		}
	}
	return true
}
