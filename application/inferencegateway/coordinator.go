package inferencegateway

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DefaultUpstreamAttemptLimit 限制单个路由候选最多调用的不同上游账号数。
	DefaultUpstreamAttemptLimit = 4
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

// AccountRecruiter 是 Coordinator 使用的请求级账号征召端口。
type AccountRecruiter interface {
	Begin(
		ctx context.Context,
		request accountrouting.Request,
		transport accountrouting.CredentialTransportPolicy,
	) (*accountrouting.RecruitmentSession, error)
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
	// CredentialObservations 在终态真正写运行态前复核凭据读取代次。
	CredentialObservations CredentialObservationVerifier
	// Clock 在上游终态出现时生成可比较的 UTC 毫秒发生时间。
	Clock func() time.Time
	// ModelRefreshes 只在账号明确不支持目标模型时异步修正目录。
	ModelRefreshes ModelRefreshScheduler
	// UpstreamAttemptLimit 是单个路由候选允许调用的不同上游账号数。
	UpstreamAttemptLimit int
	// PoolRetries 只允许在 AGY 整池无提示模糊失败且零输出时执行一次第二轮。
	PoolRetries *RequestPoolRetryPolicy
}

// Coordinator 组合路由、账号征召、上游执行和状态提交。
type Coordinator struct {
	catalog              *providers.Catalog
	routes               RouteResolver
	recruiter            AccountRecruiter
	upstreams            *UpstreamRegistry
	attempts             *ObservedAttemptRecorder
	modelRefreshes       ModelRefreshScheduler
	clock                func() time.Time
	upstreamAttemptLimit int
	poolRetries          *RequestPoolRetryPolicy
	routeCursor          atomic.Uint64
	routeSourceCursor    atomic.Uint64
}

// routeExecution 描述单个候选是否已经终止请求或留下可延迟提交的失败。
type routeExecution struct {
	terminal       bool
	pendingFailure *attemptStream
	poolExhausted  bool
	onlyDeferred   bool
}

// requestPoolRetryPermit 把账号池第二轮限制在一次外部 Execute 调用内。
// Coordinator 顺序执行 route，因此无需跨请求锁或进程级状态。
type requestPoolRetryPermit struct {
	used   bool
	parent context.Context
	ctx    context.Context
	cancel context.CancelFunc
}

func (permit *requestPoolRetryPermit) claim() bool {
	if permit == nil || permit.used {
		return false
	}
	permit.used = true
	return true
}

func (permit *requestPoolRetryPermit) routeContext(
	parent context.Context,
	policy *RequestPoolRetryPolicy,
	route Route,
) context.Context {
	if permit == nil || policy == nil || route.ProviderID() != inference.ProviderAgy {
		return parent
	}
	if permit.ctx == nil {
		permit.ctx, permit.cancel = policy.withBudget(parent)
	}
	return permit.ctx
}

func (permit *requestPoolRetryPermit) close() {
	if permit != nil && permit.cancel != nil {
		permit.cancel()
	}
}

// exhaustedInternalBudget 只识别 AGY 请求内第二轮自己的截止时间。
// 父请求已经取消或超时时必须保留原错误，不能误降级成下一条 route。
func (permit *requestPoolRetryPermit) exhaustedInternalBudget(err error) bool {
	return permit != nil &&
		errors.Is(err, context.DeadlineExceeded) &&
		permit.parent != nil &&
		permit.parent.Err() == nil
}

// 编译期确认 Coordinator 完整实现稳定 Executor 端口。
var _ Executor = (*Coordinator)(nil)

// NewCoordinator 创建不缓存凭据的 Canonical 执行器。
func NewCoordinator(
	dependencies Dependencies,
) (*Coordinator, error) {
	attemptLimit := dependencies.UpstreamAttemptLimit
	if attemptLimit == 0 {
		attemptLimit = DefaultUpstreamAttemptLimit
	}
	if dependencies.Catalog == nil ||
		dependencies.Routes == nil ||
		dependencies.Recruiter == nil ||
		dependencies.Upstreams == nil ||
		dependencies.Attempts == nil ||
		dependencies.CredentialObservations == nil ||
		dependencies.Clock == nil ||
		dependencies.ModelRefreshes == nil ||
		attemptLimit < 1 ||
		attemptLimit > DefaultUpstreamAttemptLimit {
		return nil, ErrInvalidCoordinatorDependencies
	}
	attempts, err := NewObservedAttemptRecorder(
		dependencies.Attempts,
		dependencies.CredentialObservations,
	)
	if err != nil {
		return nil, ErrInvalidCoordinatorDependencies
	}
	return &Coordinator{
		catalog:              dependencies.Catalog,
		routes:               dependencies.Routes,
		recruiter:            dependencies.Recruiter,
		upstreams:            dependencies.Upstreams,
		attempts:             attempts,
		modelRefreshes:       dependencies.ModelRefreshes,
		clock:                dependencies.Clock,
		upstreamAttemptLimit: attemptLimit,
		poolRetries:          dependencies.PoolRetries,
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
	if _, pinned := PinnedAccount(ctx); !pinned {
		plan = coordinator.orderRoutePlan(request.Model(), plan)
	}
	poolRetryPermit := coordinator.newRequestPoolRetryPermit(ctx)
	defer poolRetryPermit.close()
	var pendingFailure *attemptStream
	accountFailures := newRequestAccountFailureRecorder(
		coordinator.attempts,
	)
	supported := false
	for _, route := range plan.candidates[:plan.count] {
		if !route.Supports(request.RequiredCapabilities()) {
			continue
		}
		supported = true
		routeCtx := poolRetryPermit.routeContext(ctx, coordinator.poolRetries, route)
		execution, err := coordinator.executeCandidate(
			routeCtx,
			request,
			route,
			emit,
			accountFailures,
			poolRetryPermit,
		)
		if execution.pendingFailure != nil {
			pendingFailure = execution.pendingFailure
		}
		if err != nil {
			if finalizeErr := accountFailures.FinalizeFailure(ctx); finalizeErr != nil {
				return finishInterruptedPlan(
					pendingFailure,
					fmt.Errorf(
						"提交请求级上游失败状态失败: %w",
						finalizeErr,
					),
				)
			}
			return finishInterruptedPlan(pendingFailure, err)
		}
		if execution.terminal {
			return nil
		}
	}
	if !supported {
		return ErrUnsupportedRouteCapabilities
	}
	if err := accountFailures.FinalizeFailure(ctx); err != nil {
		return fmt.Errorf("提交请求级上游失败状态失败: %w", err)
	}
	return finishExhaustedPlan(pendingFailure)
}

// orderRoutePlan 在不改变 alias chain 内部优先级的前提下，公平选择 alias
// source 或请求模型的原生 source。同一真实模型的跨 Provider routes 继续独立
// 轮转；两个 cursor 都属于长生命周期 Coordinator，不随目录刷新重置。
func (coordinator *Coordinator) orderRoutePlan(
	requestedModel string,
	plan RoutePlan,
) RoutePlan {
	aliasRoutes, nativeRoutes := partitionRouteSources(plan, requestedModel)
	if len(aliasRoutes) > 0 && len(nativeRoutes) > 0 {
		if len(nativeRoutes) > 1 {
			start := (coordinator.routeCursor.Add(1) - 1) % uint64(len(nativeRoutes))
			nativeRoutes = rotateRoutes(nativeRoutes, int(start))
		}
		nativeFirst := (coordinator.routeSourceCursor.Add(1)-1)%2 == 1
		return joinRouteSources(aliasRoutes, nativeRoutes, nativeFirst)
	}
	if plan.hasEquivalentModelRoutes() {
		start := (coordinator.routeCursor.Add(1) - 1) % uint64(plan.count)
		return rotateRoutePlan(plan, int(start))
	}
	return plan
}

// partitionRouteSources 使用请求模型本身识别 native route；其余候选均属于
// 有序 alias fallback chain。分区稳定，因此 alias priority 不会被打乱。
func partitionRouteSources(
	plan RoutePlan,
	requestedModel string,
) ([]Route, []Route) {
	aliases := make([]Route, 0, plan.count)
	native := make([]Route, 0, plan.count)
	for _, route := range plan.candidates[:plan.count] {
		if route.EffectiveModel() == requestedModel {
			native = append(native, route)
			continue
		}
		aliases = append(aliases, route)
	}
	return aliases, native
}

func rotateRoutes(routes []Route, start int) []Route {
	if len(routes) <= 1 || start <= 0 || start >= len(routes) {
		return routes
	}
	rotated := make([]Route, len(routes))
	for index := range routes {
		rotated[index] = routes[(start+index)%len(routes)]
	}
	return rotated
}

func joinRouteSources(
	aliasRoutes []Route,
	nativeRoutes []Route,
	nativeFirst bool,
) RoutePlan {
	ordered := make([]Route, 0, len(aliasRoutes)+len(nativeRoutes))
	if nativeFirst {
		ordered = append(ordered, nativeRoutes...)
		ordered = append(ordered, aliasRoutes...)
	} else {
		ordered = append(ordered, aliasRoutes...)
		ordered = append(ordered, nativeRoutes...)
	}
	plan, _ := NewRoutePlan(ordered...)
	return plan
}

// hasEquivalentModelRoutes 只允许同一真实模型的跨 Provider route 参与公平轮转。
// 不同 effective model 表示显式 alias fallback 链，必须保留目录 priority。
func (plan RoutePlan) hasEquivalentModelRoutes() bool {
	if plan.count <= 1 {
		return false
	}
	model := plan.candidates[0].EffectiveModel()
	for index := 1; index < int(plan.count); index++ {
		if plan.candidates[index].EffectiveModel() != model {
			return false
		}
	}
	return true
}

// rotateRoutePlan 只改变本次请求的起点，保留完整候选集合和环形相对顺序。
// 原子 cursor 只保存公平票号，不保存 Provider 健康状态；账号层公平性仍由
// Recruiter 独立维护。
func rotateRoutePlan(plan RoutePlan, start int) RoutePlan {
	if plan.count <= 1 || start <= 0 || start >= int(plan.count) {
		return plan
	}
	var rotated RoutePlan
	rotated.count = plan.count
	for index := range int(plan.count) {
		rotated.candidates[index] = plan.candidates[(start+index)%int(plan.count)]
	}
	return rotated
}

// finishInterruptedPlan 在编排被内部故障中断时优先交付已经记录的真实上游失败。
//
// 内部故障只说明「不能再试下一个账号」，并不否定上游已经给出的裁决。把它写成
// 通用的服务不可用会抹掉真实状态码：客户端把限流当成网关故障，于是立即重试，
// 与退避语义正好相反。因此终态成功送达后按正常编排返回，只有无失败可交付或
// 交付本身失败时才上抛原始故障。
func finishInterruptedPlan(
	pendingFailure *attemptStream,
	cause error,
) error {
	if pendingFailure == nil {
		return cause
	}
	if err := pendingFailure.FlushTerminal(); err != nil {
		return cause
	}
	return nil
}

// executeCandidate 解析精确协议 Adapter 后执行一个路由候选。
func (coordinator *Coordinator) executeCandidate(
	ctx context.Context,
	request inference.Request,
	route Route,
	emit EventSink,
	accountFailures *requestAccountFailureRecorder,
	poolRetryPermit *requestPoolRetryPermit,
) (routeExecution, error) {
	upstream, err := coordinator.upstreams.Resolve(route.ProtocolID())
	if err != nil {
		return routeExecution{}, err
	}
	return coordinator.executeRoute(
		ctx,
		request,
		route,
		upstream,
		emit,
		accountFailures,
		poolRetryPermit,
	)
}

// executeRoute 在 AGY 模糊整池失败且零输出时最多执行一次有界第二轮。
func (coordinator *Coordinator) executeRoute(
	ctx context.Context,
	request inference.Request,
	route Route,
	upstream UpstreamAdapter,
	emit EventSink,
	accountFailures *requestAccountFailureRecorder,
	poolRetryPermit *requestPoolRetryPermit,
) (routeExecution, error) {
	first, err := coordinator.executeRouteRound(
		ctx,
		request,
		route,
		upstream,
		emit,
		accountFailures,
	)
	if err != nil || first.terminal ||
		!coordinator.claimPoolRetry(ctx, route, first, poolRetryPermit) {
		return first, err
	}
	if err := coordinator.poolRetries.wait(ctx); err != nil {
		if poolRetryPermit.exhaustedInternalBudget(err) {
			return first, nil
		}
		return first, err
	}
	return coordinator.executeRouteRound(
		ctx,
		request,
		route,
		upstream,
		emit,
		accountFailures,
	)
}

// executeRouteRound 在一个固定候选快照中扫描一次不同账号。
func (coordinator *Coordinator) executeRouteRound(
	ctx context.Context,
	request inference.Request,
	route Route,
	upstream UpstreamAdapter,
	emit EventSink,
	accountFailures *requestAccountFailureRecorder,
) (routeExecution, error) {
	var pendingFailure *attemptStream
	onlyDeferred := true
	attempted := 0
	session, err := coordinator.beginRecruitment(ctx, route, upstream)
	if err != nil {
		return routeExecution{}, err
	}
	for range coordinator.upstreamAttemptLimit {
		recruited, err := session.Next(ctx)
		if err != nil {
			if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
				return routeExecution{
					pendingFailure: pendingFailure,
					poolExhausted:  true,
					onlyDeferred:   attempted > 0 && onlyDeferred,
				}, nil
			}
			// 征召中断发生在任何写出之前，已记录的真实上游失败仍然可交付。
			return routeExecution{pendingFailure: pendingFailure}, err
		}
		invocation, err := newInvocation(
			request,
			route,
			recruited.Account(),
			recruited.Binding(),
			recruited.CredentialObservation(),
		)
		if err != nil {
			return routeExecution{pendingFailure: pendingFailure}, err
		}
		outcome, err := coordinator.executeAttempt(
			ctx,
			invocation,
			upstream,
			emit,
			accountFailures,
		)
		attempted++
		if err != nil {
			if outcome.Visible() {
				// 本次调用已经写出事件，补发更早的失败会破坏事件序列。
				return routeExecution{}, err
			}
			return routeExecution{pendingFailure: pendingFailure}, err
		}
		if !outcome.retry {
			return routeExecution{terminal: true}, nil
		}
		if !outcome.failure.DefersAccountFailureUntilRequestOutcome() {
			onlyDeferred = false
		}
		pendingFailure = outcome.stream
		if recruited.SourceExhausted() {
			return routeExecution{
				pendingFailure: pendingFailure,
				poolExhausted:  true,
				onlyDeferred:   onlyDeferred,
			}, nil
		}
	}
	return routeExecution{
		pendingFailure: pendingFailure,
		poolExhausted:  false,
		onlyDeferred:   attempted > 0 && onlyDeferred,
	}, nil
}

func (coordinator *Coordinator) newRequestPoolRetryPermit(
	ctx context.Context,
) *requestPoolRetryPermit {
	if coordinator.poolRetries == nil {
		return nil
	}
	if _, pinned := PinnedAccount(ctx); pinned {
		return nil
	}
	return &requestPoolRetryPermit{parent: ctx}
}

func (coordinator *Coordinator) claimPoolRetry(
	ctx context.Context,
	route Route,
	execution routeExecution,
	permit *requestPoolRetryPermit,
) bool {
	if coordinator.poolRetries == nil ||
		permit == nil ||
		route.ProviderID() != inference.ProviderAgy ||
		execution.pendingFailure == nil ||
		execution.pendingFailure.Visible() ||
		!execution.poolExhausted ||
		!execution.onlyDeferred {
		return false
	}
	_, pinned := PinnedAccount(ctx)
	return !pinned && permit.claim()
}

// beginRecruitment 创建真实模型征召请求并固定当前不可变候选快照。
func (coordinator *Coordinator) beginRecruitment(
	ctx context.Context,
	route Route,
	transport accountrouting.CredentialTransportPolicy,
) (*accountrouting.RecruitmentSession, error) {
	request, err := coordinator.newRecruitmentRequest(ctx, route)
	if err != nil {
		return nil, err
	}
	return coordinator.recruiter.Begin(ctx, request, transport)
}

// newRecruitmentRequest 把 HTTP/CLI Gateway 的请求级账号约束下沉到征召边界。
func (coordinator *Coordinator) newRecruitmentRequest(
	ctx context.Context,
	route Route,
) (accountrouting.Request, error) {
	accountRef, pinned := PinnedAccount(ctx)
	if pinned {
		return accountrouting.NewPinnedRequest(
			coordinator.catalog,
			string(route.ProviderID()),
			route.EffectiveModel(),
			accountRef,
		)
	}
	return accountrouting.NewRequest(
		coordinator.catalog,
		string(route.ProviderID()),
		route.EffectiveModel(),
	)
}

// executeAttempt 执行单账号调用并返回尚未对客户端可见的可重试失败。
func (coordinator *Coordinator) executeAttempt(
	ctx context.Context,
	invocation Invocation,
	upstream UpstreamAdapter,
	emit EventSink,
	accountFailures *requestAccountFailureRecorder,
) (attemptOutcome, error) {
	stream := newAttemptStream(emit, coordinator.clock)
	outcome := newAttemptOutcome(stream, false)
	result, executeErr := upstream.Execute(ctx, invocation, stream.Accept)
	if stream.Err() != nil {
		return outcome, stream.Err()
	}
	if executeErr != nil {
		return outcome, fmt.Errorf("执行上游推理失败: %w", executeErr)
	}
	if !result.IsValid() {
		return outcome, ErrInvalidAttemptResult
	}
	route, err := runtimecore.NewModelRoute(
		invocation.Account().Ref(),
		invocation.Route().EffectiveModel(),
	)
	if err != nil {
		return outcome, ErrInvalidInvocation
	}
	if result.Completed() {
		success, successErr := NewAttemptSuccess(stream.TerminalAt())
		if successErr != nil {
			return outcome, successErr
		}
		providerID := string(invocation.Route().ProviderID())
		accountFailures.ForgetPending(providerID, route)
		return outcome, coordinator.completeAttempt(
			ctx,
			providerID,
			route,
			invocation.CredentialObservation(),
			success,
			stream,
			accountFailures,
		)
	}
	retry, err := coordinator.failAttempt(
		ctx,
		route,
		string(invocation.Route().ProviderID()),
		invocation.CredentialObservation(),
		result.Failure(),
		stream,
		accountFailures,
	)
	if err != nil {
		return outcome, err
	}
	return newFailedAttemptOutcome(stream, retry, result.Failure()), nil
}

// completeAttempt 先清理当前元组状态，再提交成功终态。
func (coordinator *Coordinator) completeAttempt(
	ctx context.Context,
	providerID string,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	success AttemptSuccess,
	stream *attemptStream,
	accountFailures *requestAccountFailureRecorder,
) error {
	if !stream.Completed() {
		return ErrInvalidUpstreamEventStream
	}
	if err := accountFailures.FinalizeSuccess(ctx, providerID, route); err != nil {
		return fmt.Errorf("提交请求级上游失败状态失败: %w", err)
	}
	if _, err := coordinator.attempts.RecordSuccess(
		ctx,
		route,
		observation,
		success,
	); err != nil {
		return fmt.Errorf("记录上游成功状态失败: %w", err)
	}
	return stream.FlushTerminal()
}

// failAttempt 先记录失败，再决定换号或向客户端提交失败终态。
func (coordinator *Coordinator) failAttempt(
	ctx context.Context,
	route runtimecore.ModelRoute,
	providerID string,
	observation accountcredentials.CredentialObservation,
	failure AttemptFailure,
	stream *attemptStream,
	accountFailures *requestAccountFailureRecorder,
) (bool, error) {
	if stream.Completed() ||
		stream.FailedWithDifferent(failure.ResponseFailure()) {
		return false, ErrInvalidUpstreamEventStream
	}
	if err := stream.EnsureFailure(failure.ResponseFailure()); err != nil {
		return false, err
	}
	if err := accountFailures.Record(
		ctx,
		providerID,
		route,
		observation,
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
	if err := accountFailures.FinalizeFailure(ctx); err != nil {
		return false, fmt.Errorf("提交请求级上游失败状态失败: %w", err)
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
		coordinator.clock == nil ||
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
