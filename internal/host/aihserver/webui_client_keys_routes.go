package aihserver

// 客户端 API Key 的管理路由：服务与统计器由组合根安装为进程级单例，
// 这里只依赖管理鉴权，不再扩展 webuiRouteDependencies。

import (
	"fmt"
	"net/http"

	clientkeysapp "github.com/madou1217/ai_home/application/clientkeys"
	"github.com/madou1217/ai_home/application/clientkeystats"
	"github.com/madou1217/ai_home/internal/transport/http/webuiclientkeysapi"
)

func buildWebUIClientKeyRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	keys := clientkeysapp.Current()
	if keys == nil || dependencies.Authorizer == nil {
		return nil, nil
	}
	handler, err := webuiclientkeysapi.NewHandler(webuiclientkeysapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Keys:       keys,
		Stats:      clientkeystats.Current(),
		AIHomeDir:  dependencies.AIHomeDir,
		Limits:     dependencies.Store,
	})
	if err != nil {
		return nil, fmt.Errorf("创建客户端 API Key 接口失败: %w", err)
	}
	collection := webuiclientkeysapi.CollectionPath
	member := collection + "/{keyId}"
	return []webuiRoute{
		{Pattern: "GET " + collection, Handler: http.HandlerFunc(handler.ServeCollection)},
		{Pattern: "POST " + collection, Handler: http.HandlerFunc(handler.ServeCollection)},
		{Pattern: "GET " + webuiclientkeysapi.StatsPath, Handler: http.HandlerFunc(handler.ServeStats)},
		{Pattern: "PATCH " + member, Handler: http.HandlerFunc(handler.ServeMember)},
		{Pattern: "DELETE " + member, Handler: http.HandlerFunc(handler.ServeMember)},
		{Pattern: "POST " + member + "/rotate", Handler: http.HandlerFunc(handler.ServeRotate)},
		{Pattern: "GET " + collection + "/effective-concurrency", Handler: http.HandlerFunc(handler.ServeEffectiveConcurrency)},
		{Pattern: "GET /v1/management/webui/accounts/{provider}/{accountRef}/concurrency", Handler: http.HandlerFunc(handler.ServeAccountConcurrency)},
		{Pattern: "PUT /v1/management/webui/accounts/{provider}/{accountRef}/concurrency", Handler: http.HandlerFunc(handler.ServeAccountConcurrency)},
	}, nil
}
