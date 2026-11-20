package aihcli

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
	agycli "github.com/madou1217/ai_home/internal/adapters/agy/clilaunch"
	claudecli "github.com/madou1217/ai_home/internal/adapters/claude/clilaunch"
	clinecli "github.com/madou1217/ai_home/internal/adapters/cline/clilaunch"
	codexcli "github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
	geminicli "github.com/madou1217/ai_home/internal/adapters/gemini/clilaunch"
	grokcli "github.com/madou1217/ai_home/internal/adapters/grok/clilaunch"
	kimicli "github.com/madou1217/ai_home/internal/adapters/kimi/clilaunch"
	kirocli "github.com/madou1217/ai_home/internal/adapters/kiro/clilaunch"
	opencodecli "github.com/madou1217/ai_home/internal/adapters/opencode/clilaunch"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	qodercli "github.com/madou1217/ai_home/internal/adapters/qoder/clilaunch"
	zcodecli "github.com/madou1217/ai_home/internal/adapters/zcode/clilaunch"
)

// nativeStrategyRegistration 声明一个由本组合根承接的 Native Direct Provider。
//
// 注册表是「该 Provider 有没有原生启动面」的唯一事实来源：运行期装配与 CLI 的
// 能力判定（SupportsNativeCLI）都读它。此前能力判定另抄了一份 Provider 名单，
// 新增 Provider 时漏改任一处，就会出现「策略已注册但统一动词不被改写」或
// 「名单里有、实际没有策略」的漂移。
type nativeStrategyRegistration struct {
	ProviderID string
	New        func() (providerlaunch.Strategy, error)
}

// nativeStrategyRegistrations 按 CLI 展示顺序登记 Native Direct 策略。
//
// CodeBuddy 家族不在此表：它们的 Provider 集合由 providerstorage 的家族布局
// 声明，运行期按同一份布局动态追加，家族名单不出现第二份拷贝。
var nativeStrategyRegistrations = []nativeStrategyRegistration{
	{ProviderID: "codex", New: func() (providerlaunch.Strategy, error) {
		return codexcli.NewStrategy(), nil
	}},
	{ProviderID: "claude", New: func() (providerlaunch.Strategy, error) {
		return claudecli.NewStrategy(), nil
	}},
	{ProviderID: "gemini", New: func() (providerlaunch.Strategy, error) {
		return geminicli.NewStrategy(), nil
	}},
	{ProviderID: "agy", New: func() (providerlaunch.Strategy, error) {
		return agycli.NewStrategy(), nil
	}},
	{ProviderID: "grok", New: func() (providerlaunch.Strategy, error) {
		return grokcli.NewStrategy(), nil
	}},
	{ProviderID: "cline", New: func() (providerlaunch.Strategy, error) {
		return clinecli.NewStrategy(), nil
	}},
	{ProviderID: "kimi", New: func() (providerlaunch.Strategy, error) {
		return kimicli.NewStrategy(), nil
	}},
	{ProviderID: "zcode", New: func() (providerlaunch.Strategy, error) {
		return zcodecli.NewStrategy(), nil
	}},
	{ProviderID: "opencode", New: func() (providerlaunch.Strategy, error) {
		return opencodecli.NewStrategy(), nil
	}},
	{ProviderID: "kiro", New: func() (providerlaunch.Strategy, error) {
		return kirocli.NewStrategy(), nil
	}},
	{ProviderID: "qoder", New: func() (providerlaunch.Strategy, error) {
		return qodercli.NewStrategy("qoder")
	}},
	{ProviderID: "qodercn", New: func() (providerlaunch.Strategy, error) {
		return qodercli.NewStrategy("qodercn")
	}},
}

// newNativeLaunchStrategies 按注册表构造策略，并校验策略自报身份与登记一致。
//
// 身份校验让「注册表写错 ProviderID」在启动时就失败，而不是等到某个命令
// 走到错误的规划分支。
func newNativeLaunchStrategies() ([]providerlaunch.Strategy, error) {
	strategies := make([]providerlaunch.Strategy, 0, len(nativeStrategyRegistrations))
	for _, registration := range nativeStrategyRegistrations {
		strategy, err := registration.New()
		if err != nil {
			return nil, fmt.Errorf(
				"创建 %s Native Direct 策略失败: %w",
				registration.ProviderID,
				err,
			)
		}
		if strategy == nil || strategy.ProviderID() != registration.ProviderID {
			return nil, fmt.Errorf(
				"Native Direct 策略身份与注册表不一致: %s",
				registration.ProviderID,
			)
		}
		strategies = append(strategies, strategy)
	}
	return strategies, nil
}

// supportedNativeCLIProvider 报告本组合根是否承接该 Provider 的原生启动。
func supportedNativeCLIProvider(providerID string) bool {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if codebuddyfamilystorage.IsFamilyProvider(normalized) {
		return true
	}
	for _, registration := range nativeStrategyRegistrations {
		if registration.ProviderID == normalized {
			return true
		}
	}
	return false
}
