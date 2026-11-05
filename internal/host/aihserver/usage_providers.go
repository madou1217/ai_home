package aihserver

// 本文件是「Provider 额度装配」的唯一注册点。
//
// 为什么要有它：此前每接一个 Provider 都要在 usage.go 里改四处（import、构造、
// 策略列表、协调器 map），不同业务反复修改同一个文件是设计缺陷的信号。
// 现在每个 Provider 只产出一个 usageProviderModule；usage.go 只迭代注册表，
// 协调器队列也由策略自己的 ProviderID() 派生——新增 Provider 不再触碰公共逻辑。

import (
	"fmt"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/core/accounts/kimiidentity"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agyusage "github.com/madou1217/ai_home/internal/adapters/agy/usage"
	claudeusage "github.com/madou1217/ai_home/internal/adapters/claude/usage"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	clineusage "github.com/madou1217/ai_home/internal/adapters/cline/usage"
	codebuddyfamilyusage "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/usage"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
	codexusage "github.com/madou1217/ai_home/internal/adapters/codex/usage"
	geminiusage "github.com/madou1217/ai_home/internal/adapters/gemini/usage"
	grokusage "github.com/madou1217/ai_home/internal/adapters/grok/usage"
	kimiusage "github.com/madou1217/ai_home/internal/adapters/kimi/usage"
	kirousage "github.com/madou1217/ai_home/internal/adapters/kiro/usage"
	qoderusage "github.com/madou1217/ai_home/internal/adapters/qoder/usage"
	zcodeusage "github.com/madou1217/ai_home/internal/adapters/zcode/usage"
)

// usageProviderContext 是 Provider 额度模块的装配上下文。
//
// 只放「服务级」依赖：HTTP 传输、客户端版本源、凭据存储与时钟。账号级差异一律由
// 策略在 FetchUsageWithDocument 里从凭据读取，不进装配上下文。
type usageProviderContext struct {
	client        UsageHTTPClient
	codexVersions clientversion.Source
	store         *sqliteaccount.Store
	clock         usageapp.Clock
}

// usageProviderModule 是一个 Provider（或家族）的额度装配单元。
type usageProviderModule struct {
	// id 只用于装配错误信息。
	id string
	// build 返回该模块负责的全部策略；家族与双区 Provider 可以返回多条。
	build func(usageProviderContext) ([]usageapp.ProviderStrategy, error)
}

// usageProviderModules 是额度 Provider 的唯一清单。
func usageProviderModules() []usageProviderModule {
	return []usageProviderModule{
		{id: "codex", build: buildCodexUsage},
		{id: "claude", build: buildClaudeUsage},
		{id: "kiro", build: buildKiroUsage},
		{id: "agy", build: buildAgyUsage},
		{id: "zcode", build: buildZcodeUsage},
		{id: "cline", build: buildClineUsage},
		{id: "gemini", build: buildGeminiUsage},
		{id: "grok", build: buildGrokUsage},
		{id: "kimi", build: buildKimiUsage},
		{id: "qoder", build: buildQoderUsage},
		{id: "codebuddy-family", build: buildCodebuddyFamilyUsage},
	}
}

func buildCodexUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	source := context.codexVersions
	if source == nil {
		source = clientversion.Static(codexidentity.Floor)
	}
	strategy, err := codexusage.NewWithClientVersion(context.client, source)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildClaudeUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := claudeusage.New(context.client)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildKiroUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := kirousage.New(context.client)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildAgyUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := agyusage.New(context.client)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildZcodeUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := zcodeusage.New(context.client)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildClineUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := clineusage.New(context.client)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildGeminiUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := geminiusage.New(context.client)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildGrokUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := grokusage.New(context.client)
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildKimiUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategy, err := kimiusage.New(context.client, kimiusage.Options{
		ClientVersion: kimiClientVersion(),
		Host: kimiidentity.HostFacts{
			HostName:    hostNameOrEmpty(),
			DeviceModel: hostDeviceModelOrEmpty(),
			OSVersion:   hostOSVersionOrEmpty(),
		},
	})
	if err != nil {
		return nil, err
	}
	return []usageapp.ProviderStrategy{strategy}, nil
}

func buildQoderUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategies := make([]usageapp.ProviderStrategy, 0, 2)
	for _, providerID := range []string{"qoder", "qodercn"} {
		strategy, err := qoderusage.New(context.client, providerID)
		if err != nil {
			return nil, err
		}
		strategies = append(strategies, strategy)
	}
	return strategies, nil
}

func buildCodebuddyFamilyUsage(context usageProviderContext) ([]usageapp.ProviderStrategy, error) {
	strategies := make([]usageapp.ProviderStrategy, 0, 4)
	for _, providerID := range []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"} {
		strategy, err := codebuddyfamilyusage.New(context.client, providerID)
		if err != nil {
			return nil, err
		}
		strategies = append(strategies, strategy)
	}
	return strategies, nil
}

// buildUsageProviderStrategies 迭代注册表并派生出协调器队列。
func buildUsageProviderStrategies(context usageProviderContext) ([]usageapp.ProviderStrategy, map[string]int, error) {
	var strategies []usageapp.ProviderStrategy
	concurrency := map[string]int{}
	for _, module := range usageProviderModules() {
		built, err := module.build(context)
		if err != nil {
			return nil, nil, fmt.Errorf("装配 %s 额度策略失败: %w", module.id, err)
		}
		for _, strategy := range built {
			strategies = append(strategies, strategy)
			concurrency[strategy.ProviderID()] = usageProviderConcurrency
		}
	}
	return strategies, concurrency, nil
}
