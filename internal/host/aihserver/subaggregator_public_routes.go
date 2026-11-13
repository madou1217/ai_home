package aihserver

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
	"github.com/madou1217/ai_home/internal/transport/http/subaggregatorpublicapi"
)

// subaggregatorPublicRoutePrefix 是公开聚合订阅与规则集拉取前缀（免 Management Key 鉴权）。
const subaggregatorPublicRoutePrefix = subaggregatorpublicapi.Prefix

// newPublicSubaggregatorHandler 构造 /sub/ 公开订阅与规则集拉取处理器。
//
// 外部代理客户端（Clash / Surge / sing-box / Loon / QX）直接凭 URL 中的随机 token
// 拉取订阅，不经 Authorizer 管理密钥校验；未提供 AIHomeDir / HostHomeDir 时返回 nil。
func newPublicSubaggregatorHandler(dependencies webuiRouteDependencies) (http.Handler, error) {
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}
	if aiHome == "" {
		return nil, nil
	}
	svc := subaggregator.NewService(aiHome, subaggregator.ServiceOptions{
		HostHomeDir: hostHome,
	})
	return newPublicSubaggregatorHandlerWithService(svc)
}

// newPublicSubaggregatorHandlerWithService 使用既有 subaggregator 服务构造公开处理器，
// 供组合根与 WebUI 管理路由共享同一份运行期缓存与本地中转边车状态。
func newPublicSubaggregatorHandlerWithService(service subaggregatorpublicapi.Service) (http.Handler, error) {
	if service == nil {
		return nil, nil
	}
	handler, err := subaggregatorpublicapi.NewHandler(subaggregatorpublicapi.Dependencies{
		Service: service,
	})
	if err != nil {
		return nil, fmt.Errorf("创建公开聚合订阅 HTTP 接口失败: %w", err)
	}
	return handler, nil
}

// buildSubaggregatorPublicRoutes 返回可并入 ServeMux 的 /sub/ 前缀公开路由条目。
func buildSubaggregatorPublicRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	handler, err := newPublicSubaggregatorHandler(dependencies)
	if err != nil || handler == nil {
		return nil, err
	}
	return []webuiRoute{
		{Pattern: subaggregatorPublicRoutePrefix, Handler: handler},
	}, nil
}
