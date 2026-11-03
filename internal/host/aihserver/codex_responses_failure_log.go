package aihserver

import (
	"fmt"
	"log"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/codexresponseshttp"
)

// newCodexResponsesFailureLogger 把原生 /v1/responses 的失败摘要写进 ErrorLog（go-core.log 的 [stderr]）。
//
// Go 直接服务的请求在 Node 侧只有访问日志，这一行是区分「上游失败 / 换号耗尽 / 没有可用账号」的唯一线索。
func newCodexResponsesFailureLogger(logger *log.Logger) func(codexresponseshttp.FailureReport) {
	if logger == nil {
		return nil
	}
	return func(report codexresponseshttp.FailureReport) {
		logger.Print(formatCodexResponsesFailure(report))
	}
}

func formatCodexResponsesFailure(report codexresponseshttp.FailureReport) string {
	attempts := make([]string, 0, len(report.Attempts))
	for _, attempt := range report.Attempts {
		entry := fmt.Sprintf("%s:%s", attempt.AccountRef, attempt.Outcome)
		if attempt.Kind != "" {
			entry += " kind=" + attempt.Kind
		}
		if attempt.Code != "" {
			entry += " code=" + attempt.Code
		}
		if attempt.Detail != "" {
			entry += fmt.Sprintf(" detail=%q", attempt.Detail)
		}
		entry += fmt.Sprintf(" %dms", attempt.Elapsed.Milliseconds())
		attempts = append(attempts, entry)
	}
	return fmt.Sprintf(
		"Codex Responses failed: status=%d code=%s model=%s elapsed_ms=%d attempts=[%s]",
		report.Status,
		report.Code,
		report.Model,
		report.Elapsed.Milliseconds(),
		strings.Join(attempts, "; "),
	)
}
