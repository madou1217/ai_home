package apps

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexruntime"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
)

const (
	defaultPlanExecTimeout = 5 * time.Minute
	// defaultAutoEgressAttempts 是自动代理在作业路径上最多尝试的出口数。
	defaultAutoEgressAttempts = 4
	minVerifyRetries       = 1
	maxVerifyRetries       = 12
	maxVerifyDelay         = 5 * time.Second
)

type appJobEntry struct {
	job JobView
	// release 保留任务期代理租约；作业进入终态或取消后立即释放。
	release func()
}

// JobManager 管理 CLI / Desktop / IDE 的安装、更新与卸载异步作业及 SSE 订阅。
type JobManager struct {
	manager          *Manager
	baseOpts         Options
	verifyRetries    int
	verifyRetryDelay time.Duration

	mu             sync.Mutex
	jobs           map[string]*appJobEntry
	activeByTarget map[string]string
	watchers       map[string]map[chan JobEvent]struct{}
	allWatchers    map[chan JobEvent]struct{}
	onJobChanged   func(JobView)
}

// NewJobManager 创建应用安装生命周期作业管理器。
func NewJobManager(manager *Manager, baseOpts Options) *JobManager {
	if manager == nil {
		manager = NewManager()
	}
	retries := baseOpts.VerifyRetries
	delay := baseOpts.VerifyRetryDelay
	if retries <= 0 {
		retries = defaultVerifyRetries
		if delay <= 0 {
			delay = defaultVerifyDelay
		}
	}
	if retries < minVerifyRetries {
		retries = minVerifyRetries
	} else if retries > maxVerifyRetries {
		retries = maxVerifyRetries
	}
	if delay < 0 {
		delay = 0
	} else if delay > maxVerifyDelay {
		delay = maxVerifyDelay
	}
	return &JobManager{
		manager:          manager,
		baseOpts:         baseOpts,
		verifyRetries:    retries,
		verifyRetryDelay: delay,
		jobs:             make(map[string]*appJobEntry),
		activeByTarget:   make(map[string]string),
		watchers:         make(map[string]map[chan JobEvent]struct{}),
		allWatchers:      make(map[chan JobEvent]struct{}),
	}
}

// SetOnJobChanged 注册作业状态变更回调（供统一任务中心实时同步使用）。
func (m *JobManager) SetOnJobChanged(fn func(JobView)) {
	m.mu.Lock()
	m.onJobChanged = fn
	m.mu.Unlock()
}

func (m *JobManager) nowTime() time.Time {
	return (&m.baseOpts).nowTime()
}

func normalizeLifecycleKind(raw string) string {
	kind := strings.ToLower(strings.TrimSpace(raw))
	if kind == "ide" {
		return "desktop"
	}
	if kind == "desktop" || kind == "cli" {
		return kind
	}
	return ""
}

func normalizeLifecycleAction(raw string, explicit bool) string {
	if !explicit && raw == "" {
		return "install"
	}
	action := strings.ToLower(strings.TrimSpace(raw))
	switch action {
	case "install", "update", "uninstall":
		return action
	default:
		return ""
	}
}

func lifecycleActionLabel(action string) string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "install":
		return "安装"
	case "update":
		return "更新"
	case "uninstall":
		return "卸载"
	default:
		return "操作"
	}
}

func isJobTerminalStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "cancelled":
		return true
	default:
		return false
	}
}

// ResolveTarget 归一 appId / provider / kind / action，规则与 Node app-install-job-manager 一致。
func (m *JobManager) ResolveTarget(input InstallInput) *InstallTarget {
	return ResolveInstallTarget(input)
}

// ResolveInstallTarget 解析并校验应用安装生命周期目标。
func ResolveInstallTarget(input InstallInput) *InstallTarget {
	explicitAction := input.Action != ""
	// 调用方可通过 Provider 字段显式区分，但 Action 若需区分布尔"未传 vs 传空"，由 HTTP DTO 层转为空格占位符。
	if input.Action == " " {
		return nil
	}
	action := normalizeLifecycleAction(input.Action, explicitAction)
	if action == "" {
		return nil
	}
	appID := strings.ToLower(strings.TrimSpace(input.AppID))
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	kind := normalizeLifecycleKind(input.Kind)

	if appID != "" {
		if strings.HasSuffix(appID, "-desktop") {
			if provider == "" {
				provider = strings.TrimSuffix(appID, "-desktop")
			}
			if kind == "" {
				kind = "desktop"
			}
		} else if getIDEClient(appID) != nil {
			if provider == "" {
				provider = appID
			}
			kind = "desktop"
		} else {
			if provider == "" {
				provider = appID
			}
			if kind == "" {
				kind = "cli"
			}
		}
	}
	if provider == "" || kind == "" {
		return nil
	}
	resolvedAppID := appID
	if resolvedAppID == "" {
		if kind == "desktop" {
			resolvedAppID = provider + "-desktop"
		} else {
			resolvedAppID = provider
		}
	}
	return &InstallTarget{
		AppID:    resolvedAppID,
		Provider: provider,
		Kind:     kind,
		Action:   action,
		Key:      kind + ":" + provider,
	}
}

func (m *JobManager) effectiveOpts(input InstallInput) Options {
	opts := m.baseOpts
	if strings.TrimSpace(input.InstalledPath) != "" {
		opts.InstalledPath = strings.TrimSpace(input.InstalledPath)
	}
	return opts
}

// CanInstall 返回目标应用在当前平台是否具备可执行的生命周期计划。
func (m *JobManager) CanInstall(input InstallInput) bool {
	target := ResolveInstallTarget(input)
	if target == nil {
		return false
	}
	spec := getInstaller(target.Provider)
	if spec == nil {
		return false
	}
	opts := m.effectiveOpts(input)
	if target.Kind == "desktop" {
		return len(ResolveLifecyclePlans(target.Provider, target.Kind, target.Action, opts, "", nil)) > 0
	}
	if !isCLIInstallSupported(target.Provider) {
		return false
	}
	return len(ResolveLifecyclePlans(target.Provider, target.Kind, target.Action, opts, "", nil)) > 0
}

// Plan 返回目标应用生命周期操作的命令预览，不执行实际安装/更新/卸载。
func (m *JobManager) Plan(input InstallInput) PlanResponse {
	if input.Action == " " || normalizeLifecycleAction(input.Action, input.Action != "") == "" {
		return PlanResponse{OK: false, Error: "invalid_lifecycle_action"}
	}
	target := ResolveInstallTarget(input)
	if target == nil {
		return PlanResponse{OK: false, Error: "invalid_install_target"}
	}
	spec := getInstaller(target.Provider)
	if spec == nil {
		return PlanResponse{OK: false, Error: "provider_installer_unavailable"}
	}
	if target.Kind == "cli" && !isCLIInstallSupported(target.Provider) {
		return PlanResponse{OK: false, Error: "cli_not_supported"}
	}
	if !m.CanInstall(input) {
		return PlanResponse{OK: false, Error: target.Action + "_not_supported"}
	}
	proxySelector := strings.TrimSpace(input.Proxy)
	if proxySelector != "" {
		if !strings.Contains(proxySelector, "://") {
			if m.baseOpts.ProxyResolver == nil {
				return PlanResponse{
					OK: false, Error: "proxy_selector_unsupported",
					Message: "当前 Server 不支持命名代理选择器；请改用 HTTP(S) 代理 URL 或直连。",
				}
			}
		} else if _, err := updateproxy.Environment(nil, proxySelector); err != nil {
			return PlanResponse{OK: false, Error: "invalid_proxy", Message: err.Error()}
		}
	}
	opts := m.effectiveOpts(input)
	var installedPath string
	var installedRecord *DesktopRecord
	if target.Action != "install" {
		if target.Kind == "cli" {
			installedPath = ResolveProviderCLIPath(target.Provider, opts)
		} else {
			installedRecord = FindDesktopClientRecord(context.Background(), target.Provider, opts)
		}
	}
	rawPlans := ResolveLifecyclePlans(target.Provider, target.Kind, target.Action, opts, installedPath, installedRecord)
	plans := make([]LifecyclePlan, 0, len(rawPlans))
	for _, item := range rawPlans {
		args := item.Args
		if args == nil {
			args = []string{}
		}
		plans = append(plans, LifecyclePlan{
			ID:      item.ID,
			Label:   item.Label,
			Command: item.Command,
			Args:    append([]string(nil), args...),
		})
	}
	return PlanResponse{
		OK:       true,
		AppID:    target.AppID,
		Provider: target.Provider,
		Kind:     target.Kind,
		Action:   target.Action,
		Key:      target.Key,
		Label:    target.Provider + " " + lifecycleActionLabel(target.Action),
		Plans:    plans,
		Proxy:    proxySelector,
	}
}

// Start 创建并异步执行一条应用安装/更新/卸载作业，同目标并发请求幂等复用活跃作业。
func (m *JobManager) Start(ctx context.Context, input InstallInput) JobStartResult {
	if input.Action == " " || normalizeLifecycleAction(input.Action, input.Action != "") == "" {
		return JobStartResult{OK: false, Error: "invalid_lifecycle_action"}
	}
	target := ResolveInstallTarget(input)
	if target == nil {
		return JobStartResult{OK: false, Error: "invalid_install_target"}
	}
	spec := getInstaller(target.Provider)
	if spec == nil {
		return JobStartResult{OK: false, Error: "provider_installer_unavailable"}
	}
	if target.Kind == "cli" && !isCLIInstallSupported(target.Provider) {
		return JobStartResult{OK: false, Error: "cli_not_supported"}
	}
	if !m.CanInstall(input) {
		return JobStartResult{OK: false, Error: target.Action + "_not_supported"}
	}

	// 代理租约可能涉及 SSH / 代理内核，必须在作业锁之外获取；否则一次失败的
	// 选择器会把整个 JobManager 卡在 m.mu 上。
	proxyURL, proxyName, proxyRelease, proxyErrCode, proxyErrMessage := m.resolveInstallProxy(ctx, input.Proxy)
	if proxyErrCode != "" {
		return JobStartResult{OK: false, Error: proxyErrCode, Message: proxyErrMessage}
	}
	input.ProxyURL = proxyURL
	input.ProxyName = proxyName

	m.mu.Lock()
	m.pruneLocked()
	if activeID := m.activeByTarget[target.Key]; activeID != "" {
		if entry := m.jobs[activeID]; entry != nil && !isJobTerminalStatus(entry.job.Status) {
			snap := cloneAppJobView(entry.job)
			m.mu.Unlock()
			if proxyRelease != nil {
				proxyRelease()
			}
			return JobStartResult{OK: true, Accepted: true, AlreadyRunning: true, Job: &snap}
		}
		delete(m.activeByTarget, target.Key)
	}

	nowMs := m.nowTime().UnixMilli()
	id := "app-install-" + newAppUUID()
	kindTitle := "CLI"
	if target.Kind == "desktop" {
		kindTitle = "Desktop"
	}
	job := JobView{
		ID:       id,
		Source:   "app-install",
		TaskName: fmt.Sprintf("%s %s %s", target.Provider, kindTitle, lifecycleActionLabel(target.Action)),
		AppID:    target.AppID,
		Provider: target.Provider,
		Kind:     target.Kind,
		Action:   target.Action,
		Status:   "queued",
		Phase:    "queued",
		Progress: JobProgress{
			Percent: 0,
			Label:   "等待安装任务开始",
		},
		Proxy:     installProxyLabel(input),
		Attempts:  []AttemptView{},
		CreatedAt: nowMs,
		UpdatedAt: nowMs,
	}
	m.jobs[id] = &appJobEntry{job: job, release: proxyRelease}
	m.activeByTarget[target.Key] = id
	snap := cloneAppJobView(job)
	m.mu.Unlock()

	m.notify(snap)
	go m.runJob(id, target, input)
	return JobStartResult{OK: true, Accepted: true, AlreadyRunning: false, Job: &snap}
}

// Get 查询单个安装作业快照。
func (m *JobManager) Get(jobID string) *JobView {
	id := strings.TrimSpace(jobID)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	entry := m.jobs[id]
	if entry == nil {
		return nil
	}
	snap := cloneAppJobView(entry.job)
	return &snap
}

// ListActive 列出所有未进入终态的安装作业，按创建时间升序。
func (m *JobManager) ListActive() []JobView {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	items := make([]JobView, 0)
	for _, entry := range m.jobs {
		if entry == nil || isJobTerminalStatus(entry.job.Status) {
			continue
		}
		items = append(items, cloneAppJobView(entry.job))
	}
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].CreatedAt < items[j-1].CreatedAt; j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
	return items
}

// Cancel 取消尚处于 queued 状态的安装作业。
func (m *JobManager) Cancel(jobID string) JobCancelResult {
	id := strings.TrimSpace(jobID)
	m.mu.Lock()
	entry := m.jobs[id]
	if entry == nil {
		m.mu.Unlock()
		return JobCancelResult{OK: false, Error: "job_not_found", Job: nil}
	}
	if entry.job.Status != "queued" {
		snap := cloneAppJobView(entry.job)
		m.mu.Unlock()
		return JobCancelResult{OK: false, Error: "job_not_cancellable", Job: &snap}
	}
	nowMs := m.nowTime().UnixMilli()
	entry.job.Status = "cancelled"
	entry.job.Phase = "cancelled"
	entry.job.Error = "安装任务已取消。"
	entry.job.UpdatedAt = nowMs
	entry.job.FinishedAt = &nowMs
	release := entry.release
	entry.release = nil
	delete(m.activeByTarget, entry.job.Kind+":"+entry.job.Provider)
	snap := cloneAppJobView(entry.job)
	m.mu.Unlock()

	if release != nil {
		release()
	}
	m.notify(snap)
	return JobCancelResult{OK: true, Job: &snap}
}

// Subscribe 订阅指定作业的状态变更；返回当前快照（未找到为 nil）及退订函数。
func (m *JobManager) Subscribe(jobID string) (<-chan JobEvent, *JobView, func()) {
	id := strings.TrimSpace(jobID)
	m.mu.Lock()
	entry := m.jobs[id]
	if entry == nil {
		m.mu.Unlock()
		return nil, nil, func() {}
	}
	snap := cloneAppJobView(entry.job)
	ch := make(chan JobEvent, 32)
	set := m.watchers[id]
	if set == nil {
		set = make(map[chan JobEvent]struct{})
		m.watchers[id] = set
	}
	set[ch] = struct{}{}
	m.mu.Unlock()

	cancel := func() {
		m.mu.Lock()
		if s := m.watchers[id]; s != nil {
			delete(s, ch)
			if len(s) == 0 {
				delete(m.watchers, id)
			}
		}
		m.mu.Unlock()
	}
	return ch, &snap, cancel
}

// SubscribeAll 订阅所有应用安装作业的变更，供任务中心 SSE 使用。
func (m *JobManager) SubscribeAll() (<-chan JobEvent, func()) {
	ch := make(chan JobEvent, 64)
	m.mu.Lock()
	m.allWatchers[ch] = struct{}{}
	m.mu.Unlock()
	return ch, func() {
		m.mu.Lock()
		delete(m.allWatchers, ch)
		m.mu.Unlock()
	}
}

func (m *JobManager) runJob(jobID string, target *InstallTarget, input InstallInput) {
	defer m.releaseJobProxy(jobID)
	ctx := context.Background()
	m.mu.Lock()
	entry := m.jobs[jobID]
	if entry == nil || entry.job.Status == "cancelled" {
		m.mu.Unlock()
		return
	}
	entry.job.Status = "running"
	entry.job.Phase = "installing"
	entry.job.Progress = JobProgress{Percent: 1, Label: lifecycleActionLabel(target.Action) + "任务已开始"}
	entry.job.UpdatedAt = m.nowTime().UnixMilli()
	startSnap := cloneAppJobView(entry.job)
	m.mu.Unlock()
	m.notify(startSnap)

	opts := m.effectiveOpts(input)
	var finalErr string
	var finalResult *JobResultView
	succeeded := false

	defer func() {
		m.finalizeJob(jobID, target, succeeded, finalResult, finalErr)
	}()

	if input.ProxyURL != "" {
		proxyEnv, proxyErr := updateproxy.Environment(opts.Env, input.ProxyURL)
		if proxyErr != nil {
			finalErr = "invalid_proxy: " + proxyErr.Error()
			return
		}
		opts.Env = proxyEnv
	}

	spec := getInstaller(target.Provider)
	if spec == nil {
		finalErr = "provider_installer_unavailable:" + target.Provider
		return
	}
	if target.Kind == "cli" && !isCLIInstallSupported(target.Provider) {
		finalErr = "cli_not_supported:" + target.Provider
		return
	}

	if target.Provider == "codex" && target.Kind == "cli" && target.Action == "uninstall" {
		if _, receipt, err := codexruntime.Current(ResolveHostHome(opts)); receipt != nil || err != nil {
			attempt, result, ok := executeCodexRuntimeUninstall(opts)
			m.appendAttempt(jobID, attempt, 85, attempt.Label)
			succeeded, finalResult, finalErr = ok, result, attempt.Error
			return
		}
	}
	if target.Kind == "cli" && target.Action != "uninstall" && spec.CLI != nil {
		if gateAttempt, gateErr := m.checkCLIMinNodeVersion(ctx, spec.CLI, opts); gateAttempt != nil {
			m.appendAttempt(jobID, *gateAttempt, 0, gateAttempt.Label)
			finalErr = gateErr
			return
		}
		if len(spec.CLI.LegacyNpmPackages) > 0 {
			cleanupAttempt := m.runLegacyNpmCleanup(ctx, jobID, spec.CLI.LegacyNpmPackages, opts)
			m.appendAttempt(jobID, cleanupAttempt, 25, cleanupAttempt.Label)
		}
	}

	// 显式指定代理的作业只跑一轮：用户选定的出口失败就不能自动换出口，
	// 那会静默改变出口 IP。只有「没指定代理」的作业才走自动兜底。
	if input.Proxy != "" {
		outcome := m.runLifecyclePlans(ctx, jobID, target, opts, true)
		succeeded, finalResult, finalErr = outcome.ok, outcome.result, outcome.err
		return
	}
	outcome := m.runWithAutoEgress(ctx, jobID, target, opts)
	succeeded, finalResult, finalErr = outcome.ok, outcome.result, outcome.err
}

// lifecycleOutcome 是一轮生命周期计划执行的完整结果。
//
// 单独成类型而不是散落成多个返回值：自动代理每一轮都要完整复现「计划失败
// 文案 + 成功结果」，用零散变量会在轮次之间串味。
type lifecycleOutcome struct {
	ok     bool
	err    string
	result *JobResultView
}

// runLifecyclePlans 解析并执行一次生命周期计划。
//
// proxyActive 表示本轮是否真的配了代理：Windows 上它决定是否接受官方安装器
// （无法保证全部下载走代理的安装器必须拒绝）。每次轮换后按本轮的实际情况重算，
// 不能沿用作业创建时的判定。
func (m *JobManager) runLifecyclePlans(
	ctx context.Context,
	jobID string,
	target *InstallTarget,
	opts Options,
	proxyActive bool,
) lifecycleOutcome {
	var installedPath string
	var installedRecord *DesktopRecord
	if target.Action != "install" {
		if target.Kind == "cli" {
			installedPath = ResolveProviderCLIPath(target.Provider, opts)
		} else {
			installedRecord = FindDesktopClientRecord(ctx, target.Provider, opts)
		}
	}
	plans := ResolveLifecyclePlans(target.Provider, target.Kind, target.Action, opts, installedPath, installedRecord)
	if len(plans) == 0 {
		if target.Action == "install" && target.Kind == "desktop" {
			return lifecycleOutcome{err: BuildDesktopInstallHint(target.Provider, opts)}
		}
		return lifecycleOutcome{err: "应用生命周期配置异常，请刷新资源清单后重试。"}
	}
	// 与 CLI 的 --proxy 契约一致：Windows 官方安装器无法保证全部下载走代理时
	// 直接失败，不能把「设置了代理」静默变成直连。
	// Windows 上「设了代理」必须真的走代理。判定按计划类型而不是 kind——
	// 先前只看 kind=cli，桌面端与 winget 全部漏掉。
	//
	// 语义是「跳过不可代理的计划」而不是整体拒绝：同一个 provider 的 Windows
	// 计划常是 PowerShell / cmd / winget 混合列表，逐条尝试。把 winget 剔掉后
	// 剩下的计划仍能完成安装；若全被剔掉才如实失败。
	// 真机实测：winget 既不读 HTTP(S)_PROXY 也不读 DefaultWebProxy，死代理下
	// 仍能访问源——它是唯一不可代理的一类。
	if proxyActive && resolvePlatform(opts) == platformWindows {
		kept := make([]LifecyclePlan, 0, len(plans))
		var skipped []string
		for _, plan := range plans {
			if planHonorsProxy(plan) {
				kept = append(kept, plan)
				continue
			}
			skipped = append(skipped, nonEmpty(plan.Label, plan.ID))
		}
		if len(kept) == 0 {
			return lifecycleOutcome{err: fmt.Sprintf("%v: 此 Windows 安装器（%s）不能保证所有下载使用代理；请改用支持代理的官方原生命令，不会修改系统代理或回落直连", ErrEgressUnsupported, strings.Join(skipped, "、"))}
		}
		if len(skipped) > 0 {
			m.updateProgress(jobID, 10, "已跳过不支持代理的安装器："+strings.Join(skipped, "、"))
		}
		plans = kept
	}

	var errs []string
	for _, plan := range plans {
		m.updateProgress(jobID, 15, nonEmpty(plan.Label, "正在执行"+lifecycleActionLabel(target.Action)+"计划"))
		attempt, resultView, ok := m.executeSinglePlan(ctx, target, plan, opts)
		pct := 70
		if ok {
			pct = 85
		}
		m.appendAttempt(jobID, attempt, pct, nonEmpty(attempt.Label, plan.Label))
		if ok {
			return lifecycleOutcome{ok: true, result: resultView}
		}
		if attempt.Error != "" {
			errs = append(errs, attempt.Error)
		}
	}
	if len(errs) > 0 {
		return lifecycleOutcome{err: strings.Join(errs, "; ")}
	}
	return lifecycleOutcome{err: "安装完成后未检测到目标应用。"}
}

// runWithAutoEgress 直连失败于网络层后，按服务端候选顺序启用并轮换受管出口。
//
// 与 CLI 入口共用 updateproxy.RetryWithEgress：判定「什么算网络失败」、试过哪个
// 出口、谁负责释放租约都只有一份实现。作业已在自己的 goroutine 里运行，因此
// 这里申请租约不会阻塞 HTTP 请求。
func (m *JobManager) runWithAutoEgress(
	ctx context.Context,
	jobID string,
	target *InstallTarget,
	opts Options,
) lifecycleOutcome {
	provider := m.baseOpts.EgressAutoProxy
	if provider == nil {
		return m.runLifecyclePlans(ctx, jobID, target, opts, false)
	}
	rotation := provider(func(message string) {
		// 轮换告知必须同时进 attempts 与进度：进度 label 会被后续计划覆盖，
		// 只写进度的话用户在任务队列里看不到「用了哪个出口」；attempts 是
		// 追加式的，能看到完整序列。
		text := strings.TrimPrefix(strings.TrimSpace(message), "[aih] ")
		if text == "" {
			return
		}
		m.appendAttempt(jobID, AttemptView{ID: "egress", Label: text, OK: true}, 0, text)
	})
	outcome, used, err := updateproxy.RetryWithEgress(
		ctx, rotation, defaultAutoEgressAttempts,
		func(runErr error) (string, bool) {
			return providercliupgrade.EgressFailureReason(runErr.Error())
		},
		func(proxyURL string) (lifecycleOutcome, error) {
			runOpts := opts
			if proxyURL != "" {
				proxyEnv, envErr := updateproxy.Environment(runOpts.Env, proxyURL)
				if envErr != nil {
					return lifecycleOutcome{}, envErr
				}
				runOpts.Env = proxyEnv
			}
			result := m.runLifecyclePlans(ctx, jobID, target, runOpts, proxyURL != "")
			if result.ok {
				return result, nil
			}
			return result, errors.New(result.err)
		},
	)
	if err != nil {
		// planErr 保留最后一轮的原始失败文案；err 额外带上了自动代理的说明。
		if outcome.err == "" {
			return lifecycleOutcome{err: err.Error()}
		}
		return lifecycleOutcome{err: outcome.err + "；" + err.Error()}
	}
	if used.Name != "" {
		// 作业视图的 Proxy 建单时来自用户输入，自动出口是后来才定的：
		// 不回写的话任务队列会显示「未使用代理」，与事实不符。
		m.noteJobProxy(jobID, used.Name, used.Identity)
		m.updateProgress(jobID, 90, "经代理 "+used.Name+" 完成")
	}
	return outcome
}

// noteJobProxy 把实际使用的出口写进作业视图，并回写健康账本。
//
// 回写让下一次自动代理能从「上次成功的出口」开始，而不是永远按同一顺序试探；
// 它复用账本既有的 uses/successes 事实，不新增存储。
func (m *JobManager) noteJobProxy(jobID string, name string, identity string) {
	display := strings.Join(strings.Fields(name), " ")
	nowMs := m.nowTime().UnixMilli()
	m.mu.Lock()
	entry := m.jobs[jobID]
	if entry != nil {
		entry.job.Proxy = display
		entry.job.UpdatedAt = nowMs
	}
	m.mu.Unlock()
	if m.baseOpts.RecordEgressOutcome != nil {
		m.baseOpts.RecordEgressOutcome(name, identity, true, "")
	}
}

func (m *JobManager) executeSinglePlan(ctx context.Context, target *InstallTarget, plan LifecyclePlan, opts Options) (AttemptView, *JobResultView, bool) {
	if target.Provider == "codex" && target.Kind == "cli" && target.Action != "uninstall" {
		return executeCodexRuntimePlan(ctx, target, plan, opts)
	}
	timeout := plan.Timeout
	if timeout <= 0 {
		timeout = defaultPlanExecTimeout
	}
	// 安装脚本依赖的 jq 可能被宿主 PATH 里的坏副本挡住（见 jq_path.go）。
	plan = withUsableJQScript(ctx, plan, opts)
	execEnv := mergePlanEnv(opts.Env, plan.Env)
	execEnv = withUsableJQPath(ctx, execEnv, opts)
	res := runCodexNPMPlan(ctx, plan, opts, planExecOptions(timeout, opts.Env, plan.Env))
	// 镜像同步滞后时 npm 会报 notarget/ETARGET（包或版本还没同步）；同一计划
	// 换官方源再跑一次，避免「镜像少一个版本就让整个 CLI 装不上」。
	if !res.OK && npmResolutionFailure(res) {
		if fallback, ok := planWithOfficialNPMRegistry(plan); ok {
			plan = fallback
			execEnv = mergePlanEnv(opts.Env, plan.Env)
			execEnv = withUsableJQPath(ctx, execEnv, opts)
			res = runCodexNPMPlan(ctx, plan, opts, planExecOptions(timeout, opts.Env, plan.Env))
		}
	}
	attempt := AttemptView{
		ID:    plan.ID,
		Label: plan.Label,
		OK:    res.OK,
	}
	if !res.OK {
		attempt.Error = truncateJobString(formatExecFailure(res), 500)
		return attempt, nil, false
	}

	if target.Kind == "desktop" {
		verifyOpts := opts
		if target.Action != "uninstall" {
			if markerPath := extractInstalledPath(res); markerPath != "" {
				verifyOpts.InstalledPath = markerPath
			}
		} else {
			verifyOpts.InstalledPath = ""
		}
		rec := m.verifyDesktopWithRetry(ctx, target.Provider, verifyOpts)
		if target.Action == "uninstall" {
			if rec != nil {
				attempt.OK = false
				attempt.Error = "卸载命令已完成，但目标 Desktop 应用仍可被探测到。"
				return attempt, nil, false
			}
			return attempt, &JobResultView{Installed: false}, true
		}
		if rec == nil {
			attempt.OK = false
			attempt.Error = lifecycleActionLabel(target.Action) + "命令已完成，但未检测到目标 Desktop 应用。"
			return attempt, nil, false
		}
		execPath := nonEmpty(rec.ExecutablePath, rec.DisplayPath)
		return attempt, &JobResultView{Installed: true, ExecutablePath: execPath}, true
	}

	cliPath := ResolveProviderCLIPath(target.Provider, opts)
	if target.Provider == "codex" {
		var resolveErr error
		cliPath, resolveErr = resolveOfficialCodex(opts)
		if resolveErr != nil {
			var typed *providercli.CodexBinaryError
			missing := errors.As(resolveErr, &typed) && typed.Code == providercli.CodeCodexOfficialCLIMissing
			if target.Action != "uninstall" || !missing {
				attempt.OK, attempt.Error = false, resolveErr.Error()
				return attempt, nil, false
			}
		}
	}
	if target.Action == "uninstall" {
		if cliPath != "" {
			attempt.OK = false
			attempt.Error = "卸载命令已完成，但 CLI 仍可被探测到。"
			return attempt, nil, false
		}
		return attempt, &JobResultView{Installed: false}, true
	}
	if cliPath == "" {
		attempt.OK = false
		attempt.Error = lifecycleActionLabel(target.Action) + "命令已完成，但 CLI 校验失败。"
		return attempt, nil, false
	}
	if target.Provider == "codex" && probeCLIBinaryVersion(ctx, cliPath, opts) == "" {
		attempt.OK = false
		attempt.Error = lifecycleActionLabel(target.Action) + "命令已完成，但官方 Codex CLI 无法运行或版本校验失败。"
		return attempt, nil, false
	}
	return attempt, &JobResultView{Installed: true, CLIPath: cliPath}, true
}

func (m *JobManager) checkCLIMinNodeVersion(ctx context.Context, cli *cliDescriptor, opts Options) (*AttemptView, string) {
	if cli == nil || strings.TrimSpace(cli.MinNodeVersion) == "" {
		return nil, ""
	}
	required, ok := parseVersionTuple(cli.MinNodeVersion)
	if !ok {
		return nil, ""
	}
	nodeVerText := strings.TrimSpace(opts.NodeVersion)
	if nodeVerText == "" {
		nodeCmd := strings.TrimSpace(opts.NodeExecPath)
		if nodeCmd == "" {
			nodeCmd = "node"
		}
		res := (&opts).exec().Run(ctx, nodeCmd, []string{"--version"}, environment.ExecOptions{
			Timeout: 3 * time.Second,
			Env:     opts.Env,
		})
		if res.OK {
			nodeVerText = strings.TrimSpace(res.Stdout)
		}
	}
	current, ok := parseVersionTuple(nodeVerText)
	if !ok {
		return nil, ""
	}
	for i := 0; i < 3; i++ {
		if current[i] > required[i] {
			return nil, ""
		}
		if current[i] < required[i] {
			need := fmt.Sprintf("%d.%d.%d", required[0], required[1], required[2])
			have := fmt.Sprintf("%d.%d.%d", current[0], current[1], current[2])
			msg := fmt.Sprintf("需要 Node %s 或更高版本，当前是 %s。请先升级 Node（例如 nvm install 22 && nvm alias default 22），再重启 aih server 后重试。", need, have)
			return &AttemptView{
				ID:    "node_version_gate",
				Label: fmt.Sprintf("检查 Node 版本（需要 ≥ %s）", need),
				OK:    false,
				Error: msg,
			}, msg
		}
	}
	return nil, ""
}

func (m *JobManager) runLegacyNpmCleanup(ctx context.Context, jobID string, pkgs []string, opts Options) AttemptView {
	var failures []string
	for _, pkg := range pkgs {
		plan := buildNpmUninstallPlan(pkg, opts)
		if plan.Command == "" {
			continue
		}
		m.updateProgress(jobID, 10, plan.Label)
		res := (&opts).exec().Run(ctx, plan.Command, plan.Args, planExecOptions(packagePlanTimeout, opts.Env, plan.Env))
		if !res.OK {
			failures = append(failures, pkg+": "+truncateJobString(formatExecFailure(res), 200))
		}
	}
	return AttemptView{
		ID:    "legacy_npm_cleanup",
		Label: "移除上一代 npm 包（" + strings.Join(pkgs, ", ") + "）",
		OK:    true,
		Error: truncateJobString(strings.Join(failures, "; "), 500),
	}
}

func (m *JobManager) verifyDesktopWithRetry(ctx context.Context, provider string, opts Options) *DesktopRecord {
	var rec *DesktopRecord
	for attempt := 0; attempt < m.verifyRetries; attempt++ {
		rec = FindDesktopClientRecord(ctx, provider, opts)
		if rec != nil {
			return rec
		}
		if attempt+1 < m.verifyRetries && m.verifyRetryDelay > 0 {
			if opts.Sleep != nil {
				_ = opts.Sleep(ctx, m.verifyRetryDelay)
			} else {
				timer := time.NewTimer(m.verifyRetryDelay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return rec
				case <-timer.C:
				}
			}
		}
	}
	return rec
}

// resolveInstallProxy 把选择器换成任务期 HTTP(S) 代理。
//
// 分类边界：含 "://" 的输入是调用方给出的 URL；其余值必须由 ProxyResolver
// 在本机换取租约（CLI 用管理面 lease，WebUI 作业用进程内 LeaseManager）。
func (m *JobManager) resolveInstallProxy(ctx context.Context, selector string) (string, string, func(), string, string) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return "", "", nil, "", ""
	}
	proxyURL := selector
	name := ""
	var release func()
	if !strings.Contains(selector, "://") {
		if m.baseOpts.ProxyResolver == nil {
			return "", "", nil, "proxy_selector_unsupported",
				"当前 Server 不支持命名代理选择器；请改用 HTTP(S) 代理 URL 或直连。"
		}
		lease, err := m.baseOpts.ProxyResolver(ctx, selector)
		if err != nil {
			return "", "", nil, "proxy_unavailable", err.Error()
		}
		proxyURL, name, release = lease.URL, lease.Name, lease.Release
	}
	if _, err := updateproxy.Environment(nil, proxyURL); err != nil {
		if release != nil {
			release()
		}
		return "", "", nil, "invalid_proxy", err.Error()
	}
	return proxyURL, name, release, "", ""
}

func (m *JobManager) releaseJobProxy(jobID string) {
	m.mu.Lock()
	entry := m.jobs[jobID]
	var release func()
	if entry != nil {
		release = entry.release
		entry.release = nil
	}
	m.mu.Unlock()
	if release != nil {
		release()
	}
}

// installProxyLabel 只用于展示：命名代理显示名称，URL 去掉凭据。
func installProxyLabel(input InstallInput) string {
	if strings.TrimSpace(input.ProxyName) != "" {
		return input.ProxyName
	}
	raw := strings.TrimSpace(input.Proxy)
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, "://") {
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "自定义代理"
	}
	parsed.User = nil
	return parsed.String()
}

func (m *JobManager) finalizeJob(jobID string, target *InstallTarget, succeeded bool, result *JobResultView, errMsg string) {
	nowMs := m.nowTime().UnixMilli()
	m.mu.Lock()
	entry := m.jobs[jobID]
	if entry == nil {
		m.mu.Unlock()
		return
	}
	if entry.job.Status == "cancelled" {
		delete(m.activeByTarget, target.Key)
		m.mu.Unlock()
		return
	}
	if succeeded {
		entry.job.Status = "succeeded"
		entry.job.Phase = "completed"
		entry.job.Result = result
		entry.job.Error = ""
		entry.job.Progress = JobProgress{
			Percent: 100,
			Label:   lifecycleActionLabel(target.Action) + "完成",
		}
	} else {
		entry.job.Status = "failed"
		entry.job.Phase = "failed"
		entry.job.Error = truncateJobString(nonEmpty(errMsg, "安装完成后未检测到目标应用。"), 500)
		entry.job.Progress.Label = nonEmpty(entry.job.Error, lifecycleActionLabel(target.Action)+"失败")
	}
	entry.job.UpdatedAt = nowMs
	entry.job.FinishedAt = &nowMs
	delete(m.activeByTarget, target.Key)
	snap := cloneAppJobView(entry.job)
	m.mu.Unlock()

	if m.manager != nil {
		m.manager.InvalidateCache("")
	}
	m.notify(snap)
}

func (m *JobManager) updateProgress(jobID string, minPercent int, label string) {
	nowMs := m.nowTime().UnixMilli()
	m.mu.Lock()
	entry := m.jobs[jobID]
	if entry == nil || entry.job.Status == "cancelled" {
		m.mu.Unlock()
		return
	}
	if minPercent > entry.job.Progress.Percent {
		entry.job.Progress.Percent = clampPercent(minPercent)
	}
	if strings.TrimSpace(label) != "" {
		entry.job.Progress.Label = label
	}
	entry.job.UpdatedAt = nowMs
	snap := cloneAppJobView(entry.job)
	m.mu.Unlock()
	m.notify(snap)
}

func (m *JobManager) appendAttempt(jobID string, attempt AttemptView, percent int, label string) {
	nowMs := m.nowTime().UnixMilli()
	m.mu.Lock()
	entry := m.jobs[jobID]
	if entry == nil || entry.job.Status == "cancelled" {
		m.mu.Unlock()
		return
	}
	attempt.Error = truncateJobString(strings.TrimSpace(attempt.Error), 500)
	entry.job.Attempts = append(entry.job.Attempts, attempt)
	if percent > 0 {
		entry.job.Progress.Percent = clampPercent(percent)
	}
	if strings.TrimSpace(label) != "" {
		entry.job.Progress.Label = label
	}
	entry.job.UpdatedAt = nowMs
	snap := cloneAppJobView(entry.job)
	m.mu.Unlock()
	m.notify(snap)
}

func (m *JobManager) notify(job JobView) {
	ev := JobEvent{Type: "install-job", Job: &job}
	m.mu.Lock()
	cb := m.onJobChanged
	var perJob []chan JobEvent
	for ch := range m.watchers[job.ID] {
		perJob = append(perJob, ch)
	}
	var all []chan JobEvent
	for ch := range m.allWatchers {
		all = append(all, ch)
	}
	m.mu.Unlock()

	if cb != nil {
		cb(cloneAppJobView(job))
	}
	for _, ch := range perJob {
		select {
		case ch <- ev:
		default:
		}
	}
	for _, ch := range all {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (m *JobManager) pruneLocked() {
	cutoff := m.nowTime().Add(-jobRetention).UnixMilli()
	for id, entry := range m.jobs {
		if entry == nil || !isJobTerminalStatus(entry.job.Status) {
			continue
		}
		if entry.job.FinishedAt != nil && *entry.job.FinishedAt <= cutoff {
			delete(m.jobs, id)
		}
	}
}

func cloneAppJobView(src JobView) JobView {
	out := src
	out.Attempts = append([]AttemptView{}, src.Attempts...)
	if src.Result != nil {
		r := *src.Result
		out.Result = &r
	}
	if src.FinishedAt != nil {
		f := *src.FinishedAt
		out.FinishedAt = &f
	}
	return out
}

func extractInstalledPath(res environment.RunResult) string {
	if p := extractInstalledPathFromText(res.Stdout); p != "" {
		return p
	}
	return extractInstalledPathFromText(res.Stderr)
}

func extractInstalledPathFromText(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, installedPathMarker) {
			continue
		}
		val := strings.TrimSpace(strings.TrimPrefix(line, installedPathMarker))
		val = strings.Trim(val, `"`)
		if val != "" {
			return val
		}
	}
	return ""
}

func mergePlanEnv(baseEnv, planEnv map[string]string) map[string]string {
	if len(baseEnv) == 0 && len(planEnv) == 0 {
		return nil
	}
	merged := make(map[string]string, len(baseEnv)+len(planEnv))
	for k, v := range baseEnv {
		merged[k] = v
	}
	for k, v := range planEnv {
		merged[k] = v
	}
	// Windows 上 ALL_PROXY 必须真正消失，而不是被设成空串（见
	// updateproxy.UnsetForTask）。注意 npmPlanEnv 会为 npm 显式置空一批代理
	// 变量——npm 认空串，但同一个进程环境里 curl 见到 ALL_PROXY="" 就会失败，
	// 所以这里对有凭据/为空的值一律删除，只保留真正有效的 HTTP(S)_PROXY。
	for _, key := range updateproxy.UnsetForTask(merged) {
		delete(merged, key)
	}
	return merged
}

// planExecOptions 构建一次生命周期计划的执行参数。
//
// 所有安装/更新计划的执行都必须走这里：Env 与 UnsetEnv 的搭配只有这一处推导，
// 避免再出现「某个分支记得清 ALL_PROXY、另一个分支忘了」。
func planExecOptions(timeout time.Duration, baseEnv, planEnv map[string]string) environment.ExecOptions {
	merged := mergePlanEnv(baseEnv, planEnv)
	return environment.ExecOptions{
		Timeout:  timeout,
		Env:      merged,
		UnsetEnv: updateproxy.UnsetForTask(merged),
	}
}

// planHonorsProxy 判断一条 Windows 计划能否保证所有下载走任务期代理。
//
// 分三类（真机实测结论）：
//   - npm.cmd        ：读 npm_config_proxy / HTTP(S)_PROXY —— 可代理
//   - cmd.exe + curl ：curl 读 HTTPS_PROXY —— 可代理（ALL_PROXY 已按平台移除）
//   - powershell.exe ：计划里已注入 DefaultWebProxy + Credentials —— 可代理
//   - winget.exe     ：两者都不读，死代理下仍直连 —— 不可代理
//
// 其它（原生 exe 安装器、msiexec 等）一律按不可代理处理：宁可明确拒绝，
// 也不能让用户以为走了代理。
func planHonorsProxy(plan LifecyclePlan) bool {
	switch strings.ToLower(filepath.Base(strings.TrimSpace(plan.Command))) {
	case "npm", "npm.cmd":
		return true
	case "cmd", "cmd.exe":
		// 我们的 cmd 计划用 curl 下载；凭据在 HTTPS_PROXY 里，curl 认。
		for _, arg := range plan.Args {
			if strings.Contains(arg, "curl") {
				return true
			}
		}
		return false
	case "powershell", "powershell.exe", "pwsh", "pwsh.exe":
		for _, arg := range plan.Args {
			if strings.Contains(arg, "DefaultWebProxy") {
				return true
			}
		}
		return false
	default:
		return false
	}
}

func formatExecFailure(res environment.RunResult) string {
	if msg := strings.TrimSpace(res.Message); msg != "" {
		return msg
	}
	if errText := strings.TrimSpace(res.Stderr); errText != "" {
		return errText
	}
	if outText := strings.TrimSpace(res.Stdout); outText != "" {
		return outText
	}
	if res.ExitCode != nil {
		return fmt.Sprintf("exit_%d", *res.ExitCode)
	}
	return "execution_failed"
}

func clampPercent(p int) int {
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

func truncateJobString(s string, maxLen int) string {
	if maxLen <= 0 || len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
