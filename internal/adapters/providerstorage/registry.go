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
	kimistorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/kimi"
	kirostorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/kiro"
	qoderstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/qoder"
	zcodestorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/zcode"
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
	kimiPolicy := kimistorage.Policy()
	kiroPolicy := kirostorage.Policy()
	zcodePolicy := zcodestorage.Policy()
	qoderPolicy, _ := qoderstorage.Policy("qoder")
	qodercnPolicy, _ := qoderstorage.Policy("qodercn")
	policies := map[string]appprojection.Policy{
		codexPolicy.Provider:   codexPolicy,
		geminiPolicy.Provider:  geminiPolicy,
		agyPolicy.Provider:     agyPolicy,
		grokPolicy.Provider:    grokPolicy,
		clinePolicy.Provider:   clinePolicy,
		kimiPolicy.Provider:    kimiPolicy,
		kiroPolicy.Provider:    kiroPolicy,
		zcodePolicy.Provider:   zcodePolicy,
		qoderPolicy.Provider:   qoderPolicy,
		qodercnPolicy.Provider: qodercnPolicy,
	}
	materializers := []appprojection.Materializer{
		codexstorage.Materializer{},
		geministorage.Materializer{},
		agystorage.Materializer{},
		grokstorage.Materializer{},
		clinestorage.Materializer{},
		kimistorage.Materializer{},
		kirostorage.Materializer{},
		zcodestorage.Materializer{},
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
	if qoderMaterializer, ok := qoderstorage.NewMaterializer("qoder"); ok {
		materializers = append(materializers, qoderMaterializer)
	}
	if qodercnMaterializer, ok := qoderstorage.NewMaterializer("qodercn"); ok {
		materializers = append(materializers, qodercnMaterializer)
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
