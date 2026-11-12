package accountauth

import "sync"

// jobSubscription 是一路 OAuth Job 快照订阅。
//
// events 只由 Service 在持有 service.mu 时写入或关闭；调用方只读。
// 关闭用 once 保护：取消订阅与终态收敛可能先后到达，重复 close 会 panic。
type jobSubscription struct {
	events chan Job
	once   sync.Once
}

// stop 关闭事件流；可重复调用。
func (subscription *jobSubscription) stop() {
	subscription.once.Do(func() { close(subscription.events) })
}

// Subscribe 返回 Job 的当前快照与后续状态变更流。
//
// 订阅只覆盖进程内的活动 Job：oauth_jobs 里的历史快照已经不会再变化，
// 调用方写完初始快照即可结束，不需要为它挂一条空流。
//
// cancel 必须调用（通常 defer）：它只移除订阅，不改变 Job 状态。
func (service *Service) Subscribe(
	jobID string,
) (Job, <-chan Job, func(), error) {
	now := service.now()
	service.mu.Lock()
	defer service.mu.Unlock()
	service.expireAndPruneLocked(now)
	record, found := service.jobs[jobID]
	if !found {
		return Job{}, nil, nil, ErrJobNotFound
	}
	snapshot := record.job
	subscription := &jobSubscription{events: make(chan Job, 8)}
	// 终态 Job 不会再有变化：返回已关闭的流，调用方交付初始快照后结束。
	if snapshot.IsTerminal() {
		subscription.stop()
		return snapshot, subscription.events, func() {}, nil
	}
	if service.subscribers == nil {
		service.subscribers = make(map[string]map[*jobSubscription]struct{})
	}
	if service.subscribers[jobID] == nil {
		service.subscribers[jobID] = make(map[*jobSubscription]struct{})
	}
	service.subscribers[jobID][subscription] = struct{}{}
	cancel := func() { service.unsubscribe(jobID, subscription) }
	return snapshot, subscription.events, cancel, nil
}

// publishJobLocked 把一次已提交的状态快照发给所有订阅者。
//
// 调用方必须持有 service.mu：这样发送与取消订阅不会并发关闭同一通道。
// 队列满说明订阅者已经跟不上，直接断开这一路（SSE 客户端会重连），
// 绝不阻塞状态迁移。
func (service *Service) publishJobLocked(job Job) {
	subscriptions := service.subscribers[job.id]
	if len(subscriptions) == 0 {
		return
	}
	terminal := job.status.IsTerminal()
	for subscription := range subscriptions {
		delivered := true
		select {
		case subscription.events <- job:
		default:
			delivered = false
		}
		if terminal || !delivered {
			delete(subscriptions, subscription)
			subscription.stop()
		}
	}
	if len(subscriptions) == 0 {
		delete(service.subscribers, job.id)
	}
}

// unsubscribe 移除一路订阅并关闭事件流。
func (service *Service) unsubscribe(jobID string, subscription *jobSubscription) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if subscriptions, found := service.subscribers[jobID]; found {
		delete(subscriptions, subscription)
		if len(subscriptions) == 0 {
			delete(service.subscribers, jobID)
		}
	}
	subscription.stop()
}
