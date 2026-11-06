package accountauth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// serviceSettings 允许包内测试缩短时间并压低容量，不扩大生产配置面。
type serviceSettings struct {
	jobTTL            time.Duration
	terminalRetention time.Duration
	maxJobs           int
}

// jobRecord 保存公开快照与只在 pending 状态存在的私有 Flow。
type jobRecord struct {
	job           Job
	flow          OAuthFlow
	retainedUntil time.Time
	// done 在 pending 被改写成 processing 时创建、进入终态时关闭。
	// 同一 Job 的并发 Complete 靠它等待唯一执行者的终态结果，
	// 而不是把「已在处理」误报成 job_not_pending。
	done chan struct{}
}

// Service 是并发安全、有界的 OAuth Job 编排器。
//
// Job 的私有 Flow 只存在于内存；公开快照在 jobStore 非空时同步落库，
// 使进程重启后仍能查到终态结果。
type Service struct {
	mu         sync.Mutex
	providers  map[string]OAuthProvider
	jobs       map[string]*jobRecord
	activeJobs map[string]string
	decoder    NativeAccountDecoder
	registrar  Registrar
	reauth     Reauthenticator
	clock      Clock
	generateID IDGenerator
	jobStore   JobStore
	settings   serviceSettings
}

// NewService 创建只支持 Codex、Claude 且使用生产边界的 OAuth Job 服务。
func NewService(dependencies Dependencies) (*Service, error) {
	return newService(dependencies, serviceSettings{
		jobTTL:            DefaultJobTTL,
		terminalRetention: DefaultTerminalRetention,
		maxJobs:           DefaultMaxJobs,
	})
}

// newService 校验策略注册表及所有有界状态参数。
func newService(
	dependencies Dependencies,
	settings serviceSettings,
) (*Service, error) {
	if dependencies.Decoder == nil ||
		dependencies.Registrar == nil ||
		dependencies.Reauth == nil ||
		dependencies.Clock == nil ||
		dependencies.GenerateID == nil ||
		settings.jobTTL <= 0 ||
		settings.terminalRetention <= 0 ||
		settings.maxJobs < 2 {
		return nil, ErrInvalidDependencies
	}
	providerRegistry := make(map[string]OAuthProvider, len(dependencies.Providers))
	for _, provider := range dependencies.Providers {
		if provider == nil {
			return nil, ErrInvalidDependencies
		}
		providerID := provider.ProviderID()
		if !isSupportedProvider(providerID) {
			return nil, ErrUnsupportedProvider
		}
		if _, duplicated := providerRegistry[providerID]; duplicated {
			return nil, ErrInvalidDependencies
		}
		providerRegistry[providerID] = provider
	}
	if len(providerRegistry) != 2 ||
		providerRegistry["codex"] == nil ||
		providerRegistry["claude"] == nil {
		return nil, ErrInvalidDependencies
	}
	return &Service{
		providers:  providerRegistry,
		jobs:       make(map[string]*jobRecord),
		activeJobs: make(map[string]string),
		decoder:    dependencies.Decoder,
		registrar:  dependencies.Registrar,
		reauth:     dependencies.Reauth,
		clock:      dependencies.Clock,
		generateID: dependencies.GenerateID,
		jobStore:   dependencies.JobStore,
		settings:   settings,
	}, nil
}

// NewRandomJobID 使用 128 位系统随机数创建不可预测的十六进制 Job ID。
func NewRandomJobID() (string, error) {
	var randomBytes [16]byte
	if _, err := rand.Read(randomBytes[:]); err != nil {
		return "", ErrInvalidDependencies
	}
	return hex.EncodeToString(randomBytes[:]), nil
}

// Start 创建一个等待回调的 Provider OAuth Job。
func (service *Service) Start(
	ctx context.Context,
	request StartRequest,
) (StartResult, error) {
	if request.ProviderID == "" ||
		(request.TargetAccountRef != "" &&
			!request.TargetAccountRef.IsValid()) {
		return StartResult{}, ErrInvalidStartRequest
	}
	provider, found := service.providers[request.ProviderID]
	if !found {
		return StartResult{}, ErrUnsupportedProvider
	}
	if request.Purpose() == PurposeReauth {
		if err := service.reauth.ValidateTarget(
			ctx,
			request.TargetAccountRef,
			request.ProviderID,
		); err != nil {
			return StartResult{}, err
		}
	}
	if err := service.checkStartCapacity(request.ProviderID); err != nil {
		return StartResult{}, err
	}
	flow, err := provider.Begin(ctx)
	if err != nil {
		return StartResult{}, err
	}
	if flow == nil || !validAuthorizationURL(flow.AuthorizationURL()) {
		return StartResult{}, ErrInvalidDependencies
	}
	jobID, err := service.generateID()
	if err != nil || !validJobID(jobID) {
		return StartResult{}, ErrInvalidDependencies
	}
	now := service.now()

	service.mu.Lock()
	defer service.mu.Unlock()
	service.expireAndPruneLocked(now)
	if _, active := service.activeJobs[request.ProviderID]; active {
		return StartResult{}, ErrActiveJobExists
	}
	service.evictTerminalJobsLocked()
	if len(service.jobs) >= service.settings.maxJobs {
		return StartResult{}, ErrJobCapacity
	}
	if _, duplicated := service.jobs[jobID]; duplicated {
		return StartResult{}, ErrInvalidDependencies
	}
	job := Job{
		id:         jobID,
		providerID: request.ProviderID,
		purpose:    request.Purpose(),
		targetRef:  request.TargetAccountRef,
		status:     StatusPending,
		createdAt:  now,
		expiresAt:  now.Add(service.settings.jobTTL),
	}
	service.jobs[jobID] = &jobRecord{job: job, flow: flow}
	service.activeJobs[request.ProviderID] = jobID
	service.persistJobLocked(job, now)
	return StartResult{
		job:              job,
		authorizationURL: flow.AuthorizationURL(),
	}, nil
}

// checkStartCapacity 在生成 OAuth 私有值前快速拒绝重复 Provider 和满容量请求。
func (service *Service) checkStartCapacity(providerID string) error {
	now := service.now()
	service.mu.Lock()
	defer service.mu.Unlock()
	service.expireAndPruneLocked(now)
	if _, active := service.activeJobs[providerID]; active {
		return ErrActiveJobExists
	}
	service.evictTerminalJobsLocked()
	if len(service.jobs) >= service.settings.maxJobs {
		return ErrJobCapacity
	}
	return nil
}

// Get 返回当前 Job 的公开快照，并惰性执行过期和终态清理。
//
// 该方法是 HTTP 端口要求的无 context 形式，内部委托给 GetJob。
func (service *Service) Get(jobID string) (Job, error) {
	return service.GetJob(context.Background(), jobID)
}

// GetJob 返回 Job 的公开快照；内存中已经清理的终态回落到持久化快照。
func (service *Service) GetJob(ctx context.Context, jobID string) (Job, error) {
	now := service.now()
	service.mu.Lock()
	service.expireAndPruneLocked(now)
	record, found := service.jobs[jobID]
	var job Job
	if found {
		job = record.job
	}
	// 先释放锁再读库：存储实现涉及磁盘 IO，不能让它阻塞其他 Job 的状态迁移。
	service.mu.Unlock()
	if found {
		return job, nil
	}
	return service.getStoredJob(ctx, jobID)
}

// getStoredJob 在内存未命中时读取持久化快照。
func (service *Service) getStoredJob(ctx context.Context, jobID string) (Job, error) {
	if service.jobStore == nil {
		return Job{}, ErrJobNotFound
	}
	record, found, err := service.jobStore.GetJob(ctx, jobID)
	if err != nil {
		// 存储故障不能伪装成「Job 不存在」：那会让客户端误以为可以重新发起，
		// 也会掩盖真实的 aih.db 故障。
		return Job{}, fmt.Errorf("读取 OAuth Job 快照失败: %w", err)
	}
	if !found {
		return Job{}, ErrJobNotFound
	}
	job := jobFromRecord(record)
	if !job.IsTerminal() {
		// pending/processing 的 state、PKCE 与 Flow 只存在于上一个进程的内存里，
		// 重启后不可能再完成；返回它们只会让客户端无限等待。
		return Job{}, ErrJobNotFound
	}
	return job, nil
}

// Rehydrate 在进程启动时收敛上一次运行遗留的 Job。
//
// state、PKCE verifier 与 OAuthFlow 只存在于内存，重启后这些 Job 无法再接受回调；
// 因此必须把 pending/processing 从「等待中」改成 expired，避免客户端继续轮询一个
// 永远不会推进的 Job。存储返回的更新条数只用于日志，不参与控制流。
func (service *Service) Rehydrate(ctx context.Context) error {
	if service.jobStore == nil {
		return nil
	}
	expired, err := service.jobStore.ExpirePendingJobs(ctx, service.now())
	if err != nil {
		return fmt.Errorf("收敛遗留 OAuth Job 失败: %w", err)
	}
	if expired > 0 {
		log.Printf("accountauth: 已将 %d 个遗留 OAuth Job 标记为过期", expired)
	}
	return nil
}

// Complete 唯一领取回调，换取官方 artifact，并复用统一账号注册链。
//
// 该方法对同一 Job 的重复调用是幂等的：只有 pending 的第一次调用会真正执行
// token 交换与账号写入；已 completed 的 Job 直接回放 account_ref、
// cli_account_id 等既有结果，已 failed 的 Job 回放同一失败码，都不会产生第二次
// 副作用。网络重试、浏览器重复命中回调都依赖这个语义。
func (service *Service) Complete(
	ctx context.Context,
	jobID string,
	callback string,
) (Job, error) {
	claim, err := service.claimCompletion(ctx, jobID)
	if err != nil {
		return Job{}, err
	}
	if !claim.claimed {
		return claim.replay, nil
	}
	claimed := claim.job
	artifacts, err := claimed.flow.Exchange(ctx, callback)
	if err != nil {
		return service.failJob(jobID, failureCode(err)), err
	}
	defer clearBytes(artifacts)
	credential, profile, err := service.decoder.Decode(
		claimed.providerID,
		artifacts,
	)
	if err != nil {
		failed := service.failJob(jobID, "invalid_artifacts")
		return failed, errors.Join(ErrInvalidArtifacts, err)
	}
	account, err := service.persistAccount(
		ctx,
		claimed,
		credential,
		profile,
	)
	if err != nil {
		return service.failJob(jobID, accountWriteFailureCode(err)), err
	}

	now := service.now()
	service.mu.Lock()
	defer service.mu.Unlock()
	record, found := service.jobs[jobID]
	if !found || record.job.status != StatusProcessing {
		return Job{}, ErrJobNotFound
	}
	record.job.status = StatusCompleted
	record.job.finishedAt = now
	record.job.accountRef = account.Ref()
	record.job.cliAccountID = account.CLIAccountID()
	record.retainedUntil = now.Add(service.settings.terminalRetention)
	delete(service.activeJobs, claimed.providerID)
	finishProcessingLocked(record)
	service.persistJobLocked(record.job, now)
	return record.job, nil
}

// persistAccount 按 Job 意图选择新账号注册或同账号原子重新认证。
func (service *Service) persistAccount(
	ctx context.Context,
	claimed claimedJob,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	switch claimed.purpose {
	case PurposeRegister:
		return service.registrar.Register(ctx, credential, profile)
	case PurposeReauth:
		return service.reauth.Reauthenticate(
			ctx,
			claimed.targetRef,
			credential,
			profile,
		)
	default:
		return accountcore.Account{}, ErrInvalidStartRequest
	}
}

// Cancel 只取消尚未被回调消费者领取的 pending Job。
func (service *Service) Cancel(jobID string) (Job, error) {
	now := service.now()
	service.mu.Lock()
	defer service.mu.Unlock()
	service.expireAndPruneLocked(now)
	record, found := service.jobs[jobID]
	if !found {
		return Job{}, ErrJobNotFound
	}
	if record.job.status == StatusExpired {
		return record.job, ErrJobExpired
	}
	if record.job.status != StatusPending {
		return record.job, ErrJobNotPending
	}
	record.job.status = StatusCancelled
	record.job.finishedAt = now
	record.job.failureCode = "cancelled"
	record.flow = nil
	record.retainedUntil = now.Add(service.settings.terminalRetention)
	delete(service.activeJobs, record.job.providerID)
	service.persistJobLocked(record.job, now)
	return record.job, nil
}

// completionClaim 是一次 Complete 状态 CAS 的结果。
//
// claimed 为 true 表示当前调用者把 pending 改写成 processing，成为唯一执行者；
// 否则 replay 是已有终态快照，调用者直接返回它，不碰 token 端点也不写账号。
type completionClaim struct {
	job     claimedJob
	replay  Job
	claimed bool
}

// claimCompletion 在 service.mu 内按 Job 状态做比较并交换。
//
// 状态机只有一条写入边：pending → processing。completed / failed 是回放分支，
// processing 则等待唯一执行者关闭 done。这样两个并发 Complete 只有一个能拿到
// Flow 并执行副作用，另一个在 done 关闭后读取同一份终态快照。
func (service *Service) claimCompletion(
	ctx context.Context,
	jobID string,
) (completionClaim, error) {
	now := service.now()
	service.mu.Lock()
	service.expireAndPruneLocked(now)
	record, found := service.jobs[jobID]
	if !found {
		service.mu.Unlock()
		return completionClaim{}, ErrJobNotFound
	}
	switch record.job.status {
	case StatusCompleted, StatusFailed:
		// 失败也要幂等回放：客户端重试不该改变结果。第一次失败已经收敛成
		// 稳定 failure_code，再次返回同一个错误会让调用方以为发生了新失败，
		// 也无法保证原始错误在所有重试路径上可重建；统一回放终态快照，
		// 让调用方像 Get 一样读 Status/FailureCode。
		replay := record.job
		service.mu.Unlock()
		return completionClaim{replay: replay}, nil
	case StatusProcessing:
		done := record.done
		service.mu.Unlock()
		if done == nil {
			// 没有等待信号的 processing 只可能来自旧版本内存状态，无法安全跟随。
			return completionClaim{}, ErrJobNotPending
		}
		select {
		case <-done:
		case <-ctx.Done():
			return completionClaim{}, ctx.Err()
		}
		service.mu.Lock()
		if !record.job.IsTerminal() {
			service.mu.Unlock()
			return completionClaim{}, ErrJobNotPending
		}
		replay := record.job
		service.mu.Unlock()
		return completionClaim{replay: replay}, nil
	case StatusPending:
		if record.flow == nil {
			service.mu.Unlock()
			return completionClaim{}, ErrJobNotPending
		}
		claimed := claimedJob{
			flow:       record.flow,
			providerID: record.job.providerID,
			purpose:    record.job.purpose,
			targetRef:  record.job.targetRef,
		}
		record.flow = nil
		record.job.status = StatusProcessing
		if record.done == nil {
			record.done = make(chan struct{})
		}
		// 领取回调是跨进程可见的分界点：先落 processing，崩溃后重启才能把它收敛为 expired，
		// 而不是让客户端以为 Job 还在等待回调。
		service.persistJobLocked(record.job, now)
		service.mu.Unlock()
		return completionClaim{job: claimed, claimed: true}, nil
	case StatusExpired:
		service.mu.Unlock()
		return completionClaim{}, ErrJobExpired
	default:
		// cancelled 不是可回放的登录结果：它从未开始换取凭据。
		service.mu.Unlock()
		return completionClaim{}, ErrJobNotPending
	}
}

// finishProcessingLocked 唤醒等待同一 Job 的并发 Complete。
//
// 调用方必须持有 service.mu 且已经写入终态，这样被唤醒的调用者读到的
// 一定是 completed/failed，而不会看到半成品。
func finishProcessingLocked(record *jobRecord) {
	if record.done == nil {
		return
	}
	close(record.done)
	record.done = nil
}

// failJob 把 processing Job 收敛为不含内部错误文本的 failed 终态。
func (service *Service) failJob(jobID string, code string) Job {
	now := service.now()
	service.mu.Lock()
	defer service.mu.Unlock()
	record, found := service.jobs[jobID]
	if !found {
		return Job{}
	}
	record.flow = nil
	record.job.status = StatusFailed
	record.job.finishedAt = now
	record.job.failureCode = code
	record.retainedUntil = now.Add(service.settings.terminalRetention)
	delete(service.activeJobs, record.job.providerID)
	finishProcessingLocked(record)
	service.persistJobLocked(record.job, now)
	return record.job
}

// persistJobLocked 把当前公开快照写入持久化存储。
//
// 调用方必须持有 service.mu：这样落库顺序与内存状态迁移顺序一致，迟到的
// pending/processing 快照不会覆盖已经写入的终态。
// 写失败只记日志：可查询性是增强能力，OAuth 主流程不能因为存储故障而失败。
func (service *Service) persistJobLocked(job Job, now time.Time) {
	if service.jobStore == nil {
		return
	}
	// 使用后台 context：状态迁移已经在内存生效，落库不应跟随请求取消而放弃。
	if err := service.jobStore.UpsertJob(context.Background(), job.snapshot(now)); err != nil {
		log.Printf("accountauth: 写入 OAuth Job 快照失败 job=%s: %v", job.id, err)
	}
}

// expireAndPruneLocked 把超时 pending Job 标记为 expired，并删除超过保留期的终态。
func (service *Service) expireAndPruneLocked(now time.Time) {
	for jobID, record := range service.jobs {
		if record.job.status == StatusPending &&
			!now.Before(record.job.expiresAt) {
			record.job.status = StatusExpired
			record.job.finishedAt = now
			record.job.failureCode = "expired"
			record.flow = nil
			record.retainedUntil = now.Add(service.settings.terminalRetention)
			delete(service.activeJobs, record.job.providerID)
			service.persistJobLocked(record.job, now)
		}
		if record.job.IsTerminal() &&
			!record.retainedUntil.IsZero() &&
			!now.Before(record.retainedUntil) {
			delete(service.jobs, jobID)
		}
	}
}

// evictTerminalJobsLocked 在容量紧张时优先删除最早结束的终态，不触碰活动 Job。
func (service *Service) evictTerminalJobsLocked() {
	for len(service.jobs) >= service.settings.maxJobs {
		var oldestID string
		var oldestTime time.Time
		for jobID, record := range service.jobs {
			if !record.job.IsTerminal() {
				continue
			}
			if oldestID == "" || record.job.finishedAt.Before(oldestTime) {
				oldestID = jobID
				oldestTime = record.job.finishedAt
			}
		}
		if oldestID == "" {
			return
		}
		delete(service.jobs, oldestID)
	}
}

// now 统一输出 UTC 且不携带 monotonic 部分的可序列化时间。
func (service *Service) now() time.Time {
	return service.clock().UTC().Round(0)
}

// isSupportedProvider 固定当前已研究完成的 OAuth Provider 边界。
func isSupportedProvider(providerID string) bool {
	return providerID == "codex" || providerID == "claude"
}

// validAuthorizationURL 拒绝非 HTTPS 或缺少主机的 Provider 授权地址。
func validAuthorizationURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		parsed.Scheme == "https" &&
		parsed.Host != "" &&
		parsed.User == nil
}

// validJobID 要求 Job ID 是规范的 128 位小写十六进制字符串。
func validJobID(jobID string) bool {
	if len(jobID) != 32 || strings.ToLower(jobID) != jobID {
		return false
	}
	decoded, err := hex.DecodeString(jobID)
	return err == nil && len(decoded) == 16
}

// clearBytes 尽早覆盖临时 artifact 缓冲区，降低凭据在进程内的驻留时间。
func clearBytes(data []byte) {
	for index := range data {
		data[index] = 0
	}
}

// failureCode 把 Provider 错误收敛为固定公开码，绝不使用上游错误文本。
func failureCode(err error) string {
	switch {
	case errors.Is(err, ErrInvalidCallback):
		return "invalid_callback"
	case errors.Is(err, ErrStateMismatch):
		return "state_mismatch"
	case errors.Is(err, ErrProviderRejected):
		return "provider_rejected"
	case errors.Is(err, ErrInvalidArtifacts):
		return "invalid_artifacts"
	default:
		return "provider_unavailable"
	}
}

// accountWriteFailureCode 保留可行动的注册与 reauth 错误，其余内部错误统一隐藏。
func accountWriteFailureCode(err error) string {
	if errors.Is(err, accountapp.ErrAccountConflict) {
		return "account_conflict"
	}
	if errors.Is(err, accountapp.ErrCLIAccountIDExhausted) {
		return "cli_account_id_exhausted"
	}
	if errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch) {
		return "reauthentication_identity_mismatch"
	}
	if errors.Is(err, accountapp.ErrReauthenticationConflict) {
		return "reauthentication_conflict"
	}
	if errors.Is(err, accountapp.ErrReauthenticationUnsupported) {
		return "reauthentication_unsupported"
	}
	if errors.Is(err, accountapp.ErrAccountNotFound) {
		return "reauthentication_target_not_found"
	}
	if errors.Is(err, accountapp.ErrCredentialNotFound) {
		return "reauthentication_unsupported"
	}
	if errors.Is(err, accountapp.ErrInvalidReauthentication) {
		return "invalid_reauthentication"
	}
	return "account_write_failed"
}

// claimedJob 是 processing 阶段唯一消费者持有的不可变执行上下文。
type claimedJob struct {
	flow       OAuthFlow
	providerID string
	purpose    Purpose
	targetRef  accountcore.AccountRef
}
