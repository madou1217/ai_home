package codexenvironments

import (
	"bytes"
	"context"
	"strings"
)

// SSHDialer 是探测需要的最小 SSH 能力：执行一条远端命令并返回输出。
//
// 生产实现由调用方用 sshremote 适配（沿用 AIH 自己的凭据与 known_hosts），
// 本包不拨号，也不持有任何凭据。
type SSHDialer interface {
	RunCommand(ctx context.Context, connection Connection, script string) (stdout, stderr string, err error)
}

// ProbeAll 并发探测全部连接，结果顺序与输入一致。
func ProbeAll(ctx context.Context, dialer SSHDialer, connections []Connection) []ProbeResult {
	results := make([]ProbeResult, len(connections))
	if dialer == nil {
		for i, connection := range connections {
			results[i] = ProbeResult{
				ConnectionID: connection.ID,
				Label:        connection.Label,
				Detail:       "未提供 SSH 拨号实现",
			}
		}
		return results
	}
	type indexed struct {
		index  int
		result ProbeResult
	}
	done := make(chan indexed, len(connections))
	for i, connection := range connections {
		go func(index int, conn Connection) {
			done <- indexed{index: index, result: ProbeConnection(ctx, dialer.RunCommand, conn)}
		}(i, connection)
	}
	for range connections {
		item := <-done
		results[item.index] = item.result
	}
	return results
}

// FilterAvailable 只保留探测可用的连接，其余按原因归入 rejected。
func FilterAvailable(connections []Connection, results []ProbeResult) ([]Connection, []Rejection) {
	byID := make(map[string]ProbeResult, len(results))
	for _, result := range results {
		byID[result.ConnectionID] = result
	}
	available := make([]Connection, 0, len(connections))
	rejected := make([]Rejection, 0)
	for _, connection := range connections {
		result, ok := byID[connection.ID]
		if !ok || result.Available() {
			available = append(available, connection)
			continue
		}
		code := CodeProbeUnreachable
		if result.Reachable && !result.CodexFound {
			code = CodeRemoteCodexMissing
		}
		rejected = append(rejected, Rejection{
			ConnectionID: connection.ID,
			Label:        firstNonEmpty(connection.Label, connection.ID),
			Code:         code,
			Message:      firstNonEmpty(result.Detail, "远端暂不可用"),
		})
	}
	return available, rejected
}

// 探测阶段的拒绝原因码。
const (
	CodeProbeUnreachable   = "codex_environment_unreachable"
	CodeRemoteCodexMissing = "codex_environment_remote_codex_missing"
)

// SSHRunner 把任意「执行 argv」的实现适配成 SSHDialer，便于接 sshremote。
type SSHRunner struct {
	// Exec 执行一次远端命令，返回 stdout/stderr。
	Exec func(ctx context.Context, connection Connection, script string) (stdout, stderr string, err error)
}

// RunCommand 实现 SSHDialer。
func (runner SSHRunner) RunCommand(ctx context.Context, connection Connection, script string) (string, string, error) {
	if runner.Exec == nil {
		return "", "", errNoExecutor
	}
	return runner.Exec(ctx, connection, script)
}

type runnerError string

func (e runnerError) Error() string { return string(e) }

const errNoExecutor runnerError = "未提供 SSH 执行实现"

// TrimOutput 归一远端输出：去掉尾部空白与 NUL，避免把终端噪声写进状态。
func TrimOutput(raw string) string {
	return strings.TrimSpace(string(bytes.TrimRight([]byte(raw), "\x00")))
}
