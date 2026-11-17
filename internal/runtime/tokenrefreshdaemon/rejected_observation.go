package tokenrefreshdaemon

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const rejectedObservationCapacity = 64

// CurrentCredentialRefresher 是原刷新器的可选代次能力；旧 WithPorts override 无需实现。
// 新的拒收队列不回落到 ref-only 的强刷入口。
type CurrentCredentialRefresher interface {
	ForceRefreshCredentialBindingIfCurrent(context.Context, accountapp.CredentialSnapshot) (accountapp.CredentialBinding, error)
}

// RejectedObservationState 只公开队列计数和固定结果，不含账号、正文或凭据。
type RejectedObservationState struct {
	Capacity      int    `json:"capacity"`
	Pending       int    `json:"pending"`
	Accepted      int64  `json:"accepted"`
	Declined      int64  `json:"declined"`
	Completed     int64  `json:"completed"`
	Cancelled     int64  `json:"cancelled"`
	LastAdmission string `json:"lastAdmission,omitempty"`
	LastResult    string `json:"lastResult,omitempty"`
}

// TryScheduleCredentialRejection 只排原请求观察，非阻塞且连正在执行的项也去重。
// 调用方必须已验证真实 HTTP builtin 401 并成功记录同代次的凭据阻塞。
func (d *Daemon) TryScheduleCredentialRejection(observation accountcredentials.CredentialObservation) bool {
	if d == nil {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	reason := ""
	_, currentCapable := d.refresher.(CurrentCredentialRefresher)
	switch {
	case !observation.IsValid():
		reason = "invalid_observation"
	case observation.IsStaticSecret():
		reason = "static_credential"
	case d.closed:
		reason = "closed"
	case !d.enabled:
		reason = "disabled"
	case d.delegateCredentialRefresh:
		reason = "delegated_to_host"
	case d.store == nil || d.refresher == nil || !currentCapable:
		reason = "missing_current_refresher"
	case !d.running || d.runCtx == nil:
		reason = "not_running"
	case d.runCtx.Err() != nil:
		reason = "cancelled"
	default:
		if _, pending := d.rejectedPending[observation]; pending {
			reason = "duplicate"
		} else if len(d.rejectedPending) >= rejectedObservationCapacity {
			reason = "overflow"
		}
	}
	if reason != "" {
		d.rejectedState.Declined++
		d.rejectedState.LastAdmission = reason
		return false
	}
	select {
	case d.rejectedQueue <- observation:
		d.rejectedPending[observation] = struct{}{}
		d.rejectedState.Accepted++
		d.rejectedState.LastAdmission = "queued"
		return true
	default:
		d.rejectedState.Declined++
		d.rejectedState.LastAdmission = "overflow"
		return false
	}
}

// consumeRejectedObservation 在原 loop 内等待同一执行门，无新 poller、timer 或 RPC。
func (d *Daemon) consumeRejectedObservation(ctx context.Context, observation accountcredentials.CredentialObservation) {
	result := "cancelled"
	select {
	case d.runGate <- struct{}{}:
		jobCtx, cancel := context.WithTimeout(ctx, d.perAccountTimeout)
		result = d.refreshRejectedObservation(jobCtx, observation)
		cancel()
		<-d.runGate
	case <-ctx.Done():
	}
	d.mu.Lock()
	delete(d.rejectedPending, observation)
	d.rejectedState.Completed++
	if result == "cancelled" {
		d.rejectedState.Cancelled++
	}
	d.rejectedState.LastResult = result
	d.mu.Unlock()
}

func (d *Daemon) refreshRejectedObservation(ctx context.Context, observation accountcredentials.CredentialObservation) string {
	if ctx.Err() != nil {
		return "cancelled"
	}
	currentRefresher, ok := d.refresher.(CurrentCredentialRefresher)
	if !ok {
		return "missing_current_refresher"
	}
	if d.delegateCredentialRefresh {
		return "delegated_to_host"
	}
	overviews, err := d.listAllOverviews(ctx)
	if err != nil {
		return rejectedReadResult(ctx)
	}
	eligible := false
	for _, overview := range overviews {
		account := overview.Account()
		if account.Ref() == observation.AccountRef() {
			eligible = account.ProviderID() == observation.ProviderID() && account.Enabled() && overview.HasCredential()
			break
		}
	}
	if !eligible {
		return "account_ineligible"
	}
	static, err := d.store.IsAPIKeyAccount(ctx, observation.AccountRef())
	if err != nil {
		return rejectedReadResult(ctx)
	}
	if static {
		return "static_credential"
	}
	candidate, err := d.refresher.InspectRefreshCandidate(ctx, observation.AccountRef())
	if err != nil {
		return rejectedReadResult(ctx)
	}
	current, err := accountcredentials.NewCredentialObservation(candidate.Snapshot)
	if err != nil || current != observation {
		return "observation_not_current"
	}
	if candidate.Delegated {
		return "delegated_to_host"
	}
	if !candidate.Refreshable {
		return "credential_not_refreshable"
	}
	// 令牌信号仅在 owner 内计算，用原持久抑制存储，不进入队列或状态。
	signals := inspectCredentialSignals(candidate.Snapshot.Credential())
	if d.suppressions.IsSuppressed(observation.AccountRef().String(), signals.refreshTokenDigest,
		observation.UpdatedAt().UnixMilli(), d.now().UTC()) {
		return "suppressed"
	}
	binding, err := currentRefresher.ForceRefreshCredentialBindingIfCurrent(ctx, candidate.Snapshot)
	if ctx.Err() != nil {
		return "cancelled"
	}
	if err != nil {
		if isPermanentInvalidRefreshError(err) {
			d.suppressions.Remember(observation.AccountRef().String(), observation.ProviderID(),
				signals.refreshTokenDigest, observation.UpdatedAt().UnixMilli(),
				"credential_rejection_refresh_permanent", d.suppressionRetryDelay, d.now().UTC())
			return "suppressed_permanent_failure"
		}
		if errors.Is(err, accountcredentials.ErrRefreshUnavailable) || isSkippedRefreshError(err) {
			return "refresh_unavailable"
		}
		return "refresh_failed"
	}
	if !binding.IsValid() || binding.AccountRef() != observation.AccountRef() || binding.ProviderID() != observation.ProviderID() {
		return "binding_changed_or_invalid"
	}
	// Binding 不含代次；必须重读同身份严格更新的非静态快照，不能猜 rekey 身份。
	updated, err := d.refresher.InspectRefreshCandidate(ctx, observation.AccountRef())
	if err != nil {
		return rejectedReadResult(ctx)
	}
	next, err := accountcredentials.NewCredentialObservation(updated.Snapshot)
	if err != nil || next.AccountRef() != observation.AccountRef() || next.ProviderID() != observation.ProviderID() ||
		next.IsStaticSecret() || !next.UpdatedAt().After(observation.UpdatedAt()) {
		return "new_generation_unverified"
	}
	if ctx.Err() != nil {
		return "cancelled"
	}
	// 本 slice 不清任何账号 block，不恢复调度，也不重放原请求。
	return "credential_refreshed_block_retained"
}

func rejectedReadResult(ctx context.Context) string {
	if ctx.Err() != nil {
		return "cancelled"
	}
	return "observation_unverifiable"
}

// discardRejectedObservationsLocked 在原 owner 退出时显式取消所有尚未消费的项。
func (d *Daemon) discardRejectedObservationsLocked() {
	for {
		select {
		case observation := <-d.rejectedQueue:
			delete(d.rejectedPending, observation)
			d.rejectedState.Cancelled++
			d.rejectedState.LastResult = "cancelled"
		default:
			return
		}
	}
}
