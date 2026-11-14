package aihserver

import (
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountaddapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// NewKiroJobLocalImporter 装配 Kiro OAuth 新增/重登作业的本机 IDE 登录态导入端口。
func NewKiroJobLocalImporter(dependencies webuiRouteDependencies) webuiaccountaddapi.JobLocalImporter {
	return webuiaccountauthapi.NewKiroJobLocalImporter(dependencies.AuthJobs, dependencies.HostHomeDir)
}

// buildWebUIAccountAuthRoutes 装配 WebUI 账号认证迁移补齐路由（ZCode 协议回调、静态配置账号与本机直接导入）。
func buildWebUIAccountAuthRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}
	handler, err := webuiaccountauthapi.NewHandler(webuiaccountauthapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		Catalog:     dependencies.Catalog,
		Store:       dependencies.Store,
		AuthJobs:    dependencies.AuthJobs,
		HostHomeDir: dependencies.HostHomeDir,
		NodeBaseURL: dependencies.NodeBaseURL,
	})
	if err != nil {
		return nil, err
	}
	return []webuiRoute{
		{Pattern: "POST " + webuiaccountauthapi.ZCodeURLCallbackPath, Handler: http.HandlerFunc(handler.HandleZCodeURLCallback)},
		{Pattern: "POST " + webuiaccountauthapi.StaticAccountPath, Handler: http.HandlerFunc(handler.HandleStaticAccount)},
		{Pattern: "POST " + webuiaccountauthapi.LocalImportPath, Handler: http.HandlerFunc(handler.HandleLocalImport)},
		// 浏览器数据面：本机登录态导入（同构）。
		{Pattern: "POST /v0/webui/accounts/local-import", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", http.HandlerFunc(handler.HandleLocalImport))},
	}, nil
}

// newStaticAccountHandler 返回静态凭据入库处理器（供 add 分流复用）。
func newStaticAccountHandler(dependencies webuiRouteDependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}
	handler, err := webuiaccountauthapi.NewHandler(webuiaccountauthapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		Catalog:     dependencies.Catalog,
		Store:       dependencies.Store,
		AuthJobs:    dependencies.AuthJobs,
		HostHomeDir: dependencies.HostHomeDir,
		NodeBaseURL: dependencies.NodeBaseURL,
	})
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(handler.HandleStaticAccount), nil
}
