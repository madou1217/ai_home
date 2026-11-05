// Package modelcatalog 提供 cline 的静态模型目录。
//
// 上游 GET https://api.cline.bot/api/v1/models 返回 462 条 OpenRouter 风格的伙伴
// 命名空间 ID，**不含 cline-pass/***；原样透出会把模型误判给 claude 等 provider。
// 因此对外的目录 = 官方 SDK 的推荐清单（已逐条对 /chat/completions 实测可���），
// 与 Node lib/server/cline-models.js 同源。
//
// 刻意排除 cline-free/*：那条命名空间在本网关的 API 面上一律 403。
package modelcatalog

import (
	"context"
	"errors"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

var (
	// ErrInvalidRequest 表示调用方缺少上下文或凭据。
	ErrInvalidRequest = errors.New("cline 模型目录请求无效")
	// ErrUnsupportedCredential 表示凭据不是 cline 的。
	ErrUnsupportedCredential = errors.New("cline 模型目录源凭据形态不支持")
)

// ProviderID 是本目录服务的 Provider。
const ProviderID = "cline"

// NamespacePrefix 是唯一能回到 cline 上游的模型命名空间。
//
// 裸模型名（如 glm-5.3）不认：它会与 zcode 的 glm-* 抢路由。
const NamespacePrefix = "cline-pass/"

// KnownModels 与 Node KNOWN_CLINE_MODELS 逐条同值。
var KnownModels = []string{
	"cline-pass/deepseek-v4-pro",
	"cline-pass/deepseek-v4.1-flash",
	"cline-pass/glm-5.3",
	"cline-pass/glm-5.3-flash",
	"cline-pass/kimi-k3",
	"cline-pass/mimo-v2.5",
	"cline-pass/mimo-v2.5-pro",
	"cline-pass/mimo-v2.6-flash",
	"cline-pass/mimo-v2.6-pro",
	"cline-pass/minimax-m3",
	"cline-pass/muse-spark-1.3-contributor",
	"cline-pass/qwen3.7-max",
	"cline-pass/qwen3.7-plus",
	"cline-pass/qwen3.8-max",
}

// IsRoutableModelID 判断模型是否属于 cline 命名空间。
func IsRoutableModelID(modelID string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(modelID)), NamespacePrefix)
}

// Source 是 cline 的静态目录源（不联网、不依赖客户端）。
type Source struct{}

var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

// New 创建静态目录源。
func New() *Source { return &Source{} }

// ProviderID 返回 cline。
func (*Source) ProviderID() string { return ProviderID }

// DiscoverModels 返回静态规范清单。
func (*Source) DiscoverModels(ctx context.Context, credential accountapp.Credential) ([]string, error) {
	if ctx == nil || credential == nil {
		return nil, ErrInvalidRequest
	}
	if credential.ProviderID() != ProviderID {
		return nil, ErrUnsupportedCredential
	}
	models := make([]string, len(KnownModels))
	copy(models, KnownModels)
	return models, nil
}
