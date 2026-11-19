package harnessrun

import (
	"regexp"
	"strings"
)

// sessionModelAliasRule 复刻 Node lib/server/session-model-alias.js 中
// `aih harness` 需要的解析结果。
type sessionModelAliasRule struct {
	Source   string
	Target   string
	Provider string
	Account  string
}

var (
	sessionAliasAccountSlot = regexp.MustCompile(`^[0-9]+$`)
	sessionAliasAccountRef  = regexp.MustCompile(`^acct_[A-Za-z0-9]+$`)
)

// parseSessionModelAliasSpec 解析 `source=target`；target 可带 provider / 账号
// 命名空间，但只有第一段恰为已注册 Provider 时才拆。
func parseSessionModelAliasSpec(raw string, knownProvider func(string) bool) *sessionModelAliasRule {
	text := strings.TrimSpace(raw)
	if text == "" {
		return nil
	}
	source := "*"
	targetText := text
	if index := strings.Index(text, "="); index >= 0 {
		if left := strings.TrimSpace(text[:index]); left != "" {
			source = left
		}
		targetText = text[index+1:]
	}
	targetText = strings.TrimSpace(targetText)
	if targetText == "" {
		return nil
	}
	if scoped, ok := splitProviderTarget(targetText, knownProvider); ok {
		return &sessionModelAliasRule{
			Source:   source,
			Target:   scoped.Target,
			Provider: scoped.Provider,
			Account:  scoped.Account,
		}
	}
	return &sessionModelAliasRule{Source: source, Target: targetText}
}

type providerTarget struct {
	Provider string
	Account  string
	Target   string
}

// splitProviderTarget 只把第一段是已注册 Provider 的输入拆成命名空间，
// 避免把带点的模型名（gemini-2.5-pro）误拆。
func splitProviderTarget(raw string, knownProvider func(string) bool) (providerTarget, bool) {
	parts := strings.Split(raw, ".")
	if len(parts) < 2 || knownProvider == nil {
		return providerTarget{}, false
	}
	provider := strings.ToLower(strings.TrimSpace(parts[0]))
	if provider == "" || !knownProvider(provider) {
		return providerTarget{}, false
	}
	rest := parts[1:]
	account := ""
	if len(rest) > 0 && (sessionAliasAccountSlot.MatchString(rest[0]) || sessionAliasAccountRef.MatchString(rest[0])) {
		account = rest[0]
		rest = rest[1:]
	}
	target := strings.TrimSpace(strings.Join(rest, "."))
	if target == "" {
		return providerTarget{}, false
	}
	return providerTarget{Provider: provider, Account: account, Target: target}, true
}

// buildSessionModelAliasRule 由启动参数得到本次规则：显式 `source=target` 保留
// 写出来的 source；否则 `--model` 是 source，没有就是通配。
func buildSessionModelAliasRule(model string, alias string, knownProvider func(string) bool) *sessionModelAliasRule {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return nil
	}
	parsed := parseSessionModelAliasSpec(alias, knownProvider)
	if parsed == nil {
		return nil
	}
	if strings.Contains(alias, "=") {
		return parsed
	}
	source := strings.TrimSpace(model)
	if source == "" {
		source = "*"
	}
	parsed.Source = source
	return parsed
}

// resolveHarnessAliasLaunchModel 把 `--model-alias` 落成直接按目标模型启动。
//
// harness 的模型在启动时定死（pi / dsh 都没有会话内换模型的通道），所以
// 「A 用 B 转发」等价于「直接按 B 启动」——规则不进网关。
func resolveHarnessAliasLaunchModel(model string, alias string, knownProvider func(string) bool) (string, *sessionModelAliasRule, bool) {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return strings.TrimSpace(model), nil, true
	}
	rule := buildSessionModelAliasRule(model, alias, knownProvider)
	if rule == nil {
		return "", nil, false
	}
	return rule.Target, rule, true
}
