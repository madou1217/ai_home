package taskhub

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// AttachEnvironmentJobs 把 Go 运行环境 JobManager 的活跃作业与实时事件接入 Hub。
//
// 返回停止订阅的清理函数。
func AttachEnvironmentJobs(ctx context.Context, hub *Hub, manager *environment.JobManager) func() {
	if hub == nil || manager == nil {
		return func() {}
	}
	unregister := hub.RegisterSource("environment-go", func() []Task {
		jobs := manager.ListActive()
		tasks := make([]Task, 0, len(jobs))
		for _, job := range jobs {
			if task, ok := StructToTask("environment", job); ok {
				tasks = append(tasks, task)
			}
		}
		return tasks
	})

	events, unsubscribe := manager.Subscribe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				if ev.Job.ID != "" {
					hub.PublishTyped("environment", ev.Job)
				}
			}
		}
	}()

	return func() {
		unregister()
		unsubscribe()
	}
}

// AttachAccountActivityJobs 把 Go 账号活动 JobManager 的活跃作业接入 Hub；
// 变更推送可通过 AccountActivityChangedHandler 传给 accountactivity.NewJobManager。
func AttachAccountActivityJobs(hub *Hub, manager *accountactivity.JobManager) func() {
	if hub == nil || manager == nil {
		return func() {}
	}
	return hub.RegisterSource("account-activity", func() []Task {
		jobs := manager.ListActive()
		tasks := make([]Task, 0, len(jobs))
		for _, job := range jobs {
			if task, ok := StructToTask("account-activity", job); ok {
				tasks = append(tasks, task)
			}
		}
		return tasks
	})
}

// AccountActivityChangedHandler 返回可直接传入 accountactivity.NewJobManager 的事件回调。
func AccountActivityChangedHandler(hub *Hub) func(accountactivity.JobView) {
	return func(job accountactivity.JobView) {
		if hub != nil && job.ID != "" {
			hub.PublishTyped("account-activity", job)
		}
	}
}
