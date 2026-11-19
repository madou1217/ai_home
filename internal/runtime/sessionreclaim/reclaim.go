package sessionreclaim

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ReclaimOptions 控制是否真的终止以及宽限期。
type ReclaimOptions struct {
	Options
	// Apply 为 false 时只返回"将会回收"的清单（dry-run）。
	Apply bool
	// Now 用于回执时间戳。
	Now func() time.Time
}

// ReclaimResult 是一次回收的结果。
type ReclaimResult struct {
	Applied   bool     `json:"applied"`
	Eligible  []string `json:"eligible"`
	Reclaimed []string `json:"reclaimed"`
	Skipped   []string `json:"skipped"`
}

// Reclaim 只处理四条证据全部满足的会话。
// 终止前会重新验证一次附着状态：判定用的是采样窗口，真正动手时会话可能已经有人接回。
func Reclaim(ctx context.Context, aiHomeDir string, opts ReclaimOptions) (ReclaimResult, error) {
	reports, err := Detect(ctx, aiHomeDir, opts.Options)
	if err != nil {
		return ReclaimResult{}, err
	}
	result := ReclaimResult{Applied: opts.Apply, Eligible: []string{}, Reclaimed: []string{}, Skipped: []string{}}
	for _, report := range reports {
		if !report.Eligible {
			continue
		}
		result.Eligible = append(result.Eligible, report.Session)
		if !opts.Apply {
			continue
		}
		// 二次确认：有人接回或开始活动就放弃。
		if attached := tmuxAttachedClients(ctx, report.Socket, report.Session); attached > 0 {
			result.Skipped = append(result.Skipped, report.Session)
			continue
		}
		if !tmuxSessionAlive(ctx, report.Socket, report.Session) {
			result.Skipped = append(result.Skipped, report.Session)
			continue
		}
		if _, err := runShort(ctx, "tmux", "-L", report.Socket, "kill-session", "-t", report.Session); err != nil {
			result.Skipped = append(result.Skipped, report.Session)
			continue
		}
		result.Reclaimed = append(result.Reclaimed, report.Session)
		appendReceipt(aiHomeDir, report)
	}
	return result, nil
}

// appendReceipt 记录一次回收，失败不影响主流程。
func appendReceipt(aiHomeDir string, report Report) {
	dir := filepath.Join(aiHomeDir, "run", "session-reclaim")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	record := map[string]any{
		"at":               time.Now().UTC().Format(time.RFC3339),
		"provider":         report.Provider,
		"session":          report.Session,
		"socket":           report.Socket,
		"cwd":              report.Cwd,
		"treeRssMb":        report.TreeRSSMB,
		"idleSeconds":      report.IdleSeconds,
		"cpuDeltaSeconds":  report.CPUDeltaSeconds,
		"establishedConns": report.EstablishedConns,
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return
	}
	file, err := os.OpenFile(filepath.Join(dir, "receipts.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(string(payload) + "\n")
}

// FormatResult 给 CLI/日志用的单行摘要。
func FormatResult(result ReclaimResult) string {
	return fmt.Sprintf("applied=%t eligible=%d reclaimed=%d skipped=%d",
		result.Applied, len(result.Eligible), len(result.Reclaimed), len(result.Skipped))
}
