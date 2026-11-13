package accountactivity

// 原生 Go 活动执行器（零 Node 依赖）。
//
// 实现 Executor 接口，直接分派三个 builtin handler：
//   - qoder-daily-checkin     → Qoder / Qoder CN 每日签到
//   - workbuddy-daily-checkin → WorkBuddy / CodeBuddy 每日签到
//   - zcode-plan-claim        → ZCode 活动套餐领取（仅 3007 兜底触发阿里云验证码）

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// NativeExecutorOptions 配置原生 Go 活动执行器及其可测注入点。
type NativeExecutorOptions struct {
	// AIHomeDir 是 AIH 数据根（含 aih.db、run/app-state.db、run/auth-projections）。
	AIHomeDir string
	// HostHomeDir 覆盖宿主 HOME（读 umid-cache.json / 安装应用版本等）。
	HostHomeDir string
	// Catalog 提供 Provider/Action 元数据；为空时回退 BuiltinCatalog()。
	Catalog *Catalog
	// EgressResolver 覆盖账号出口解析器；为空时按 AIHomeDir 构造。
	EgressResolver *agyegress.Resolver
	// HTTPClientForAccount 允许测试注入自定义 HTTPDoer，绕开网络与代理构建。
	HTTPClientForAccount func(ctx context.Context, provider, accountRef string) (HTTPDoer, error)
	// RecordLoader 允许测试注入自定义账号凭据读取逻辑。
	RecordLoader func(ctx context.Context, provider, accountRef string) (AccountRecord, bool, error)
	// CaptchaSolver 允许测试替换阿里云验证码求解实现。
	CaptchaSolver CaptchaSolverFunc
	// CaptchaBrowserPath 显式指定 Chrome/Chromium 路径。
	CaptchaBrowserPath string
	// CaptchaSolveGate 覆盖解算冷却闸门。
	CaptchaSolveGate *CaptchaSolveGate
	// QoderOptions / QoderDecrypt / QoderIdentityReader 覆盖 Qoder 设备与令牌解析。
	QoderOptions        qodercred.Options
	QoderDecrypt        func(provider string, native map[string]any) (qodercred.Identity, bool)
	QoderIdentityReader func(provider, accountRef string) *QoderDeviceIdentity
	// WorkbuddyCodecDecode 可选：$wbEncrypted 凭据解密扩展点。
	WorkbuddyCodecDecode func(raw map[string]any, provider string) (map[string]any, error)
	// ZcodeBaseURL / BaseURLs 允许测试指向本地 httptest.Server。
	ZcodeBaseURL          string
	BaseURLs              map[string]string
	ZcodeAppVersion       string
	DisableVersionRefresh bool
	// Timeout 覆盖单步上游 HTTP 超时。
	Timeout time.Duration
	Now     func() time.Time
	// OnClaimed 在单账号执行结束后回调（宿主可借此触发额度刷新）。
	OnClaimed func(ctx context.Context, provider, accountRef string, result map[string]any)
}

// NativeExecutor 是零 Node 依赖的 Go 原生活动执行器。
type NativeExecutor struct {
	options NativeExecutorOptions
	catalog *Catalog
}

// NewNativeExecutor 创建 Go 原生执行器。
func NewNativeExecutor(options NativeExecutorOptions) *NativeExecutor {
	catalog := options.Catalog
	if catalog == nil {
		catalog = BuiltinCatalog()
	}
	return &NativeExecutor{
		options: options,
		catalog: catalog,
	}
}

// Execute 执行单个账号的活动领取或只读探测动作。
func (e *NativeExecutor) Execute(ctx context.Context, request ExecutionRequest) (map[string]any, error) {
	if e == nil {
		return nil, ErrExecutorUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	accountRef := strings.TrimSpace(request.AccountRef)
	actionID := strings.ToLower(strings.TrimSpace(request.ActionID))

	action, foundAction := e.catalog.Find(provider, actionID)
	handler := strings.ToLower(strings.TrimSpace(action.Handler))
	resolvedActionID := action.ID
	if resolvedActionID == "" {
		resolvedActionID = actionID
	}
	if !foundAction {
		switch actionID {
		case "qoder_daily_checkin", "qoder-daily-checkin":
			handler = "qoder-daily-checkin"
		case "workbuddy_daily_checkin", "workbuddy-daily-checkin":
			handler = "workbuddy-daily-checkin"
		case "zcode_plan_claim", "zcode-plan-claim":
			handler = "zcode-plan-claim"
		default:
			return map[string]any{
				"provider":   provider,
				"accountRef": accountRef,
				"actionId":   resolvedActionID,
				"status":     StatusError,
				"error":      "activity_action_unknown:" + provider + ":" + actionID,
			}, nil
		}
	}

	var record AccountRecord
	var foundRecord bool
	var loadErr error
	if e.options.RecordLoader != nil {
		record, foundRecord, loadErr = e.options.RecordLoader(ctx, provider, accountRef)
	} else {
		record, foundRecord, loadErr = LoadAccountRecord(ctx, e.options.AIHomeDir, provider, accountRef)
	}
	if loadErr != nil {
		return nil, loadErr
	}
	if !foundRecord {
		return map[string]any{
			"provider":   provider,
			"accountRef": accountRef,
			"actionId":   resolvedActionID,
			"status":     StatusError,
			"error":      "account_not_found",
		}, nil
	}

	var result map[string]any
	switch handler {
	case "qoder-daily-checkin":
		result = e.runQoderDailyClaim(ctx, request, record)
	case "workbuddy-daily-checkin":
		result = e.runWorkbuddyDailyClaim(ctx, request, record)
	case "zcode-plan-claim":
		result = e.runZcodePlanClaim(ctx, request, record, action)
	default:
		result = map[string]any{
			"provider":   provider,
			"accountRef": accountRef,
			"status":     StatusError,
			"error":      "activity_action_unknown:" + provider + ":" + resolvedActionID,
		}
	}
	result["actionId"] = resolvedActionID
	if e.options.OnClaimed != nil {
		e.options.OnClaimed(ctx, provider, accountRef, result)
	}
	return result, nil
}

func (e *NativeExecutor) timeoutOr(fallback time.Duration) time.Duration {
	if e.options.Timeout > 0 {
		return e.options.Timeout
	}
	return fallback
}

func (e *NativeExecutor) nowMS() int64 {
	if e.options.Now != nil {
		return e.options.Now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

func (e *NativeExecutor) resolveProviderBaseURL(provider, fallback string) string {
	if len(e.options.BaseURLs) > 0 {
		if v := strings.TrimSpace(e.options.BaseURLs[provider]); v != "" {
			return v
		}
	}
	return fallback
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

var _ Executor = (*NativeExecutor)(nil)
