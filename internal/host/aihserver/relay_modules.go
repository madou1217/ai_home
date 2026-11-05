package aihserver

import (
	"fmt"

	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/clinerelay"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/grokrelay"
	"github.com/madou1217/ai_home/internal/transport/http/kimirelay"
	"github.com/madou1217/ai_home/internal/transport/http/kirorelay"
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
	"github.com/madou1217/ai_home/internal/transport/http/qoderrelay"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
	"github.com/madou1217/ai_home/internal/transport/http/zcoderelay"
)

// relayModule 是一个「单 Provider 透传通道」的装配单元。
//
// 为什么账号来源与 Provider 放在同一条声明里：它们是同一次接入的两半。只加账号来源
// 不加 Provider（或反过来）都没有编译错误、没有启动错误，线上表现为「这个 Provider 的
// 请求被静默交回 Canonical」——这类漏项在过去靠两份手写名单维护，已经出过一次故障。
type relayModule struct {
	ID       string
	Accounts relaycore.AccountSource
	Provider relaycore.Provider
}

// relayBuildContext 是构造模块所需的宿主事实。
type relayBuildContext struct {
	Catalog   *providers.Catalog
	Recruiter *accountrouting.Recruiter
	AIHomeDir string
}

// relayModuleSpec 是模块的静态声明：ID + 凭据策略 + Provider 构造。
type relayModuleSpec struct {
	ID     string
	Label  string
	Policy accountrouting.CredentialTransportPolicy
	// Provider 为 nil 表示该 Provider 复用另一个模块的变体（qodercn 与 qoder 共用一个）。
	Provider func(relayBuildContext) relaycore.Provider
}

// relayModuleSpecs 是全部「单 Provider」透传通道的唯一注册点。
//
// 新增一个 Provider：在这里加一条，目录（relayProviderIDs）、账号来源链
// （relayModuleAccounts）与 Provider 链（relayModuleProviders）三处自动跟上。
// 家族四支不在这里——它们是多 Provider 通道，由 codebuddyfamilyrelay 自己解析。
func relayModuleSpecs() []relayModuleSpec {
	return []relayModuleSpec{
		{
			ID:    clinerelay.ProviderID,
			Label: "cline",
			// 与家族共用 chat completions 入口，上游就是标准 OpenAI 兼容端点。
			Policy:   clineRelayTransportPolicy{},
			Provider: func(relayBuildContext) relaycore.Provider { return clinerelay.NewProvider("") },
		},
		{
			ID:       grokrelay.ProviderID,
			Label:    "grok",
			Policy:   grokRelayTransportPolicy{},
			Provider: func(relayBuildContext) relaycore.Provider { return grokrelay.NewProvider("") },
		},
		{
			ID:    kimirelay.ProviderID,
			Label: "kimi",
			// 设备指纹头与请求体字段翻译都依赖账号，因此 Provider 按账号组装。
			Policy: kimiRelayTransportPolicy{},
			Provider: func(relayBuildContext) relaycore.Provider {
				return newKimiRelayProvider(kimiClientVersion())
			},
		},
		{
			ID:       opencoderelay.ProviderID,
			Label:    "opencode",
			Policy:   opencodeRelayTransportPolicy{},
			Provider: func(relayBuildContext) relaycore.Provider { return opencoderelay.NewProvider() },
		},
		{
			ID:    qoderrelay.QoderProviderID,
			Label: "qoder",
			// WASM 签名 + zstd 请求体；凭据策略只认原生登录态。
			Policy:   qoderRelayTransportPolicy{},
			Provider: func(relayBuildContext) relaycore.Provider { return qoderrelay.NewProvider() },
		},
		{
			ID:    qoderrelay.QoderCNProviderID,
			Label: "qodercn",
			// CN 区域复用同一个 Provider 变体（由 Resolve 按 ProviderID 选端点）。
			Policy: qoderRelayTransportPolicy{},
		},
		{
			ID:    zcoderelay.ProviderID,
			Label: "zcode",
			// 请求体需要官方 harness；宿主事实读不到时 fail-soft（与 Node 一致）。
			Policy: zcodeRelayTransportPolicy{},
			Provider: func(ctx relayBuildContext) relaycore.Provider {
				return zcoderelay.NewProvider(loadZcodeHostFacts(ctx.AIHomeDir))
			},
		},
		{
			ID:       kirorelay.ProviderID,
			Label:    "kiro",
			Policy:   kiroRelayTransportPolicy{},
			Provider: func(relayBuildContext) relaycore.Provider { return kirorelay.NewProvider() },
		},
	}
}

// relayProviderIDs 是「由透传通道直接服务」的 Provider 集合。
//
// 这些 Provider 的模型必须进展示目录与账号路由索引（/v1/models、路由未命中与交还
// 判定都依赖它），但它们不存在也不应该存在 Canonical RouteRule：透传通道直接打上游，
// 不经过 Canonical 执行计划。名单从 relayModuleSpecs 派生，不再单独手写。
func relayProviderIDs() []string {
	specs := relayModuleSpecs()
	ids := make([]string, 0, len(specs)+len(codebuddyfamilyrelay.FamilyProviders))
	ids = append(ids, codebuddyfamilyrelay.FamilyProviders...)
	for _, spec := range specs {
		ids = append(ids, spec.ID)
	}
	return ids
}

// buildRelayModules 按声明顺序构造账号来源与 Provider 变体。
func buildRelayModules(ctx relayBuildContext) ([]relayModule, error) {
	specs := relayModuleSpecs()
	modules := make([]relayModule, 0, len(specs))
	for _, spec := range specs {
		accounts, err := newProviderRelayAccountSource(
			spec.ID,
			ctx.Catalog,
			ctx.Recruiter,
			spec.Policy,
		)
		if err != nil {
			return nil, fmt.Errorf("创建 %s 透传账号来源失败: %w", spec.Label, err)
		}
		module := relayModule{ID: spec.ID, Accounts: accounts}
		if spec.Provider != nil {
			module.Provider = spec.Provider(ctx)
		}
		modules = append(modules, module)
	}
	return modules, nil
}

// relayModuleAccounts 按声明顺序取账号来源，供 AccountSourceChain 使用。
func relayModuleAccounts(modules []relayModule) []relaycore.AccountSource {
	accounts := make([]relaycore.AccountSource, 0, len(modules))
	for _, module := range modules {
		if module.Accounts != nil {
			accounts = append(accounts, module.Accounts)
		}
	}
	return accounts
}

// relayModuleProviders 按声明顺序取 Provider 变体；共用变体的模块（qodercn）不重复加入。
func relayModuleProviders(modules []relayModule) []relaycore.Provider {
	providers := make([]relaycore.Provider, 0, len(modules))
	for _, module := range modules {
		if module.Provider != nil {
			providers = append(providers, module.Provider)
		}
	}
	return providers
}
