package scheduledtasks

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
)

const (
	// CustomCommandEventID 是用户自定义 shell 命令的事件标识。
	CustomCommandEventID = "custom-command"
	// CustomCommandTimeout 是自定义命令单次运行的默认超时时长。
	CustomCommandTimeout = 10 * time.Minute
	// ActivityJobPollInterval 是计划任务等待统一活动队列任务结束的轮询间隔。
	ActivityJobPollInterval = 700 * time.Millisecond

	maxCommandOutputBytes = 4000
	maxCommandSummaryLen  = 400
)

// ParamOptionView 描述事件参数的枚举候选值。
type ParamOptionView struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// ParamFieldView 描述面向 UI 编辑器的事件参数声明。
type ParamFieldView struct {
	Key         string            `json:"key"`
	Label       string            `json:"label"`
	Type        string            `json:"type"`
	Description string            `json:"description"`
	Required    bool              `json:"required"`
	EmptyMeans  string            `json:"emptyMeans,omitempty"`
	MaxItems    int               `json:"maxItems,omitempty"`
	Options     []ParamOptionView `json:"options,omitempty"`
	OptionsFrom string            `json:"optionsFrom,omitempty"`
}

// EventDescriptor 描述一条可供调度的事件目录项。
type EventDescriptor struct {
	ID            string           `json:"id"`
	Kind          string           `json:"kind"`
	Provider      string           `json:"provider,omitempty"`
	ActionID      string           `json:"actionId,omitempty"`
	Label         string           `json:"label"`
	Description   string           `json:"description"`
	DebounceMS    int64            `json:"debounceMs"`
	Params        []ParamFieldView `json:"params,omitempty"`
	SupportsProbe bool             `json:"supportsProbe,omitempty"`
	Available     bool             `json:"available"`
}

// ParsedEventID 是解析后的事件标识符。
type ParsedEventID struct {
	ID       string
	Kind     string
	Provider string
	ActionID string
}

// EventResult 表示单次事件执行的结构化结果。
type EventResult struct {
	Status       string `json:"status"`
	Summary      string `json:"summary"`
	Error        string `json:"error"`
	ErrorSummary string `json:"errorSummary"`
	JobID        string `json:"jobId,omitempty"`
}

// CustomCommandRunner 允许测试注入自定义命令执行器。
type CustomCommandRunner func(ctx context.Context, command string, cwd string) EventResult

func providerDisplayLabel(provider string) string {
	trimmed := strings.TrimSpace(provider)
	if trimmed == "" {
		return "未知"
	}
	return strings.ToUpper(trimmed)
}

// ParseEventID 解析事件 ID；非法返回 nil。
func ParseEventID(eventID string) *ParsedEventID {
	raw := strings.TrimSpace(eventID)
	if raw == "" {
		return nil
	}
	if raw == CustomCommandEventID {
		return &ParsedEventID{ID: raw, Kind: "custom"}
	}
	parts := strings.Split(raw, ":")
	if parts[0] != "activity" || len(parts) < 3 {
		return nil
	}
	provider := strings.ToLower(strings.TrimSpace(parts[1]))
	actionID := strings.ToLower(strings.TrimSpace(strings.Join(parts[2:], ":")))
	if provider == "" || actionID == "" {
		return nil
	}
	return &ParsedEventID{
		ID:       raw,
		Kind:     "activity",
		Provider: provider,
		ActionID: actionID,
	}
}

// ListScheduledEvents 基于活动目录声明动态生成可调度事件清单。
func ListScheduledEvents(catalog *accountactivity.Catalog) []EventDescriptor {
	events := make([]EventDescriptor, 0, 8)
	if catalog != nil {
		for _, provider := range catalog.Providers() {
			pLabel := providerDisplayLabel(provider)
			for _, action := range catalog.Actions(provider) {
				if !action.Schedulable {
					continue
				}
				debounce := action.ScheduleDebounce
				if debounce <= 0 {
					debounce = accountactivity.DefaultDebounce
				}
				desc := strings.TrimSpace(action.Description)
				if desc == "" {
					desc = fmt.Sprintf("对 %s 的全部账号执行「%s」", pLabel, action.Label)
				}
				params := buildParamViews(action.Params)
				events = append(events, EventDescriptor{
					ID:            "activity:" + provider + ":" + action.ID,
					Kind:          "activity",
					Provider:      provider,
					ActionID:      action.ID,
					Label:         pLabel + " · " + action.Label,
					Description:   desc,
					DebounceMS:    debounce.Milliseconds(),
					Params:        params,
					SupportsProbe: action.SupportsProbe,
					Available:     true,
				})
			}
		}
	}
	events = append(events, EventDescriptor{
		ID:          CustomCommandEventID,
		Kind:        "custom",
		Label:       "自定义命令",
		Description: "以服务进程身份执行一条 shell 命令（参数里给出 command）",
		DebounceMS:  0,
		Available:   true,
	})
	return events
}

func buildParamViews(fields []accountactivity.ParamField) []ParamFieldView {
	views := make([]ParamFieldView, 0, len(fields))
	for _, field := range fields {
		emptyMeans := strings.TrimSpace(field.EmptyMeans)
		if emptyMeans == "" {
			if field.Type == "account-refs" {
				emptyMeans = "all"
			} else {
				emptyMeans = "any"
			}
		}
		var options []ParamOptionView
		if len(field.Options) > 0 {
			options = make([]ParamOptionView, 0, len(field.Options))
			for _, opt := range field.Options {
				options = append(options, ParamOptionView{
					Value:       opt.Value,
					Label:       opt.Label,
					Description: opt.Description,
				})
			}
		}
		views = append(views, ParamFieldView{
			Key:         field.Key,
			Label:       field.Label,
			Type:        field.Type,
			Description: field.Description,
			Required:    field.Required,
			EmptyMeans:  emptyMeans,
			MaxItems:    field.MaxItems,
			Options:     options,
			OptionsFrom: field.OptionsFrom,
		})
	}
	return views
}

// DescribeEventAvailability 检查事件在当前目录中是否可执行。
func DescribeEventAvailability(catalog *accountactivity.Catalog, eventID string) (bool, string) {
	parsed := ParseEventID(eventID)
	if parsed == nil {
		return false, "event_unknown"
	}
	if parsed.Kind == "custom" {
		return true, ""
	}
	if catalog == nil {
		return false, "event_action_not_declared"
	}
	if _, ok := catalog.Find(parsed.Provider, parsed.ActionID); !ok {
		return false, "event_action_not_declared"
	}
	return true, ""
}

// DebounceForEvent 返回事件的防抖时间窗口。
func DebounceForEvent(catalog *accountactivity.Catalog, eventID string) time.Duration {
	parsed := ParseEventID(eventID)
	if parsed == nil {
		return accountactivity.DefaultDebounce
	}
	if parsed.Kind == "custom" {
		return 0
	}
	if catalog != nil {
		if action, ok := catalog.Find(parsed.Provider, parsed.ActionID); ok && action.ScheduleDebounce > 0 {
			return action.ScheduleDebounce
		}
	}
	return accountactivity.DefaultDebounce
}

// FormatActivitySummary 生成与 Node formatActivitySummary 对齐的人话摘要。
func FormatActivitySummary(summary accountactivity.Summary) string {
	var parts []string
	if summary.AlreadyClaimed > 0 {
		parts = append(parts, fmt.Sprintf("已领取过 %d", summary.AlreadyClaimed))
	}
	if summary.NothingClaimable > 0 {
		parts = append(parts, fmt.Sprintf("暂无可领 %d", summary.NothingClaimable))
	}
	if summary.NotApplicable > 0 {
		parts = append(parts, fmt.Sprintf("不适用 %d", summary.NotApplicable))
	}
	if summary.Skipped > 0 {
		parts = append(parts, fmt.Sprintf("跳过 %d", summary.Skipped))
	}
	if summary.Failed > 0 {
		codes := accountactivity.FormatFailureCodes(summary.Failures)
		if codes != "" {
			parts = append(parts, fmt.Sprintf("失败 %d：%s", summary.Failed, codes))
		} else {
			parts = append(parts, fmt.Sprintf("失败 %d", summary.Failed))
		}
	}
	head := fmt.Sprintf("领取 %d/%d 成功", summary.Succeeded, summary.Accounts)
	if len(parts) > 0 {
		return head + "（" + strings.Join(parts, "、") + "）"
	}
	return head
}

type tailBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (tb *tailBuffer) Write(p []byte) (int, error) {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	tb.buf.Write(p)
	if tb.buf.Len() > tb.max {
		excess := tb.buf.Len() - tb.max
		_ = tb.buf.Next(excess)
	}
	return len(p), nil
}

func (tb *tailBuffer) String() string {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	return tb.buf.String()
}

// RunCustomCommand 执行一次性 shell 命令并截取结尾摘要。
func RunCustomCommand(ctx context.Context, command string, cwd string) EventResult {
	cmdText := strings.TrimSpace(command)
	if cmdText == "" {
		return EventResult{Status: "error", Error: "custom_command_missing"}
	}
	workDir := strings.TrimSpace(cwd)
	if workDir == "" {
		if wd, err := os.Getwd(); err == nil {
			workDir = wd
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, CustomCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, "/bin/sh", "-c", cmdText)
	if workDir != "" {
		cmd.Dir = workDir
	}
	stdout := &tailBuffer{max: maxCommandOutputBytes}
	stderr := &tailBuffer{max: maxCommandOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()
	output := strings.TrimSpace(stdout.String())
	if output == "" {
		output = strings.TrimSpace(stderr.String())
	}
	summary := summarizeCommandOutput(output)

	if err == nil {
		return EventResult{
			Status:  "ok",
			Summary: summary,
		}
	}
	exitCode := 1
	if exitErr, ok := err.(*exec.ExitError); ok {
		exitCode = exitErr.ExitCode()
	} else if runCtx.Err() != nil {
		return EventResult{
			Status:  "error",
			Error:   "custom_command_failed:" + runCtx.Err().Error(),
			Summary: summary,
		}
	}
	return EventResult{
		Status:  "error",
		Error:   "custom_command_exit_" + strconv.Itoa(exitCode),
		Summary: summary,
	}
}

func summarizeCommandOutput(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lines := strings.Split(trimmed, "\n")
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	joined := strings.Join(lines, " | ")
	runes := []rune(joined)
	if len(runes) > maxCommandSummaryLen {
		return string(runes[:maxCommandSummaryLen])
	}
	return joined
}
