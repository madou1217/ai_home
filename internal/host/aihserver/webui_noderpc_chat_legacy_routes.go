package aihserver

import (
	"errors"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/noderpcapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountliveapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatattachmentsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatsessionsapi"
)

var nodeRPCOperations = []string{
	"device-status",
	"device-nodes",
	"device-accounts",
	"device-sessions",
	"device-node-sessions",
	"device-session-messages",
	"device-node-session-messages",
}

// buildWebUINodeRPCChatLegacyRoutes 装配 node-rpc、聊天附件与 legacy 聊天会话路由。
//
// node-rpc 同时挂载直连前缀（/v1/management/node-rpc/）与 Node WebUI 代理前缀
// （/v1/management/webui/node-rpc/），两套前缀共用同一个零回退 Handler。
func buildWebUINodeRPCChatLegacyRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, errors.New("node-rpc 与聊天历史接口缺少鉴权器")
	}

	var overviewStore noderpcapi.AccountOverviewStore
	var stateSource webuiaccountliveapi.StateSource
	var stampReader noderpcapi.ModelStampReader
	if dependencies.Store != nil {
		overviewStore = dependencies.Store
		stateSource = dependencies.Store
		stampReader = dependencies.Store
	}

	nodeRPCHandler, err := noderpcapi.NewHandler(noderpcapi.Dependencies{
		Authorizer:       dependencies.Authorizer,
		AIHomeDir:        dependencies.AIHomeDir,
		HostHomeDir:      dependencies.HostHomeDir,
		Catalog:          dependencies.Catalog,
		AccountRows:      dependencies.AccountRows,
		OverviewStore:    overviewStore,
		States:           stateSource,
		Runtime:          accountRuntimeSnapshotter(dependencies.AccountRuntime),
		ModelStampReader: stampReader,
		StartedAt:        time.Now(),
	})
	if err != nil {
		return nil, fmt.Errorf("创建 node-rpc 接口失败: %w", err)
	}

	attachmentsHandler, err := webuichatattachmentsapi.NewHandler(webuichatattachmentsapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		AIHomeDir:   dependencies.AIHomeDir,
		HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建聊天附件读取接口失败: %w", err)
	}

	chatSessionsHandler, err := webuichatsessionsapi.NewHandler(webuichatsessionsapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		AIHomeDir:   dependencies.AIHomeDir,
		HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建聊天会话接口失败: %w", err)
	}

	routes := make([]webuiRoute, 0, 5+2*(len(nodeRPCOperations)+1))
	routes = append(routes,
		webuiRoute{Pattern: "GET " + webuichatattachmentsapi.Path, Handler: attachmentsHandler},
		webuiRoute{Pattern: "GET " + webuichatsessionsapi.CollectionPath, Handler: chatSessionsHandler},
		webuiRoute{Pattern: "POST " + webuichatsessionsapi.CollectionPath, Handler: chatSessionsHandler},
		webuiRoute{Pattern: "GET " + webuichatsessionsapi.ItemPath, Handler: chatSessionsHandler},
		webuiRoute{Pattern: "DELETE " + webuichatsessionsapi.ItemPath, Handler: chatSessionsHandler},
	)
	for _, op := range nodeRPCOperations {
		routes = append(routes,
			webuiRoute{Pattern: "GET " + noderpcapi.Prefix + op, Handler: nodeRPCHandler},
			webuiRoute{Pattern: "GET " + noderpcapi.WebUIPrefix + op, Handler: nodeRPCHandler},
		)
	}
	// 子树兜底接住未知 RPC 名（404 rpc_not_found）以及同路径上的非 GET 方法（405 method_not_allowed）。
	routes = append(routes,
		webuiRoute{Pattern: noderpcapi.Prefix, Handler: nodeRPCHandler},
		webuiRoute{Pattern: noderpcapi.WebUIPrefix, Handler: nodeRPCHandler},
	)
	return routes, nil
}
