package accountauth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
}

// Service 是并发安全、有界且只存在于内存中的 OAuth Job 编排器。
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
func (service *Service) Get(jobID string) (Job, error) {
	now := service.now()
	service.mu.Lock()
	defer service.mu.Unlock()
	service.expireAndPruneLocked(now)
	record, found := service.jobs[jobID]
	if !found {
		return Job{}, ErrJobNotFound
	}
	return record.job, nil
}

// Complete 唯一领取回调，换取官方 artifact，并复用统一账号注册链。
func (service *Service) Complete(
	ctx context.Context,
	jobID string,
	callback string,
) (Job, error) {
	claimed, err := service.claimPendingJob(jobID)
	if err != nil {
		return Job{}, err
	}
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
	return record.job, nil
}

// claimPendingJob 原子把 pending Job 转成 processing，并立即移除容器中的私有 Flow。
func (service *Service) claimPendingJob(
	jobID string,
) (claimedJob, error) {
	now := service.now()
	service.mu.Lock()
	defer service.mu.Unlock()
	service.expireAndPruneLocked(now)
	record, found := service.jobs[jobID]
	if !found {
		return claimedJob{}, ErrJobNotFound
	}
	if record.job.status == StatusExpired {
		return claimedJob{}, ErrJobExpired
	}
	if record.job.status != StatusPending || record.flow == nil {
		return claimedJob{}, ErrJobNotPending
	}
	claimed := claimedJob{
		flow:       record.flow,
		providerID: record.job.providerID,
		purpose:    record.job.purpose,
		targetRef:  record.job.targetRef,
	}
	record.flow = nil
	record.job.status = StatusProcessing
	return claimed, nil
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
	return record.job
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
