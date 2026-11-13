// Package housekeeping 承担服务启动阶段的一次性运维清理：
// 清理已注销账号残留的运行时投影，以及已注销或停用账号残留的 codex app-server 状态与进程。
package housekeeping

import (
	"context"
	"errors"
	"regexp"
	"strings"
)

// ErrInvalidOptions 表示清理任务缺少必需的目录或依赖端口。
var ErrInvalidOptions = errors.New("housekeeping 参数或依赖无效")

var accountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)
var alphaNumPattern = regexp.MustCompile(`[^A-Za-z0-9]`)

// PruneSummary 描述一次清理扫描的结果计数，字段命名与原 Node 返回契约一致。
type PruneSummary struct {
	Removed int `json:"removed"`
	Kept    int `json:"kept"`
	Failed  int `json:"failed"`
}

// RegisteredAccount 描述数据库中登记的一条权威账号状态。
type RegisteredAccount struct {
	Provider   string
	AccountRef string
	Status     string
	Enabled    bool
}

// RegisteredAccountsReader 是读取规范账号登记表的只读端口。
// 实现方必须在数据库缺失或损坏时返回错误（fail-closed），绝不能伪装成空集合。
type RegisteredAccountsReader interface {
	ListRegisteredAccounts(ctx context.Context) ([]RegisteredAccount, error)
}

// ResourceReconciler 在删除陈旧投影前对账尚未落回宿主的会话或工作区资源。
// rootKind 为 "auth-projections" 或 "codex-desktop"。
type ResourceReconciler interface {
	Reconcile(ctx context.Context, provider string, accountRef string, rootKind string, projectionPath string) error
}

// CodexAppServerTarget 描述从 run/codex-app-server/<scope>.json 解析出的目标实例。
type CodexAppServerTarget struct {
	RuntimeScope     string
	RuntimeNamespace string
	AccountRef       string
	StatePath        string
	Port             int
	Socket           string
	Multiplexer      string
}

// EndpointInvalidator 负责停止不再保留的 codex app-server 并删除其 state JSON。
type EndpointInvalidator interface {
	Invalidate(ctx context.Context, target CodexAppServerTarget) error
}

// CommandRunner 抽象外部进程探测与终止调用，方便生产实现与单测隔离。
type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) (stdout string, stderr string, exitCode int, err error)
}

// IsValidAccountRef 判断字符串是否为标准账号引用（acct_ + 20 位小写十六进制）。
func IsValidAccountRef(value string) bool {
	return accountRefPattern.MatchString(strings.TrimSpace(value))
}

// AppServerSocketName 按 Node codex-app-server-endpoint 同公式推导多路复用 socket 名。
func AppServerSocketName(runtimeScope string) string {
	scope := strings.TrimSpace(runtimeScope)
	if strings.HasPrefix(scope, "chat-") {
		scoped := alphaNumPattern.ReplaceAllString(strings.TrimPrefix(scope, "chat-"), "")
		return "aih-codexchat-" + scoped
	}
	compact := alphaNumPattern.ReplaceAllString(scope, "")
	if len(compact) > 24 {
		compact = compact[:24]
	}
	if compact == "" {
		compact = "unknown"
	}
	return "aih-codexapp-" + compact
}
