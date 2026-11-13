package translation

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// DefaultHedgeSchedule 定义首字对冲默认档位（1.5s 发第 2 个，3s 发第 3 个）。
var DefaultHedgeSchedule = []time.Duration{
	1500 * time.Millisecond,
	3000 * time.Millisecond,
}

// StreamEvent 表示翻译执行过程中发向客户端的 SSE 事件。
type StreamEvent struct {
	Type                string        `json:"type"`
	From                string        `json:"from,omitempty"`
	FromLabel           string        `json:"fromLabel,omitempty"`
	Detected            string        `json:"detected,omitempty"`
	DetectedLabel       string        `json:"detectedLabel,omitempty"`
	DetectionConfidence string        `json:"detectionConfidence,omitempty"`
	To                  string        `json:"to,omitempty"`
	ToLabel             string        `json:"toLabel,omitempty"`
	Model               string        `json:"model,omitempty"`
	Provider            string        `json:"provider,omitempty"`
	Attempt             int           `json:"attempt,omitempty"`
	RouteID             string        `json:"routeId,omitempty"`
	ModelProvider       string        `json:"modelProvider,omitempty"`
	Operation           string        `json:"operation,omitempty"`
	Content             string        `json:"content,omitempty"`
	OK                  *bool         `json:"ok,omitempty"`
	Retryable           *bool         `json:"retryable,omitempty"`
	Code                string        `json:"code,omitempty"`
	Message             string        `json:"message,omitempty"`
	Status              int           `json:"status,omitempty"`
	Route               *Route        `json:"route,omitempty"`
	Text                string        `json:"text,omitempty"`
	PartialText         string        `json:"partialText,omitempty"`
	Usage               *UsageSummary `json:"usage,omitempty"`
	ElapsedMS           int64         `json:"elapsedMs,omitempty"`
}

// ExecutionError 描述单条路由或整体链路的失败原因。
type ExecutionError struct {
	Code      string
	Message   string
	Status    int
	Retryable bool
}

// AttemptRecord 记录单次尝试的可观察摘要。
type AttemptRecord struct {
	Attempt       int
	RouteID       string
	Provider      string
	ModelProvider string
	Model         string
	Operation     string
	OK            bool
	Code          string
	Retryable     bool
}

// RunResult 表示单次执行或完整路由链的结果。
type RunResult struct {
	OK       bool
	Text     string
	Usage    *UsageSummary
	Error    *ExecutionError
	Route    *Route
	Attempts []AttemptRecord
}

// PlanEntry 是经过能力过滤与优先级排序后的待执行路由。
type PlanEntry struct {
	Route      Route
	Operation  string
	Descriptor *ProviderDescriptor
}

// ExecuteRouteInput 传给路由执行器的归一化请求。
type ExecuteRouteInput struct {
	Operation  string
	Text       string
	Source     string
	Target     string
	Glossary   []GlossaryItem
	Formality  string
	Messages   []ChatMessage
	Route      Route
	Descriptor ProviderDescriptor
	HedgeIndex int
	MaxTokens  int
}

// ExecuteRouteFunc 允许单测注入自定义路由执行器。
type ExecuteRouteFunc func(ctx context.Context, input ExecuteRouteInput, emit func(StreamEvent)) RunResult

// RunOptions 配置路由链的执行策略。
type RunOptions struct {
	Routes        []Route
	Operation     string
	HedgeDisabled bool
	HedgeSchedule []time.Duration
	DatabasePath  string
	Gateway       GatewayConfig
	HTTPClient    AdapterClient
	AdapterTime   time.Duration
	ExecuteRoute  ExecuteRouteFunc
}

func normalizeOperation(op string) string {
	trimmed := strings.ToLower(strings.TrimSpace(op))
	if trimmed == "" {
		return "selection"
	}
	return trimmed
}

func containsOperation(ops []string, target string) bool {
	for _, op := range ops {
		if op == target {
			return true
		}
	}
	return false
}

// PlanRoutes 按操作过滤已启用路由，并保持稳定优先级排序。
func PlanRoutes(routes []Route, operation string) []PlanEntry {
	op := normalizeOperation(operation)
	type indexed struct {
		route Route
		index int
	}
	selected := make([]indexed, 0, len(routes))
	for i, route := range routes {
		if !route.Enabled || !containsOperation(route.Operations, op) {
			continue
		}
		selected = append(selected, indexed{route: route, index: i})
	}
	sort.SliceStable(selected, func(i, j int) bool {
		if selected[i].route.Priority != selected[j].route.Priority {
			return selected[i].route.Priority < selected[j].route.Priority
		}
		return selected[i].index < selected[j].index
	})
	plan := make([]PlanEntry, 0, len(selected))
	for _, item := range selected {
		var descriptorPtr *ProviderDescriptor
		if desc, ok := FindProviderDescriptor(item.route.Provider); ok && CanExecuteProvider(desc.ID, op) {
			descriptorPtr = &desc
		}
		plan = append(plan, PlanEntry{
			Route:      item.route,
			Operation:  op,
			Descriptor: descriptorPtr,
		})
	}
	return plan
}

// RoutesAllowAutoSource 当且仅当计划内所有候选服务商均支持 source=auto 时允许跳过本地语种拦截。
func RoutesAllowAutoSource(routes []Route, operation string, useGatewayDefault bool) bool {
	plan := PlanRoutes(routes, operation)
	if len(plan) > 0 {
		for _, entry := range plan {
			if entry.Descriptor == nil || !entry.Descriptor.Capabilities.SourceAuto {
				return false
			}
		}
		return true
	}
	if !useGatewayDefault {
		return false
	}
	if gw, ok := FindProviderDescriptor("aih-gateway"); ok {
		return gw.Capabilities.SourceAuto
	}
	return false
}

// ClassifyFailure 强制执行「已有部分译文产出时绝不自动重放」规则。
func ClassifyFailure(err *ExecutionError, aborted bool, partial bool) (code string, retryable bool) {
	if err != nil && strings.TrimSpace(err.Code) != "" {
		code = err.Code
	} else {
		code = "translation_failed"
	}
	if aborted || code == "translation_aborted" {
		return "translation_aborted", false
	}
	if partial {
		return code, false
	}
	if err != nil && err.Status > 0 {
		return code, err.Status == 408 || err.Status == 409 || err.Status == 425 || err.Status == 429 || err.Status >= 500
	}
	if err != nil {
		if code == "translation_model_required" || code == "translation_input_invalid" || code == "translation_language_unsupported" {
			return code, false
		}
		return code, err.Retryable
	}
	return code, true
}

func abortedRunResult() RunResult {
	return RunResult{
		OK:    false,
		Error: &ExecutionError{Code: "translation_aborted", Message: "翻译已取消", Retryable: false},
	}
}

// ExecuteHedged 在首字迟迟未到来时按档位并发对冲同一路由；谁先产出有效译文谁胜出并立即取消其他并发调用。
func ExecuteHedged(
	ctx context.Context,
	schedule []time.Duration,
	run func(attemptCtx context.Context, emit func(StreamEvent), hedgeIndex int) RunResult,
	forward func(StreamEvent),
) RunResult {
	if schedule == nil {
		schedule = DefaultHedgeSchedule
	}
	if ctx.Err() != nil {
		return abortedRunResult()
	}

	type contender struct {
		cancel context.CancelFunc
		buffer []StreamEvent
		done   bool
		result RunResult
	}

	var (
		mu         sync.Mutex
		contenders []*contender
		winner     *contender
		settled    bool
		finalRes   RunResult
		timers     []*time.Timer
		doneCh     = make(chan struct{}, 1)
	)

	clearTimersLocked := func() {
		for _, t := range timers {
			t.Stop()
		}
		timers = nil
	}

	finishLocked := func(res RunResult) {
		if settled {
			return
		}
		settled = true
		clearTimersLocked()
		for _, item := range contenders {
			if item != winner {
				item.cancel()
			}
		}
		finalRes = res
		select {
		case doneCh <- struct{}{}:
		default:
		}
	}

	claimLocked := func(item *contender) {
		if winner != nil {
			return
		}
		winner = item
		clearTimersLocked()
		for _, other := range contenders {
			if other != item {
				other.cancel()
			}
		}
		buffered := item.buffer
		item.buffer = nil
		mu.Unlock()
		for _, ev := range buffered {
			if forward != nil {
				forward(ev)
			}
		}
		mu.Lock()
	}

	startContender := func() {
		mu.Lock()
		if settled || winner != nil || ctx.Err() != nil {
			mu.Unlock()
			return
		}
		cCtx, cCancel := context.WithCancel(ctx)
		item := &contender{cancel: cCancel}
		hedgeIdx := len(contenders)
		contenders = append(contenders, item)
		mu.Unlock()

		emit := func(ev StreamEvent) {
			mu.Lock()
			if settled || (winner != nil && winner != item) {
				mu.Unlock()
				return
			}
			if winner == item {
				mu.Unlock()
				if forward != nil {
					forward(ev)
				}
				return
			}
			if ev.Type == "delta" && ev.Content != "" {
				claimLocked(item)
				mu.Unlock()
				if forward != nil {
					forward(ev)
				}
				return
			}
			item.buffer = append(item.buffer, ev)
			mu.Unlock()
		}

		go func() {
			res := run(cCtx, emit, hedgeIdx)
			mu.Lock()
			item.done = true
			item.result = res
			if settled {
				mu.Unlock()
				return
			}
			if winner == item {
				finishLocked(res)
				mu.Unlock()
				return
			}
			if winner != nil {
				mu.Unlock()
				return
			}
			if res.OK {
				claimLocked(item)
				finishLocked(res)
				mu.Unlock()
				return
			}
			allDone := true
			for _, other := range contenders {
				if !other.done {
					allDone = false
					break
				}
			}
			if allDone {
				finishLocked(res)
			}
			mu.Unlock()
		}()
	}

	startContender()
	mu.Lock()
	if !settled && winner == nil && ctx.Err() == nil {
		for _, delay := range schedule {
			if delay <= 0 {
				go startContender()
				continue
			}
			t := time.AfterFunc(delay, startContender)
			timers = append(timers, t)
		}
	}
	mu.Unlock()

	select {
	case <-doneCh:
		return finalRes
	case <-ctx.Done():
		mu.Lock()
		if !settled {
			finishLocked(abortedRunResult())
		}
		res := finalRes
		mu.Unlock()
		return res
	}
}

func defaultExecuteRoute(opts RunOptions) ExecuteRouteFunc {
	return func(ctx context.Context, input ExecuteRouteInput, emit func(StreamEvent)) RunResult {
		if input.Descriptor.ID == "aih-gateway" {
			provider := NormalizeProviderID(input.Route.ModelProvider)
			if provider == "" {
				provider = InferModelFamilyProvider(input.Route.Model)
			}
			hedgeSuffix := ""
			if input.HedgeIndex > 0 {
				hedgeSuffix = ":hedge" + string(rune('0'+input.HedgeIndex))
				if input.HedgeIndex >= 10 {
					hedgeSuffix = ":hedge"
				}
			}
			sessionKey := "aih-translation:"
			if provider != "" {
				sessionKey += provider
			} else {
				sessionKey += "auto"
			}
			sessionKey += ":" + input.Route.Model + hedgeSuffix
			return ExecuteGatewayStream(ctx, opts.Gateway, GatewayStreamInput{
				Model:      input.Route.Model,
				Provider:   provider,
				SessionKey: sessionKey,
				MaxTokens:  input.MaxTokens,
				Messages:   input.Messages,
			}, emit)
		}

		cfg := map[string]string{}
		if desc, ok := FindProviderDescriptor(input.Descriptor.ID); ok {
			if loaded, err := ReadProviderConfig(ctx, opts.DatabasePath, desc); err == nil {
				cfg = loaded
			}
		}
		return ExecuteHTTPAdapter(ctx, input.Descriptor.ID, AdapterInput{
			Text:      input.Text,
			Source:    input.Source,
			Target:    input.Target,
			Glossary:  input.Glossary,
			Formality: input.Formality,
		}, cfg, opts.HTTPClient, opts.AdapterTime, emit)
	}
}

// RunRoutes 按顺序执行规划好的翻译路由链，并保证局部输出后绝不重放。
func RunRoutes(
	ctx context.Context,
	input ExecuteRouteInput,
	opts RunOptions,
	emit func(StreamEvent),
) RunResult {
	plan := PlanRoutes(opts.Routes, opts.Operation)
	if len(plan) == 0 {
		return RunResult{
			OK:       false,
			Error:    &ExecutionError{Code: "translation_routes_unavailable", Message: "没有可用的翻译路由", Retryable: false},
			Attempts: []AttemptRecord{},
		}
	}

	execFn := opts.ExecuteRoute
	if execFn == nil {
		execFn = defaultExecuteRoute(opts)
	}

	attempts := make([]AttemptRecord, 0, len(plan))
	lastResult := RunResult{
		OK:    false,
		Error: &ExecutionError{Code: "translation_routes_unavailable", Message: "没有可用的翻译路由", Retryable: false},
	}

	for _, entry := range plan {
		if ctx.Err() != nil {
			res := abortedRunResult()
			res.Attempts = attempts
			return res
		}
		route := entry.Route
		attemptNum := len(attempts) + 1
		if emit != nil {
			emit(StreamEvent{
				Type:          "attempt_start",
				Attempt:       attemptNum,
				RouteID:       route.ID,
				Provider:      route.Provider,
				ModelProvider: route.ModelProvider,
				Model:         route.Model,
				Operation:     entry.Operation,
			})
		}

		var mu sync.Mutex
		var partialText strings.Builder
		finished := false

		forward := func(ev StreamEvent) {
			mu.Lock()
			if finished || ctx.Err() != nil {
				mu.Unlock()
				return
			}
			if ev.Type == "delta" && ev.Content != "" {
				partialText.WriteString(ev.Content)
			}
			mu.Unlock()
			if ev.Type != "done" && ev.Type != "error" && emit != nil {
				emit(ev)
			}
		}

		var res RunResult
		if entry.Descriptor == nil {
			res = RunResult{
				OK:    false,
				Error: &ExecutionError{Code: "translation_provider_unsupported", Message: "翻译路由不支持此操作", Retryable: true},
			}
		} else {
			desc := *entry.Descriptor
			runOnce := func(attemptCtx context.Context, attemptEmit func(StreamEvent), hedgeIndex int) RunResult {
				req := input
				req.Operation = entry.Operation
				req.Route = route
				req.Descriptor = desc
				req.HedgeIndex = hedgeIndex
				return execFn(attemptCtx, req, attemptEmit)
			}
			if opts.HedgeDisabled {
				res = runOnce(ctx, forward, 0)
			} else {
				res = ExecuteHedged(ctx, opts.HedgeSchedule, runOnce, forward)
			}
		}

		if ctx.Err() != nil {
			res = abortedRunResult()
		}
		mu.Lock()
		partial := partialText.String()
		mu.Unlock()

		if res.OK && strings.TrimSpace(res.Text+partial) == "" {
			res = RunResult{
				OK:    false,
				Error: &ExecutionError{Code: "translation_empty_output", Message: "上游没有返回译文", Retryable: true},
			}
		}

		if res.OK {
			if partial == "" && res.Text != "" {
				forward(StreamEvent{Type: "delta", Content: res.Text})
			}
			mu.Lock()
			finished = true
			mu.Unlock()
			attempts = append(attempts, AttemptRecord{
				Attempt:       attemptNum,
				RouteID:       route.ID,
				Provider:      route.Provider,
				ModelProvider: route.ModelProvider,
				Model:         route.Model,
				Operation:     entry.Operation,
				OK:            true,
				Retryable:     false,
			})
			okTrue := true
			retryFalse := false
			if emit != nil {
				emit(StreamEvent{
					Type:          "attempt_success",
					Attempt:       attemptNum,
					RouteID:       route.ID,
					Provider:      route.Provider,
					ModelProvider: route.ModelProvider,
					Model:         route.Model,
					Operation:     entry.Operation,
					Retryable:     &retryFalse,
				})
			}
			_ = okTrue
			routeCopy := route
			if res.Text == "" {
				res.Text = partial
			}
			res.Route = &routeCopy
			res.Attempts = attempts
			return res
		}

		hasPartial := partial != "" || res.Text != ""
		code, retryable := ClassifyFailure(res.Error, ctx.Err() != nil, hasPartial)
		mu.Lock()
		finished = true
		mu.Unlock()

		msg := "翻译失败"
		status := 0
		if res.Error != nil {
			if res.Error.Message != "" {
				msg = res.Error.Message
			}
			status = res.Error.Status
		}
		textOut := partial
		if textOut == "" {
			textOut = res.Text
		}
		lastResult = RunResult{
			OK:       false,
			Text:     textOut,
			Error:    &ExecutionError{Code: code, Message: msg, Status: status, Retryable: retryable},
			Attempts: nil,
		}
		attempts = append(attempts, AttemptRecord{
			Attempt:       attemptNum,
			RouteID:       route.ID,
			Provider:      route.Provider,
			ModelProvider: route.ModelProvider,
			Model:         route.Model,
			Operation:     entry.Operation,
			OK:            false,
			Code:          code,
			Retryable:     retryable,
		})
		retryCopy := retryable
		if emit != nil {
			emit(StreamEvent{
				Type:          "attempt_failure",
				Attempt:       attemptNum,
				RouteID:       route.ID,
				Provider:      route.Provider,
				ModelProvider: route.ModelProvider,
				Model:         route.Model,
				Operation:     entry.Operation,
				Code:          code,
				Retryable:     &retryCopy,
				Status:        status,
			})
		}
		if !retryable {
			break
		}
	}
	lastResult.Attempts = attempts
	return lastResult
}

// ResolveTranslationRequestRoutes 按请求体、已保存路线及目录默认计算本次执行的路由与首显模型。
func ResolveTranslationRequestRoutes(
	hasRoutes bool,
	rawRoutes any,
	bodyModel string,
	bodyProvider string,
	operation string,
	fallbackCatalog ModelCatalog,
	saved *Settings,
) ([]Route, string, string, error) {
	var routes []Route
	var selModel, selProvider string
	hasSelected := false

	if hasRoutes {
		routes = NormalizeRoutesRaw(rawRoutes, true, "", "")
	} else if bodyModel == "" && bodyProvider == "" && saved != nil {
		routes = ResolveTranslationRoutesForRequest(saved.Routes, saved.Model, saved.Provider, fallbackCatalog, operation)
	}
	for i := range routes {
		routes[i] = NormalizeRouteProvider(routes[i])
	}

	if !hasRoutes && len(routes) == 0 {
		m, p, err := ResolveRequestModel(bodyModel, bodyProvider, fallbackCatalog)
		if err != nil {
			return nil, "", "", err
		}
		selModel, selProvider = m, p
		hasSelected = true
		routes = []Route{{
			ID:            "legacy:" + p + ":" + m,
			Provider:      "aih-gateway",
			Model:         m,
			ModelProvider: p,
			Enabled:       true,
			Priority:      0,
			Operations:    []string{"selection", "batch", "page", "replace"},
		}}
	}

	if !hasSelected {
		plan := PlanRoutes(routes, operation)
		if len(plan) > 0 {
			selModel = plan[0].Route.Model
			selProvider = plan[0].Route.ModelProvider
		}
	}
	return routes, selModel, selProvider, nil
}
