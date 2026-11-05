package aihserver

// 本文件是「Provider 模型目录源」的唯一注册点。
//
// 为什么要有它：此前每接一个 Provider 都要改 composition.go 的 newModelDiscovery
// （构造、错误包装、策略列表三处），不同业务反复修改同一个函数是设计缺陷的信号。
// 现在每个 Provider 只产出一个 modelProviderModule；newModelDiscovery 只迭代注册表，
// 新增 Provider 不再触碰公共装配逻辑。
//
// 注册表顺序就是 ModelDiscovery 的注册顺序，与重构前保持一致；family / qoder
// 这类一个模块返回多条源的，模块内返回顺序同样固定。

import (
	stdcontext "context"
	"fmt"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	clinemodelcatalog "github.com/madou1217/ai_home/internal/adapters/cline/modelcatalog"
	codebuddyfamilymodelcatalog "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/modelcatalog"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	geminimodelcatalog "github.com/madou1217/ai_home/internal/adapters/gemini/modelcatalog"
	kiromodelcatalog "github.com/madou1217/ai_home/internal/adapters/kiro/modelcatalog"
	openaicompatmodelcatalog "github.com/madou1217/ai_home/internal/adapters/openaicompat/modelcatalog"
	opencodemodelcatalog "github.com/madou1217/ai_home/internal/adapters/opencode/modelcatalog"
	qodermodelcatalog "github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
	zcodemodelcatalog "github.com/madou1217/ai_home/internal/adapters/zcode/modelcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/grokrelay"
	"github.com/madou1217/ai_home/internal/transport/http/kimirelay"
	"github.com/madou1217/ai_home/internal/transport/http/qoderrelay"
)

// modelProviderContext 是模型目录源的装配上下文。
//
// 只放「服务级」依赖：HTTP 传输、客户端版本源、模型能力登记器。账号级凭据一律由
// 各目录源在 DiscoverModels 里从 credential 读取，不进装配上下文。
type modelProviderContext struct {
	client            *http.Client
	codexVersions     clientversion.Source
	agyModelWires     agycodeassist.ModelWireWriter
	modalityRegistrar modelmetadata.ModelDescriptorRegistrar
}

// modelProviderModule 是一个 Provider（或家族）的模型目录装配单元。
type modelProviderModule struct {
	// id 只用于装配错误信息；家族/双区模块会返回多条源，不与 ProviderID 一一对应。
	id string
	// build 返回该模块负责的全部目录源；家族与双区 Provider 可以返回多条。
	build func(modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error)
}

// modelProviderModules 是模型目录源的唯一清单，顺序即注册顺序。
func modelProviderModules() []modelProviderModule {
	return []modelProviderModule{
		{id: "codex", build: buildCodexModelProvider},
		{id: "claude", build: buildClaudeModelProvider},
		{id: "agy", build: buildAgyModelProvider},
		{id: "kimi", build: buildKimiModelProvider},
		{id: "grok", build: buildGrokModelProvider},
		{id: "opencode", build: buildOpencodeModelProvider},
		{id: "kiro", build: buildKiroModelProvider},
		{id: "zcode", build: buildZcodeModelProvider},
		{id: "gemini", build: buildGeminiModelProvider},
		{id: "codebuddy-family", build: buildCodebuddyFamilyModelProviders},
		{id: "qoder", build: buildQoderModelProviders},
		{id: "cline", build: buildClineModelProvider},
	}
}

func buildCodexModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := codexresponses.NewModelCatalogSourceWithClientVersion(context.client, context.codexVersions)
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

func buildClaudeModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := claudemessages.NewModelCatalogSource(context.client)
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

func buildAgyModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := agycodeassist.NewModelCatalogSourceWithWireModels(context.client, context.agyModelWires)
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

// kimi / grok 的透传通道已接入（见 relaycore），但账号的**模型目录**要单独发现：
// 没有目录，Go 就不知道这两个 Provider 有哪些模型可路由，请求会被判成
// model_not_routable 交还 Node —— 等于通道白接。
//
// 两者都是标准 OpenAI 兼容端点（GET {base}/models），因此共用同一实现，
// 差异只在端点与凭据取法。
func buildKimiModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := openaicompatmodelcatalog.New(context.client, openaicompatmodelcatalog.Options{
		ProviderID:  kimirelay.ProviderID,
		Endpoint:    kimirelay.KimiCodeBaseURL + openaicompatmodelcatalog.ModelsPath,
		Token:       kimirelay.AccessTokenFromCredential,
		Descriptors: context.modalityRegistrar,
	})
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

func buildGrokModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := openaicompatmodelcatalog.New(context.client, openaicompatmodelcatalog.Options{
		ProviderID: grokrelay.ProviderID,
		Endpoint:   grokrelay.DefaultBaseURL + openaicompatmodelcatalog.ModelsPath,
		Token:      grokrelay.AccessTokenFromCredential,
		// grok 的 GET /models 只认 API Key：OAuth 账号会被 403，因此明确跳过
		// （那些账号的目录只能靠本地 CLI，Go 服务端没有 —— 这是能力边界，不是缺陷）。
		SupportsCredential: grokrelay.SupportsHTTPModelDiscovery,
	})
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

func buildOpencodeModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := opencodemodelcatalog.New(context.client)
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

// kiro 的目录走控制面 ListAvailableModels（V3 按套餐，V2 兜底）；
// access token 过期时由 kirocred.Refresher 在发现前刷新。
func buildKiroModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := kiromodelcatalog.New(context.client)
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

// zcode 的目录来自 plan 计费接口（余额 + 活动预览回退），需要客户端元数据头。
func buildZcodeModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := zcodemodelcatalog.New(context.client)
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

// gemini 的 Vertex 占位/网关号直接读 base_url 的 /v1/models。
func buildGeminiModelProvider(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	source, err := geminimodelcatalog.New(context.client)
	if err != nil {
		return nil, err
	}
	return []accountapp.ProviderModelDiscoverer{source}, nil
}

func buildCodebuddyFamilyModelProviders(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	return codebuddyfamilymodelcatalog.NewModelCatalogSources(context.client)
}

// qoder 的目录要客户端 wasm 签名，签名运行时在 qodercred（wazero）。
func buildQoderModelProviders(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	sources := make([]accountapp.ProviderModelDiscoverer, 0, 2)
	byProvider := make(map[string]*qodermodelcatalog.Source, 2)
	for _, providerID := range []string{"qoder", "qodercn"} {
		source, err := qodermodelcatalog.New(context.client, providerID)
		if err != nil {
			// 两个区域共用同一模块，错误里保留具体 Provider，便于定位是哪个区失败。
			return nil, fmt.Errorf("%s: %w", providerID, err)
		}
		byProvider[providerID] = source
		sources = append(sources, source)
	}
	// relay 的目录缓存写入方是模型发现；冷启动/刷新失败时按需现算，避免把
	// 「目录还没准备好」当成客户端的 invalid_relay_request。
	qoderrelay.SetEntriesLoader(func(providerID string, credential accountapp.Credential) ([]qodermodelcatalog.Entry, error) {
		source := byProvider[providerID]
		if source == nil {
			return nil, qoderrelay.ErrModelCatalogUnavailable
		}
		return source.Entries(stdcontext.Background(), credential)
	})
	return sources, nil
}

// cline 是静态规范清单（不联网、不依赖客户端），与 Node 的 KNOWN_CLINE_MODELS 同源。
func buildClineModelProvider(modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	return []accountapp.ProviderModelDiscoverer{clinemodelcatalog.New()}, nil
}

// buildModelProviderSources 迭代注册表，按注册顺序产出全部目录源。
func buildModelProviderSources(context modelProviderContext) ([]accountapp.ProviderModelDiscoverer, error) {
	var sources []accountapp.ProviderModelDiscoverer
	for _, module := range modelProviderModules() {
		built, err := module.build(context)
		if err != nil {
			return nil, fmt.Errorf("创建 %s 模型目录源失败: %w", module.id, err)
		}
		sources = append(sources, built...)
	}
	return sources, nil
}
