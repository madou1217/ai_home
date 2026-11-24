package aihserver

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/requirements"
	"github.com/madou1217/ai_home/internal/adapters/requirementstore"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/runtime/requirementruntime"
	"github.com/madou1217/ai_home/internal/transport/http/inprocesshttp"
	"github.com/madou1217/ai_home/internal/transport/http/webuirequirementsapi"
)

// requirementsRuntime 持有需求存储、调度循环与执行器。
type requirementsRuntime struct {
	store      *requirementstore.Store
	scheduler  *requirementruntime.Scheduler
	dispatcher *requirementruntime.WorkDispatcher
}

// Close 先停调度循环，再关闭独立 SQLite 连接。
func (runtime *requirementsRuntime) Close() error {
	if runtime == nil {
		return nil
	}
	if runtime.scheduler != nil {
		runtime.scheduler.Stop()
	}
	if runtime.store != nil {
		return runtime.store.Close()
	}
	return nil
}

// newRequirementsRuntime 装配需求管理与调度器。
//
// 模型与执行目标固定为 AIH 网关中的 agy / gemini-4-neon-xhigh（可由工作区或调度器设置覆盖）；
// 需求执行会话通过 chat runtime 的 work session 启动，任务通过 peer 投递。
func newRequirementsRuntime(ctx context.Context, dependencies webuiRouteDependencies, chat *chatruntime.Service) (*requirementsRuntime, []webuiRoute, error) {
	store, err := requirementstore.Open(ctx, dependencies.AIHomeDir)
	if err != nil {
		return nil, nil, err
	}
	modelClient := &requirementruntime.GatewayModelClient{
		Client: &http.Client{
			Transport: inprocesshttp.NewTransport(dependencies.TranslationGateway),
			Timeout:   180 * time.Second,
		},
		BaseURL:   "http://aih-gateway.internal",
		ClientKey: dependencies.ClientKey,
	}
	service := requirements.NewService(store, modelClient, time.Now)
	dispatcher := requirementruntime.NewWorkDispatcher(
		chat,
		dependencies.Store,
		dependencies.AIHomeDir,
		dependencies.HostHomeDir,
		func() string { return dependencies.SelfBaseURL },
		dependencies.ManagementKey,
		func(requirementID string, update requirements.ProgressUpdate) {
			progressCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			service.ApplyProgress(progressCtx, requirementID, update)
		},
	)
	scheduler := requirementruntime.NewScheduler(service, dispatcher, time.Now)
	handler, handlerErr := webuirequirementsapi.NewHandler(dependencies.Authorizer, service, scheduler, dispatcher)
	if handlerErr != nil {
		_ = store.Close()
		return nil, nil, handlerErr
	}
	runtime := &requirementsRuntime{store: store, scheduler: scheduler, dispatcher: dispatcher}
	scheduler.Start(ctx)
	return runtime, []webuiRoute{
		{Pattern: webuirequirementsapi.Path, Handler: handler},
		{Pattern: webuirequirementsapi.Path + "/", Handler: handler},
	}, nil
}

var _ io.Closer = (*requirementsRuntime)(nil)
