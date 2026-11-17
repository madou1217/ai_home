package aihserver

import (
	"sync"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
)

type credentialRejectionRefreshBinder interface {
	bindCredentialRejectionRefresh(inferencegateway.CredentialRejectionScheduler)
}

// credentialRejectionRefresh 在 runtime 的值拷贝之间共享唯一 daemon 接线。
// 它不读取凭据，不持有 store/client，也不创建后台执行者。
type credentialRejectionRefresh struct {
	mu        sync.RWMutex
	scheduler inferencegateway.CredentialRejectionScheduler
}

func newCredentialRejectionRefresh() *credentialRejectionRefresh {
	return &credentialRejectionRefresh{}
}

func (refresh *credentialRejectionRefresh) bind(scheduler inferencegateway.CredentialRejectionScheduler) {
	if refresh == nil {
		return
	}
	refresh.mu.Lock()
	refresh.scheduler = scheduler
	refresh.mu.Unlock()
}

func (refresh *credentialRejectionRefresh) trySchedule(observation accountcredentials.CredentialObservation) bool {
	if refresh == nil {
		return false
	}
	refresh.mu.RLock()
	scheduler := refresh.scheduler
	refresh.mu.RUnlock()
	return scheduler != nil && scheduler.TryScheduleCredentialRejection(observation)
}

func (runtime outcomeRecordingRuntime) bindCredentialRejectionRefresh(scheduler inferencegateway.CredentialRejectionScheduler) {
	runtime.credentialRejectionRefresh.bind(scheduler)
}

// TryScheduleCredentialRejection 只转发原观察；缺少 capability 时不回落到 ref-only。
func (runtime outcomeRecordingRuntime) TryScheduleCredentialRejection(observation accountcredentials.CredentialObservation) bool {
	return runtime.credentialRejectionRefresh.trySchedule(observation)
}

var _ inferencegateway.CredentialRejectionScheduler = outcomeRecordingRuntime{}
