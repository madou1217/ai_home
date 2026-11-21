package clilaunch

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/providerlaunch"
)

// GatewayStrategy 的启动语义：
//
//	aih codebuddy relay                 -> 网关账号池 + AIH 全量模型目录
//	aih codebuddy relay 2               -> 网关 + 钉选 CodeBuddy 账号 #2
//	aih codebuddy relay claude 3        -> 网关 + 钉选 Claude 账号 #3（跨 Provider harness）
//
// 与 `aih codebuddy <id>`（Native Direct，账号凭据直连）严格分离：网关档使用独立的
// CODEBUDDY_CONFIG_DIR，只包含本投影维护的 models.json，不读取、不投影任何 CodeBuddy
// 账号凭据；CodeBuddy 自身仍会读宿主 HOME 下的 .info，但自定义模型请求按官方行为
// 不携带平台身份头。

const (
	gatewayModelsProjectionTimeout = 12 * time.Second
	gatewayRouteOwnerHeader        = "X-Aih-Route-Owner"
	gatewayPinnedAccountHeader     = "X-Account-Ref"
	gatewayConfigDirEnv            = "CODEBUDDY_CONFIG_DIR"
	gatewayModelEnv                = "CODEBUDDY_MODEL"
	gatewayCustomHeadersEnv        = "CODEBUDDY_CUSTOM_HEADERS"
	gatewayAPIKeyEnv               = "AIH_GATEWAY_API_KEY"
	gatewayAPIKeyDisabledEnv       = "CODEBUDDY_API_KEY_DISABLED"
)

var (
	// ErrGatewayProjectionUnavailable 表示 models.json 投影不可用且没有可回退的默认模型。
	ErrGatewayProjectionUnavailable = errors.New("CodeBuddy 网关模型投影不可用")
)

// ModelsProjection 是 models.json 投影维护端口。
//
// 返回值是适合作为 CODEBUDDY_MODEL 默认值的模型 ID；即使 error 非空，调用方
// 也可以使用上一次成功投影的默认值继续启动。
type ModelsProjection interface {
	Ensure(ctx context.Context, baseURL string, apiKey string) (string, error)
}

// GatewayStrategy 把 CodeBuddy 家族官方 CLI 接到 AIH Server 的 models.json 网关档。
type GatewayStrategy struct {
	providerID   string
	siteInternal bool
	configDir    string
	projection   ModelsProjection
}

var _ providerlaunch.GatewayStrategy = (*GatewayStrategy)(nil)

// NewGatewayStrategy 创建指定家族 Provider 的网关档策略。
func NewGatewayStrategy(
	providerID string,
	siteInternal bool,
	configDir string,
	projection ModelsProjection,
) (*GatewayStrategy, error) {
	id := strings.ToLower(strings.TrimSpace(providerID))
	dir := strings.TrimSpace(configDir)
	if id == "" || dir == "" || projection == nil {
		return nil, ErrBuildLaunchContext
	}
	return &GatewayStrategy{
		providerID:   id,
		siteInternal: siteInternal,
		configDir:    dir,
		projection:   projection,
	}, nil
}

// ProviderID 返回该策略唯一支持的 Provider。
func (strategy *GatewayStrategy) ProviderID() string {
	if strategy == nil {
		return ""
	}
	return strategy.providerID
}

// Build 生成 CodeBuddy 网关档的环境补丁。
//
// 不注入任何 CodeBuddy 账号凭据：宿主上的 CODEBUDDY_API_KEY / BASE_URL / AUTH_TOKEN
// 全部 unset，身份只由 AIH Server 的客户端密钥（供 models.json 的 ${AIH_GATEWAY_API_KEY}
// 展开）承担。
func (strategy *GatewayStrategy) Build(
	target providerlaunch.GatewayTarget,
) (providerlaunch.GatewayStrategyResult, error) {
	if strategy == nil || !target.IsValid() {
		return providerlaunch.GatewayStrategyResult{}, ErrBuildLaunchContext
	}
	endpoint := target.Endpoint()
	ctx, cancel := context.WithTimeout(context.Background(), gatewayModelsProjectionTimeout)
	defer cancel()
	defaultModel, projectionErr := strategy.projection.Ensure(
		ctx,
		endpoint.BaseURL(),
		endpoint.RevealClientKey(),
	)
	if projectionErr != nil && strings.TrimSpace(defaultModel) == "" {
		return providerlaunch.GatewayStrategyResult{}, fmt.Errorf(
			"%w: %v",
			ErrGatewayProjectionUnavailable,
			projectionErr,
		)
	}

	values := map[string]string{
		gatewayConfigDirEnv:      strategy.configDir,
		gatewayAPIKeyEnv:         endpoint.RevealClientKey(),
		gatewayAPIKeyDisabledEnv: "1",
		gatewayCustomHeadersEnv:  gatewayHeaders(target),
	}
	if model := strings.TrimSpace(defaultModel); model != "" {
		values[gatewayModelEnv] = customLocalModelID(model)
	}
	if strategy.siteInternal {
		values["CODEBUDDY_INTERNET_ENVIRONMENT"] = "internal"
		values["CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT"] = "internal"
	}
	unset := neverInheritWithout(values, gatewayNeverInheritKeys())
	patch, err := providerlaunch.NewEnvironmentPatch(values, unset)
	if err != nil {
		return providerlaunch.GatewayStrategyResult{}, fmt.Errorf(
			"%w: Gateway 环境无效",
			ErrBuildLaunchContext,
		)
	}
	return providerlaunch.NewGatewayStrategyResult(
		providerlaunch.GatewayStrategyResultInput{
			ProviderID:  strategy.providerID,
			Binary:      binaryName,
			Environment: patch,
		},
	)
}

// gatewayNeverInheritKeys 在原生家族的清理清单上增加网关档自己的变量：
// 宿主的模型选择、自定义头和 API Key 开关都会改变网关档的身份/路由。
func gatewayNeverInheritKeys() []string {
	keys := append([]string(nil), familyNeverInheritKeys...)
	return append(keys,
		gatewayModelEnv,
		gatewayCustomHeadersEnv,
		gatewayAPIKeyEnv,
		gatewayAPIKeyDisabledEnv,
	)
}

func gatewayHeaders(target providerlaunch.GatewayTarget) string {
	headers := []string{gatewayRouteOwnerHeader + ": go"}
	if accountRef, pinned := target.PinnedAccount(); pinned {
		headers = append(headers, gatewayPinnedAccountHeader+": "+accountRef.String())
	}
	return strings.Join(headers, "\n")
}

func customLocalModelID(modelID string) string {
	id := strings.TrimSpace(modelID)
	if strings.HasPrefix(id, "custom-local:") || strings.HasPrefix(id, "custom:") {
		return id
	}
	return "custom-local:" + id
}
