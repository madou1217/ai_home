package aihserver

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	inferencegateway "github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatapi"
)

// webuiChatRuntimeInputs 是内部聊天运行时的稳定依赖。
//
// 账号来源与 Provider 链来自家族透传装配（familyRelay），这里只做内部聊天
// 入口的组装，不重复构建账号池。
type webuiChatRuntimeInputs struct {
	ctx            context.Context
	host           handlerDependencies
	webuiDeps      webuiRouteDependencies
	authorizer     webuichatapi.Authorizer
	familyRelay    *familyRelayRuntime
	modelAliases   *modelalias.Store
	credentials    *accountcredentials.Resolver
	relayClient    relaycore.HTTPClient
	accountRuntime serverAccountRuntime
	attemptUsage   relaycore.UsageRecorder
}

// webuiChatRuntime 是内部聊天入口的装配结果。
type webuiChatRuntime struct {
	handler       http.Handler
	service       *chatruntime.Service
	routes        []webuiRoute
	prewarmCloser io.Closer
}

// newWebUIChatRuntime 装配内部聊天入口与 Canonical Chat Runtime。
//
// 从 newHandlers 拆出：内部聊天入口、运行时挂载、集合/Runs 路由与预热是
// 一条独立链路；主流水线只做失败清理与路由合并。
//
// 账号来源与 Provider 链与家族透传通道同一批对象：能走家族/透传 Provider
// 的会话本切片就能服务，服务不了的账号在 Go 侧显式报错，而不是悄悄回落
// 另一条推理路径。
func newWebUIChatRuntime(inputs webuiChatRuntimeInputs) (*webuiChatRuntime, error) {
	webUIChatHandler, err := newWebUIChatHandler(webuichatapi.Dependencies{
		Authorizer: inputs.authorizer,
		Aliases:    newChatAliasResolver(inputs.modelAliases, inputs.host.Store),
		Accounts: relaycore.NewAccountSourceChain(
			append(relayModuleAccounts(inputs.familyRelay.modules), inputs.familyRelay.familyAccounts)...,
		),
		Credentials: inputs.credentials,
		Provider: relaycore.NewProviderChain(
			append(
				relayModuleProviders(inputs.familyRelay.modules),
				codebuddyfamilyrelay.NewProvider(codebuddyfamilyrelay.ProviderOptions{
					ProviderID: codebuddyfamilyrelay.FamilyProviders[0],
				}),
			)...,
		),
		Client:   inputs.relayClient,
		Attempts: inputs.accountRuntime,
		Usage:    inputs.attemptUsage,
		// 与协调器共用同一份 --max-attempts：进程内不能有两套上游尝试上限。
		MaxAttempts: inferencegateway.ConfiguredUpstreamAttemptLimit(),
		Clock:       time.Now,
	})
	if err != nil {
		return nil, fmt.Errorf("创建内部聊天 Handler 失败: %w", err)
	}
	runtime := &webuiChatRuntime{handler: webUIChatHandler}
	chatHandler, ok := webUIChatHandler.(*webuichatapi.Handler)
	if !ok {
		return runtime, nil
	}
	chatRuntimeService, chatErr := AttachWebUIChatRuntime(inputs.ctx, chatHandler, inputs.webuiDeps)
	if chatErr != nil {
		return nil, fmt.Errorf("装配 Canonical Chat Runtime 失败: %w", chatErr)
	}
	runtime.service = chatRuntimeService
	chatCollectionRoutes, routesErr := BuildWebUIChatRuntimeCollectionRoutes(chatHandler)
	if routesErr != nil {
		_ = chatRuntimeService.Close()
		return nil, fmt.Errorf("装配 Canonical Chat Runtime 集合路由失败: %w", routesErr)
	}
	runtime.routes = append(runtime.routes, chatCollectionRoutes...)
	chatRunsRoutes, runsRoutesErr := BuildWebUIChatRunsRoutes(chatHandler, inputs.host.ManagementKey)
	if runsRoutesErr != nil {
		_ = chatRuntimeService.Close()
		return nil, fmt.Errorf("装配 Canonical Chat Runs 路由失败: %w", runsRoutesErr)
	}
	runtime.routes = append(runtime.routes, chatRunsRoutes...)
	runtime.prewarmCloser = startChatRuntimePrewarm(inputs.ctx, chatRuntimeService)
	return runtime, nil
}
