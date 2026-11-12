package accountactivity

// 活动服务：把「选择 → 目标 → 守卫生效 → 后台任务 / 探测 / 参数」串起来。
//
// 这是五条 WebUI 路由的唯一业务实现，行为对齐 lib/server/webui-account-activity-routes.js：
// 错误码、HTTP 状态、任务形状、summary/failures 都按同一份契约产出。差别只有两处，
// 且都是为了「never self-inflict 429」：
//   1. 上游调用经 ExecutionGate 串行 + 最小间隔（Node 只串行队列，没有速率闸门）；
//   2. 目标数量有硬上限（MaxTargetsPerJob），避免一次点击把队列撑成无界工作。

import (
	"context"
	"errors"
	"strings"
	"time"
)

// MaxTargetsPerJob 是一次批量领取的账号上限。
const MaxTargetsPerJob = 500

// ProbeMaxAccounts / ProbeBudget 与 Node 的探测上限一致。
const (
	ProbeMaxAccounts = 20
	ProbeBudget      = 120 * time.Second
)

// JobExecutionTimeout 是单账号领取的执行超时（含无痕验证码）。
const JobExecutionTimeout = 180 * time.Second

// ProbeCallTimeout 是探测时单账号的执行超时。
const ProbeCallTimeout = 60 * time.Second

// Selection 是批量选择；缺字段 / 空数组一律非法，绝不解释成「全部 Provider」。
type Selection struct {
	Providers []string
	ActionID  string
	Params    map[string]any
}

// Outcome 是服务层的 HTTP 结论。
type Outcome struct {
	Status  int
	Payload map[string]any
}

// ServiceDependencies 汇总活动服务依赖。
type ServiceDependencies struct {
	Catalog  *Catalog
	Accounts AccountLister
	Executor Executor
	Guard    *Guard
	Jobs     *JobManager
	Now      func() time.Time
}

// Service 是活动用例的实现。
type Service struct {
	catalog  *Catalog
	accounts AccountLister
	executor Executor
	guard    *Guard
	jobs     *JobManager
	gate     *ExecutionGate
	now      func() time.Time
}

// NewService 创建服务。
func NewService(dependencies ServiceDependencies) (*Service, error) {
	if dependencies.Catalog == nil || dependencies.Accounts == nil || dependencies.Jobs == nil {
		return nil, errors.New("活动服务依赖无效")
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	guard := dependencies.Guard
	if guard == nil {
		guard = NewGuard(now)
	}
	return &Service{
		catalog:  dependencies.Catalog,
		accounts: dependencies.Accounts,
		executor: dependencies.Executor,
		guard:    guard,
		jobs:     dependencies.Jobs,
		gate:     NewExecutionGate(now),
		now:      now,
	}, nil
}

// Guard 暴露运行守卫（单账号路由与探测互斥都要用）。
func (service *Service) Guard() *Guard {
	return service.guard
}

// Jobs 暴露任务队列。
func (service *Service) Jobs() *JobManager {
	return service.jobs
}

// Run 开始一个批量领取任务。
func (service *Service) Run(ctx context.Context, selection Selection) Outcome {
	providers := normalizeProviders(selection.Providers)
	actionID := strings.ToLower(strings.TrimSpace(selection.ActionID))
	if len(providers) == 0 || actionID == "" {
		return failure(400, "invalid_activity_selection")
	}

	actionLabel := ""
	var primary Action
	for _, provider := range providers {
		action, ok := service.catalog.Find(provider, actionID)
		if !ok {
			// 请求里混入了不支持该动作的 Provider 时整体拒绝，不做「跳过一部分」。
			return failure(400, "activity_action_unknown:"+provider+":"+actionID)
		}
		if actionLabel == "" {
			actionLabel = action.Label
			primary = action
		}
	}

	params, paramError := NormalizeParams(primary, selection.Params)
	if paramError != "" {
		return failure(400, "activity_params_invalid:"+paramError)
	}

	targets := make([]Target, 0, 16)
	for _, provider := range providers {
		refs, err := service.accounts.ListByProvider(ctx, provider)
		if err != nil {
			return failure(503, "account_list_failed:"+errorText(err))
		}
		action, _ := service.catalog.Find(provider, actionID)
		resolved, unknown := ResolveTargets(action, params, refs)
		for _, accountRef := range resolved {
			targets = append(targets, Target{Provider: provider, AccountRef: accountRef})
		}
		// 被选中的账号已不存在：写成失败结果（fail-loud），而不是静默少跑一个。
		for _, accountRef := range unknown {
			targets = append(targets, Target{Provider: provider, AccountRef: accountRef, Missing: true})
		}
	}
	if len(targets) == 0 {
		return failure(400, "activity_no_accounts")
	}
	if len(targets) > MaxTargetsPerJob {
		return failure(400, "activity_selection_too_large")
	}

	// 探测与领取互斥（双向）：只读探测也在打上游，边探边领就是自造 429。
	for _, provider := range providers {
		if service.guard.IsProbeRunning(provider, actionID) {
			return Outcome{Status: 409, Payload: map[string]any{
				"ok": false, "error": "activity_probe_running", "reason": string(DeniedInFlight),
			}}
		}
	}

	guardKey := ClaimKey(providers[0], actionID)
	if len(providers) > 1 {
		parts := make([]string, 0, len(providers))
		for _, provider := range providers {
			parts = append(parts, ClaimKey(provider, actionID))
		}
		guardKey = strings.Join(parts, "+")
	}
	guardKey = RunKey(guardKey, params)
	debounce := time.Duration(0)
	for _, provider := range providers {
		action, _ := service.catalog.Find(provider, actionID)
		candidate := action.ScheduleDebounce
		if candidate <= 0 {
			candidate = DefaultDebounce
		}
		if candidate > debounce {
			debounce = candidate
		}
	}
	release, denied := service.guard.Acquire(guardKey, debounce)
	if denied != nil {
		return guardFailure(denied)
	}

	started, startError := service.jobs.Start(StartRequest{
		Providers:   providers,
		ActionID:    actionID,
		ActionLabel: actionLabel,
		Params:      params,
		Targets:     targets,
		Execute: func(jobContext context.Context, target Target) map[string]any {
			callContext, cancel := context.WithTimeout(jobContext, JobExecutionTimeout)
			defer cancel()
			return service.execute(callContext, target, actionID, params, false)
		},
		OnSettled: func(*Job) { release() },
	})
	if startError != "" {
		release()
		return failure(400, startError)
	}
	if started.AlreadyRunning {
		// 任务已由前一次请求启动：本次没有再持有运行权，立刻释放，避免键泄漏。
		release()
	}
	return Outcome{Status: 202, Payload: map[string]any{
		"ok":             true,
		"alreadyRunning": started.AlreadyRunning,
		"job":            started.Job,
	}}
}

// Probe 只读探测：先看清「有什么可领、是什么类型」，再决定领什么。
func (service *Service) Probe(ctx context.Context, selection Selection) Outcome {
	providers := normalizeProviders(selection.Providers)
	actionID := strings.ToLower(strings.TrimSpace(selection.ActionID))
	if len(providers) == 0 || actionID == "" {
		return failure(400, "invalid_activity_selection")
	}
	if len(providers) != 1 {
		// 探测结果是「这个 Provider 的账号各自能领什么」，混批会让类型目录失去归属。
		return failure(400, "activity_probe_single_provider")
	}
	provider := providers[0]
	action, ok := service.catalog.Find(provider, actionID)
	if !ok {
		return Outcome{Status: 404, Payload: map[string]any{
			"ok": false, "provider": provider, "error": "activity_action_unknown:" + provider,
		}}
	}
	if !action.SupportsProbe {
		return Outcome{Status: 404, Payload: map[string]any{
			"ok": false, "provider": provider, "actionId": action.ID, "error": "activity_probe_unsupported",
		}}
	}
	if service.guard.IsClaimRunning(provider, action.ID) {
		return Outcome{Status: 409, Payload: map[string]any{
			"ok": false, "error": "activity_already_running", "reason": string(DeniedInFlight),
		}}
	}
	release, denied := service.guard.Acquire(ProbeKey(provider, action.ID), ProbeDebounce)
	if denied != nil {
		return Outcome{Status: 429, Payload: map[string]any{
			"ok":            false,
			"error":         "activity_probe_debounced",
			"reason":        string(denied.Reason),
			"nextAllowedAt": denied.NextAllowedAt.UnixMilli(),
		}}
	}
	defer release()

	refs, err := service.accounts.ListByProvider(ctx, provider)
	if err != nil {
		return failure(503, "account_list_failed:"+errorText(err))
	}
	capped := refs
	truncated := 0
	if len(capped) > ProbeMaxAccounts {
		truncated = len(capped) - ProbeMaxAccounts
		capped = capped[:ProbeMaxAccounts]
	}
	budget := service.now().Add(ProbeBudget)
	results := make([]map[string]any, 0, len(capped))
	for _, accountRef := range capped {
		if service.now().After(budget) {
			break
		}
		callContext, cancel := context.WithTimeout(ctx, ProbeCallTimeout)
		result := service.execute(callContext, Target{Provider: provider, AccountRef: accountRef}, action.ID, nil, true)
		cancel()
		results = append(results, result)
	}

	accounts := make([]map[string]any, 0, len(results))
	plansById := map[string]map[string]any{}
	// 保持首次出现顺序（Node 的 Map 插入序）：先出现的 plan 先展示。
	planOrder := make([]string, 0, 8)
	for _, result := range results {
		account := map[string]any{
			"accountRef": textOf(result["accountRef"]),
			"status":     textOf(result["status"]),
			"plans":      []any{},
		}
		if errorCode := textOf(result["error"]); errorCode != "" {
			account["error"] = errorCode
		}
		if discovery, ok := result["discovery"]; ok {
			account["discovery"] = discovery
		}
		plans, isList := result["plans"].([]any)
		if !isList {
			plans = []any{}
		}
		account["plans"] = plans
		accounts = append(accounts, account)
		for _, rawPlan := range plans {
			plan, ok := rawPlan.(map[string]any)
			if !ok {
				continue
			}
			planID := textOf(plan["planId"])
			if planID == "" {
				continue
			}
			entry := plansById[planID]
			if entry == nil {
				entry = map[string]any{
					"planId":   planID,
					"name":     textOf(plan["name"]),
					"planKind": textOf(plan["planKind"]),
					"accounts": []string{},
				}
				plansById[planID] = entry
				planOrder = append(planOrder, planID)
			}
			accountRef := textOf(result["accountRef"])
			if accountRef != "" {
				current, _ := entry["accounts"].([]string)
				if !containsString(current, accountRef) {
					entry["accounts"] = append(current, accountRef)
				}
			}
			if textOf(entry["planKind"]) == "" && textOf(plan["planKind"]) != "" {
				entry["planKind"] = textOf(plan["planKind"])
			}
		}
	}
	plans := make([]map[string]any, 0, len(planOrder))
	for _, planID := range planOrder {
		plans = append(plans, plansById[planID])
	}

	summary := Summarize(results)
	payload := map[string]any{
		"ok":       true,
		"provider": provider,
		"actionId": action.ID,
		"accounts": accounts,
		"plans":    plans,
		// 类型目录直接喂给 enum 选项：claimable 由本次探测决定，planIds 给出证据。
		"kinds":    DescribeKinds(action.Kinds, plans, true),
		"summary":  summary,
		"failures": summary.Failures,
	}
	if truncated > 0 {
		payload["truncated"] = truncated
	}
	return Outcome{Status: 200, Payload: payload}
}

// Job 读取任务快照。
func (service *Service) Job(jobID string) Outcome {
	view, found := service.jobs.Get(jobID)
	if !found {
		return failure(404, "activity_job_not_found")
	}
	return Outcome{Status: 200, Payload: map[string]any{"ok": true, "job": view}}
}

// Params 返回某个动作的参数候选值。
func (service *Service) Params(ctx context.Context, provider string, actionID string) Outcome {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if normalizedProvider == "" {
		return failure(400, "activity_provider_missing")
	}
	action, ok := service.catalog.Find(normalizedProvider, actionID)
	if !ok {
		return Outcome{Status: 404, Payload: map[string]any{
			"ok":     false,
			"error":  "activity_action_unknown:" + normalizedProvider,
			"params": []any{},
		}}
	}
	refs, listError := service.accounts.ListByProvider(ctx, normalizedProvider)
	params := make([]map[string]any, 0, len(action.Params))
	for _, field := range action.Params {
		view := map[string]any{
			"key":         field.Key,
			"label":       field.Label,
			"type":        field.Type,
			"description": field.Description,
			"required":    field.Required,
			"emptyMeans":  emptyMeansOf(field),
			"source":      "freeform",
			"options":     []any{},
		}
		if field.MaxItems > 0 {
			view["maxItems"] = field.MaxItems
		}
		switch field.Type {
		case "account-refs":
			options := make([]map[string]any, 0, len(refs))
			for _, accountRef := range refs {
				options = append(options, map[string]any{
					"value":       accountRef,
					"label":       accountRef,
					"description": "",
				})
			}
			view["source"] = "accounts"
			view["options"] = options
			if listError != nil {
				view["source"] = "unavailable"
				view["options"] = []any{}
				view["error"] = "activity_param_options_failed:" + errorText(listError)
			}
		case "enum":
			if field.OptionsFrom == "kinds" {
				kinds := DescribeKinds(action.Kinds, nil, false)
				options := make([]map[string]any, 0, len(kinds))
				for _, kind := range kinds {
					options = append(options, map[string]any{
						"value":       kind["id"],
						"label":       kind["label"],
						"description": kind["description"],
					})
				}
				view["source"] = "declared"
				view["options"] = options
			} else {
				options := make([]map[string]any, 0, len(field.Options))
				for _, option := range field.Options {
					options = append(options, map[string]any{
						"value":       option.Value,
						"label":       option.Label,
						"description": option.Description,
					})
				}
				view["source"] = "declared"
				view["options"] = options
			}
		}
		if field.OptionsFrom != "" {
			view["optionsFrom"] = field.OptionsFrom
		}
		params = append(params, view)
	}
	return Outcome{Status: 200, Payload: map[string]any{
		"ok":       true,
		"provider": normalizedProvider,
		"actionId": action.ID,
		"params":   params,
	}}
}

// RunForAccount 是账号菜单里的单账号单动作。
func (service *Service) RunForAccount(ctx context.Context, provider string, accountRef string, actionID string) Outcome {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	normalizedAction := strings.ToLower(strings.TrimSpace(actionID))
	normalizedRef := strings.TrimSpace(accountRef)
	actions := service.catalog.Actions(normalizedProvider)
	if len(actions) == 0 {
		return failure(400, "activity_unsupported:"+normalizedProvider)
	}
	action, ok := service.catalog.Find(normalizedProvider, normalizedAction)
	if !ok {
		return failure(404, "activity_action_unknown:"+normalizedAction)
	}
	refs, err := service.accounts.ListByProvider(ctx, normalizedProvider)
	if err != nil {
		return failure(503, "account_list_failed:"+errorText(err))
	}
	if !containsString(refs, normalizedRef) {
		return failure(404, "account_not_found")
	}
	// 批量任务在跑时不再插入单账号领取：同一上游端点的并发就是自造 429。
	if service.guard.IsClaimRunning(normalizedProvider, action.ID) {
		return Outcome{Status: 409, Payload: map[string]any{
			"ok": false, "error": "activity_already_running", "reason": string(DeniedInFlight),
		}}
	}
	release, denied := service.guard.Acquire(ClaimKey(normalizedProvider, action.ID), 0)
	if denied != nil {
		return guardFailure(denied)
	}
	defer release()

	callContext, cancel := context.WithTimeout(ctx, JobExecutionTimeout)
	defer cancel()
	result := service.execute(callContext, Target{Provider: normalizedProvider, AccountRef: normalizedRef}, action.ID, nil, false)
	payload := map[string]any{"ok": strings.ToLower(strings.TrimSpace(textOf(result["status"]))) != StatusError}
	for key, value := range result {
		payload[key] = value
	}
	return Outcome{Status: 200, Payload: payload}
}

func (service *Service) execute(
	ctx context.Context,
	target Target,
	actionID string,
	params map[string]any,
	dryRun bool,
) map[string]any {
	if target.Missing {
		return failureResult(target, actionID, "account_not_found")
	}
	result, err := service.gate.Execute(ctx, service.executor, ExecutionRequest{
		Provider:   target.Provider,
		AccountRef: target.AccountRef,
		ActionID:   actionID,
		Params:     params,
		DryRun:     dryRun,
	})
	if err != nil {
		code := "activity_failed:" + errorText(err)
		if errors.Is(err, ErrExecutorUnavailable) {
			code = "activity_executor_unavailable"
		}
		return failureResult(target, actionID, code)
	}
	return normalizeResult(target, actionID, result)
}

func failure(status int, code string) Outcome {
	return Outcome{Status: status, Payload: map[string]any{"ok": false, "error": code}}
}

func guardFailure(denied *Denied) Outcome {
	payload := map[string]any{"ok": false, "reason": string(denied.Reason)}
	if denied.Reason == DeniedDebounced {
		payload["error"] = "activity_debounced"
		if !denied.NextAllowedAt.IsZero() {
			payload["nextAllowedAt"] = denied.NextAllowedAt.UnixMilli()
		}
	} else {
		payload["error"] = "activity_already_running"
		if !denied.StartedAt.IsZero() {
			payload["startedAt"] = denied.StartedAt.UnixMilli()
		}
	}
	return Outcome{Status: 409, Payload: payload}
}

func errorText(err error) string {
	if err == nil {
		return "unknown"
	}
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return "unknown"
	}
	return message
}
