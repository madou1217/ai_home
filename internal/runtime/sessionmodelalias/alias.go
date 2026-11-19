// Package sessionmodelalias 解析单次会话的模型改写规则（x-aih-model-alias）。
package sessionmodelalias

import (
	"encoding/base64"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// HeaderName 是 relay 传递一次性模型改写规则的请求头。
const HeaderName = "X-Aih-Model-Alias"

// Rule 是一条会话级模型改写规则。
type Rule struct {
	Source   string
	Target   string
	Provider string
	Account  string
}

var (
	providerCatalogOnce sync.Once
	knownProviders      map[string]bool
)

func knownProvider(value string) bool {
	providerCatalogOnce.Do(func() {
		knownProviders = map[string]bool{}
		catalog, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return
		}
		for _, definition := range catalog.List() {
			knownProviders[strings.ToLower(strings.TrimSpace(definition.ID))] = true
		}
	})
	return knownProviders[strings.ToLower(strings.TrimSpace(value))]
}

// Parse 解析 `source=target`；source 省略视为通配。target 可带 provider 与账号前缀。
func Parse(spec string) (Rule, bool) {
	raw := strings.TrimSpace(spec)
	if raw == "" {
		return Rule{}, false
	}
	source := "*"
	targetText := raw
	if index := strings.Index(raw, "="); index >= 0 {
		if candidate := strings.TrimSpace(raw[:index]); candidate != "" {
			source = candidate
		}
		targetText = strings.TrimSpace(raw[index+1:])
	}
	if targetText == "" {
		return Rule{}, false
	}
	rule := Rule{Source: source, Target: targetText}
	parts := strings.Split(targetText, ".")
	if len(parts) >= 2 && knownProvider(parts[0]) {
		provider := strings.ToLower(strings.TrimSpace(parts[0]))
		rest := parts[1:]
		account := ""
		if len(rest) > 0 && (isDigits(rest[0]) || isAccountRef(rest[0])) {
			account = rest[0]
			rest = rest[1:]
		}
		target := strings.TrimSpace(strings.Join(rest, "."))
		if target == "" {
			return Rule{}, false
		}
		rule.Provider = provider
		rule.Account = account
		rule.Target = target
	}
	return rule, true
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func isAccountRef(value string) bool {
	text := strings.TrimSpace(value)
	if !strings.HasPrefix(text, "acct_") {
		return false
	}
	for _, char := range text[len("acct_"):] {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return len(text) > len("acct_")
}

// Matches 判断规则是否命中客户端请求的模型。
func (rule Rule) Matches(model string) bool {
	return rule.Source == "*" || strings.EqualFold(strings.TrimSpace(rule.Source), strings.TrimSpace(model))
}

// PathPrefix 是模型改写规则的第二条送达通道。
const PathPrefix = "/-/ma/"

// DecodeToken 解码路径前缀中的 base64url 规则；非法返回 false。
func DecodeToken(token string) (Rule, bool) {
	raw := strings.TrimSpace(token)
	if raw == "" {
		return Rule{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != raw {
		return Rule{}, false
	}
	return Parse(string(decoded))
}

// SplitPath 在路由匹配前拆掉 /-/ma/<token> 前缀并返回规则与剩余路径。
func SplitPath(path string) (Rule, string, bool) {
	if !strings.HasPrefix(path, PathPrefix) {
		return Rule{}, path, false
	}
	rest := path[len(PathPrefix):]
	index := strings.Index(rest, "/")
	if index < 0 {
		return Rule{}, path, false
	}
	rule, ok := DecodeToken(rest[:index])
	if !ok {
		return Rule{}, path, false
	}
	stripped := rest[index:]
	if stripped == "" {
		stripped = "/"
	}
	return rule, stripped, true
}

// String 把规则编码回头值形态。
func (rule Rule) String() string {
	source := strings.TrimSpace(rule.Source)
	if source == "" {
		source = "*"
	}
	target := strings.TrimSpace(rule.Target)
	if strings.TrimSpace(rule.Provider) != "" {
		target = strings.TrimSpace(rule.Provider) + "."
		if strings.TrimSpace(rule.Account) != "" {
			target += strings.TrimSpace(rule.Account) + "."
		}
		target += strings.TrimSpace(rule.Target)
	}
	return source + "=" + target
}
