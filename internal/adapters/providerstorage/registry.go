// Package providerstorage 注册已迁移 Provider 的投影策略与凭据 materializer。
//
// P3.1 先注册 Codex；CodeBuddy 家族四支随后接入。后续 Provider 在这里追加，
// 通用投影执行器不感知 Provider 名。
package providerstorage

import (
	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	agystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/agy"
	clinestorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/cline"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	codexstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codex"
	geministorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/gemini"
	grokstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/grok"
)

// Registry 是 Provider 投影适配器注册表。
type Registry struct {
	policies      map[string]appprojection.Policy
	materializers []appprojection.Materializer
}

// New 创建当前已迁移 Provider 的注册表。
func New() *Registry {
	codexPolicy := codexstorage.Policy()
	geminiPolicy := geministorage.Policy()
	agyPolicy := agystorage.Policy()
	grokPolicy := grokstorage.Policy()
	clinePolicy := clinestorage.Policy()
	policies := map[string]appprojection.Policy{
		codexPolicy.Provider:  codexPolicy,
		geminiPolicy.Provider: geminiPolicy,
		agyPolicy.Provider:    agyPolicy,
		grokPolicy.Provider:   grokPolicy,
		clinePolicy.Provider:  clinePolicy,
	}
	materializers := []appprojection.Materializer{
		codexstorage.Materializer{},
		geministorage.Materializer{},
		agystorage.Materializer{},
		grokstorage.Materializer{},
		clinestorage.Materializer{},
	}
	for _, providerID := range codebuddyfamilystorage.ProviderIDs() {
		policy, ok := codebuddyfamilystorage.Policy(providerID)
		if !ok {
			continue
		}
		materializer, err := codebuddyfamilystorage.NewMaterializer(providerID)
		if err != nil {
			continue
		}
		policies[providerID] = policy
		materializers = append(materializers, materializer)
	}
	return &Registry{policies: policies, materializers: materializers}
}

// Policy 返回 Provider 的投影策略。
func (registry *Registry) Policy(providerID string) (appprojection.Policy, bool) {
	if registry == nil {
		return appprojection.Policy{}, false
	}
	policy, ok := registry.policies[providerID]
	return policy, ok
}

// Materializers 返回注册的 materializer 副本。
func (registry *Registry) Materializers() []appprojection.Materializer {
	if registry == nil {
		return nil
	}
	return append([]appprojection.Materializer(nil), registry.materializers...)
}
