package inferencegateway

import (
	"context"
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/application/accountrouting"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DefaultAccountScanLimit 限制单请求最多检查的账号数量。
	DefaultAccountScanLimit = 32
)

var (
	// ErrInvalidCoordinatorDependencies 表示执行器缺少一个必要端口。
	ErrInvalidCoordinatorDependencies = errors.New("Canonical 执行器依赖无效")
	// ErrInvalidExecuteRequest 表示上下文、请求或输出端口无效。
	ErrInvalidExecuteRequest = errors.New("Canonical 执行请求无效")
	// ErrNoRoutableAccount 表示有界扫描内没有可调用账号。
	ErrNoRoutableAccount = errors.New("没有可执行 Canonical 请求的账号")
	// ErrInvalidUpstreamEventStream 表示 Adapter 事件序号或终态违反合同。
	ErrInvalidUpstreamEventStream = errors.New("上游 Canonical 事件流无效")
)

// AccountRecruiter 是 Coordinator 使用的有界账号征召端口。
type AccountRecruiter interface {
	Recruit(
		ctx context.Context,
		request accountrouting.Request,
	) (accountrouting.Result, error)
}

// ModelRefreshScheduler 接收精确账号和 Provider 的异步模型刷新信号。
//
// 实现只能完成有界入队，不能在当前推理请求内访问凭据或远端目录。
type ModelRefreshScheduler interface {
	ScheduleModelRefresh(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
}

// Dependencies 声明 Canonical Coordinator 的最小组合边界。
type Dependencies struct {
	// Catalog 只用于构造经过校验的账号征召请求。
	Catalog *providers.Catalog
	// Routes 负责模型别名、Provider、协议和能力选择。
	Routes RouteResolver
	// Recruiter 负责运行态资格和凭据可用化。
	Recruiter AccountRecruiter
	// Upstreams 按真实上游协议选择 Adapter。
	Upstreams *UpstreamRegistry
	// Attempts 在终态对客户端可见前记录成功或失败。
	Attempts AttemptRecorder
	// ModelRefreshes 只在账号明确不支持目标模型时异步修正目录。
	ModelRefreshes ModelRefreshScheduler
	// AccountScanLimit 是单请求允许检查的账号上限。
	AccountScanLimit int
}

// Coordinator 组合路由、账号征召、上游执行和状态提交。
type Coordinator struct {
	catalog          *providers.Catalog
	routes           RouteResolver
	recruiter        AccountRecruiter
	upstreams        *UpstreamRegistry
	attempts         AttemptRecorder
	modelRefreshes   ModelRefreshScheduler
	accountScanLimit int
}

// routeExecution 描述单个候选是否已经终止请求或留下可延迟提交的失败。
type routeExecution struct {
	terminal       bool
	pendingFailure *attemptStream
}

// 编译期确认 Coordinator 完整实现稳定 Executor 端口。
var _ Executor = (*Coordinator)(nil)

// NewCoordinator 创建不缓存账号或凭据的 Canonical 执行器。
func NewCoordinator(
	dependencies Dependencies,
) (*Coordinator, error) {
	scanLimit := dependencies.AccountScanLimit
	if scanLimit == 0 {
		scanLimit = DefaultAccountScanLimit
	}
	if dependencies.Catalog == nil ||
		dependencies.Routes == nil ||
		dependencies.Recruiter == nil ||
		dependencies.Upstreams == nil ||
		dependencies.Attempts == nil ||
		dependencies.ModelRefreshes == nil ||
		scanLimit < 1 ||
		scanLimit > DefaultAccountScanLimit {
		return nil, ErrInvalidCoordinatorDependencies
	}
	return &Coordinator{
		catalog:          dependencies.Catalog,
		routes:           dependencies.Routes,
		recruiter:        dependencies.Recruiter,
		upstreams:        dependencies.Upstreams,
		attempts:         dependencies.Attempts,
		modelRefreshes:   dependencies.ModelRefreshes,
		accountScanLimit: scanLimit,
	}, nil
}

// Execute 依次执行有界路由计划中的 Canonical Request。
func (coordinator *Coordinator) Execute(
	ctx context.Context,
	request inference.Request,
	emit EventSink,
) error {
	if err := coordinator.validateExecute(ctx, request, emit); err != nil {
		return err
	}
	plan, err := coordinator.routes.Resolve(ctx, request)
	if err != nil {
		return fmt.Errorf("解析 Canonical 推理路由失败: %w", err)
	}
	if !plan.IsValid() {
		return ErrInvalidRoutePlan
	}
	return coordinator.executePlan(ctx, request, plan, emit)
}

// executePlan 顺序尝试支持请求能力的候选，并保留最后一个安全失败。
func (coordinator *Coordinator) executePlan(
	ctx context.Context,
	request inference.Request,
	plan RoutePlan,
	emit EventSink,
) error {
	var pendingFailure *attemptStream
	supported := false
	for _, route := range plan.candidates[:plan.count] {
		if !route.Supports(request.RequiredCapabilities()) {
			continue
		}
		supported = true
		execution, err := coordinator.executeCandidate(
			ctx,
			request,
			route,
			emit,
		)
		if err != nil || execution.terminal {
			return err
		}
		if execution.pendingFailure != nil {
			pendingFailure = execution.pendingFailure
		}
	}
	if !supported {
		return ErrUnsupportedRouteCapabilities
	}
	return finishExhaustedPlan(pendingFailure)
}

// executeCandidate 解析精确协议 Adapter 后执行一个路由候选。
func (coordinator *Coordinator) executeCandidate(
	ctx context.Context,
	request inference.Request,
	route Route,
	emit EventSink,
) (routeExecution, error) {
	upstream, err := coordinator.upstreams.Resolve(route.ProtocolID())
	if err != nil {
		return routeExecution{}, err
	}
	return coordinator.executeRoute(ctx, request, route, upstream, emit)
}

// executeRoute 按稳定 AccountRef 游标尝试不同账号。
func (coordinator *Coordinator) executeRoute(
	ctx context.Context,
	request inference.Request,
	route Route,
	upstream UpstreamAdapter,
	emit EventSink,
) (routeExecution, error) {
	var afterRef accountcore.AccountRef
	var pendingFailure *attemptStream
	remaining := coordinator.accountScanLimit
	for remaining > 0 {
		recruited, err := coordinator.recruit(
			ctx,
			route,
			afterRef,
			remaining,
		)
		remaining -= recruited.Examined()
		if err != nil {
			if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
				return routeExecution{
					pendingFailure: pendingFailure,
				}, nil
			}
			return routeExecution{}, err
		}
		invocation, err := newInvocation(
			request,
			route,
			recruited.Account(),
			recruited.Credential(),
		)
		if err != nil {
			return routeExecution{}, err
		}
		pendingFailure, err = coordinator.executeAttempt(
			ctx,
			invocation,
			upstream,
			emit,
		)
		if err != nil {
			return routeExecution{}, err
		}
		if pendingFailure == nil {
			return routeExecution{terminal: true}, nil
		}
		if remaining <= 0 || recruited.SourceExhausted() {
			return routeExecution{
				pendingFailure: pendingFailure,
			}, nil
		}
		afterRef = recruited.Account().Ref()
	}
	return routeExecution{pendingFailure: pendingFailure}, nil
}

// recruit 使用剩余扫描预算创建真实模型账号征召请求。
func (coordinator *Coordinator) recruit(
	ctx context.Context,
	route Route,
	afterRef accountcore.AccountRef,
	limit int,
) (accountrouting.Result, error) {
	request, err := accountrouting.NewRequest(
		coordinator.catalog,
		string(route.ProviderID()),
		route.EffectiveModel(),
		afterRef,
		limit,
	)
	if err != nil {
		return accountrouting.Result{}, err
	}
	result, err := coordinator.recruiter.Recruit(ctx, request)
	if result.Examined() < 0 || result.Examined() > limit {
		return result, accountrouting.ErrInvalidCandidatePage
	}
	if err == nil && result.Examined() == 0 {
		return result, accountrouting.ErrInvalidCandidatePage
	}
	return result, err
}

// executeAttempt 执行单账号调用并返回尚未对客户端可见的可重试失败。
func (coordinator *Coordinator) executeAttempt(
	ctx context.Context,
	invocation Invocation,
	upstream UpstreamAdapter,
	emit EventSink,
) (*attemptStream, error) {
	stream := newAttemptStream(emit)
	result, executeErr := upstream.Execute(ctx, invocation, stream.Accept)
	if stream.Err() != nil {
		return nil, stream.Err()
	}
	if executeErr != nil {
		return nil, fmt.Errorf("执行上游推理失败: %w", executeErr)
	}
	if !result.IsValid() {
		return nil, ErrInvalidAttemptResult
	}
	route, err := runtimecore.NewModelRoute(
		invocation.Account().Ref(),
		invocation.Route().EffectiveModel(),
	)
	if err != nil {
		return nil, ErrInvalidInvocation
	}
	if result.Completed() {
		return nil, coordinator.completeAttempt(ctx, route, stream)
	}
	retry, err := coordinator.failAttempt(
		ctx,
		route,
		string(invocation.Route().ProviderID()),
		result.Failure(),
		stream,
	)
	if err != nil || !retry {
		return nil, err
	}
	return stream, nil
}

// completeAttempt 先清理当前元组状态，再提交成功终态。
func (coordinator *Coordinator) completeAttempt(
	ctx context.Context,
	route runtimecore.ModelRoute,
	stream *attemptStream,
) error {
	if !stream.Completed() {
		return ErrInvalidUpstreamEventStream
	}
	if err := coordinator.attempts.RecordSuccess(ctx, route); err != nil {
		return fmt.Errorf("记录上游成功状态失败: %w", err)
	}
	return stream.FlushTerminal()
}

// failAttempt 先记录失败，再决定换号或向客户端提交失败终态。
func (coordinator *Coordinator) failAttempt(
	ctx context.Context,
	route runtimecore.ModelRoute,
	providerID string,
	failure AttemptFailure,
	stream *attemptStream,
) (bool, error) {
	if stream.Completed() ||
		stream.FailedWithDifferent(failure.ResponseFailure()) {
		return false, ErrInvalidUpstreamEventStream
	}
	if err := stream.EnsureFailure(failure.ResponseFailure()); err != nil {
		return false, err
	}
	if err := coordinator.attempts.RecordFailure(
		ctx,
		route,
		failure,
	); err != nil {
		return false, fmt.Errorf("记录上游失败状态失败: %w", err)
	}
	if failure.RuntimeKind() == runtimecore.FailureModelUnsupported {
		// 刷新是修复后续路由快照的旁路任务；队列关闭或拒绝入队不能覆盖
		// 已经记录的真实上游终态，也不能阻止当前请求按原策略换号。
		_ = coordinator.modelRefreshes.ScheduleModelRefresh(
			ctx,
			route.AccountRef(),
			providerID,
		)
	}
	if !stream.Visible() && failure.retriesAnotherAccount() {
		return true, nil
	}
	return false, stream.FlushTerminal()
}

// validateExecute 在调用任何外部端口前拒绝零值。
func (coordinator *Coordinator) validateExecute(
	ctx context.Context,
	request inference.Request,
	emit EventSink,
) error {
	if coordinator == nil ||
		coordinator.catalog == nil ||
		coordinator.routes == nil ||
		coordinator.recruiter == nil ||
		coordinator.upstreams == nil ||
		coordinator.attempts == nil ||
		coordinator.modelRefreshes == nil ||
		ctx == nil ||
		emit == nil ||
		!request.ClientProtocol().IsValid() ||
		request.Model() == "" ||
		!request.RequiredCapabilities().IsValid() {
		return ErrInvalidExecuteRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

// finishExhaustedPlan 提交最后一个已记录的安全失败，或返回无账号错误。
func finishExhaustedPlan(pendingFailure *attemptStream) error {
	if pendingFailure == nil {
		return ErrNoRoutableAccount
	}
	return pendingFailure.FlushTerminal()
}
