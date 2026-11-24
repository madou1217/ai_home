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

// remoteProbeTimeout 给慢链路留余量，但必须远小于一次用户可感知的等待。
const remoteProbeTimeout = 20 * time.Second

// ProbeRunner 是执行远端探测的最小依赖；生产实现走 sshremote，测试可注入。
type ProbeRunner func(ctx context.Context, connection Connection, script string) (stdout string, stderr string, err error)

// ProbeConnection 探测一条连接是否可用作 Codex 执行环境。
//
// 依次尝试 POSIX 与 Windows 两种探测写法：平台在建连前不可知，只看最终结果。
// 只要有一次成功退出且给出路径，就认为远端装好了 codex。
func ProbeConnection(ctx context.Context, runner ProbeRunner, connection Connection) ProbeResult {
	result := ProbeResult{ConnectionID: connection.ID, Label: connection.Label}
	if runner == nil {
		result.Detail = "未提供 SSH 探测实现"
		return result
	}
	probeCtx, cancel := context.WithTimeout(ctx, remoteProbeTimeout)
	defer cancel()
	lastDetail := ""
	reachable := false
	for _, script := range probeScripts() {
		stdout, stderr, err := runner(probeCtx, connection, script)
		if err != nil {
			if !reachable {
				lastDetail = firstNonEmpty(cleanSSHError(stderr), err.Error())
			}
			continue
		}
		reachable = true
		if path := firstLine(stdout); path != "" {
			result.Reachable = true
			result.CodexFound = true
			result.CodexPath = path
			return result
		}
	}
	// 走到这里说明连不上，或者连上了但两种写法都找不到 codex。
	if !reachable {
		result.Detail = firstNonEmpty(lastDetail, "SSH 连接失败")
		return result
	}
	result.Reachable = true
	result.Detail = "远端 shell 里找不到 codex（需要先在该主机安装 Codex CLI）"
	return result
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
