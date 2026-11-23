package worknative

import (
	"github.com/madou1217/ai_home/application/providerlaunch"
	agycli "github.com/madou1217/ai_home/internal/adapters/agy/clilaunch"
	claudecli "github.com/madou1217/ai_home/internal/adapters/claude/clilaunch"
	clinecli "github.com/madou1217/ai_home/internal/adapters/cline/clilaunch"
	codebuddycli "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/clilaunch"
	codexcli "github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
	geminicli "github.com/madou1217/ai_home/internal/adapters/gemini/clilaunch"
	grokcli "github.com/madou1217/ai_home/internal/adapters/grok/clilaunch"
	kimicli "github.com/madou1217/ai_home/internal/adapters/kimi/clilaunch"
	kirocli "github.com/madou1217/ai_home/internal/adapters/kiro/clilaunch"
	opencodecli "github.com/madou1217/ai_home/internal/adapters/opencode/clilaunch"
	familystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	qodercli "github.com/madou1217/ai_home/internal/adapters/qoder/clilaunch"
	zcodecli "github.com/madou1217/ai_home/internal/adapters/zcode/clilaunch"
)

func registeredStrategies() (map[string]providerlaunch.Strategy, map[string]providerlaunch.GatewayStrategy, error) {
	all := []providerlaunch.Strategy{agycli.NewStrategy(), claudecli.NewStrategy(), clinecli.NewStrategy(), geminicli.NewStrategy(), grokcli.NewStrategy(), kimicli.NewStrategy(), kirocli.NewStrategy(), opencodecli.NewStrategy(), zcodecli.NewStrategy()}
	for _, provider := range familystorage.ProviderIDs() {
		s, err := codebuddycli.NewStrategy(provider, familystorage.SiteInternal(provider))
		if err != nil {
			return nil, nil, err
		}
		all = append(all, s)
	}
	for _, provider := range []string{"qoder", "qodercn"} {
		s, err := qodercli.NewStrategy(provider)
		if err != nil {
			return nil, nil, err
		}
		all = append(all, s)
	}
	strategies := make(map[string]providerlaunch.Strategy, len(all))
	for _, s := range all {
		strategies[s.ProviderID()] = s
	}
	// Only existing Go strategies with an executable native gateway contract are
	// admitted. AGY GatewayActive is upstream support, not a CLI gateway profile.
	gateways := map[string]providerlaunch.GatewayStrategy{
		"claude": claudecli.NewGatewayStrategy(),
		// Codex 网关档把 Responses 请求送回本机 AIH Server，会话 id 才能随请求
		// 进入 usage 归集；未注入配置来源时按裸配置的 env_key 形态启动。
		"codex": codexcli.NewGatewayStrategy(nil),
	}
	return strategies, gateways, nil
}
