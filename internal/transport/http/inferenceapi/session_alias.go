package inferenceapi

import (
	"strings"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/runtime/sessionmodelalias"
)

// ApplySessionModelAlias 在 Canonical 路由前应用一次性模型改写规则。
// 规则只改模型名与目标 Provider；账号前缀由调用方按可解析形式另行钉选。
func ApplySessionModelAlias(header string, request inference.Request) inference.Request {
	rule, ok := sessionmodelalias.Parse(header)
	if !ok || !rule.Matches(request.Model()) {
		return request
	}
	updated := request.WithModel(rule.Target)
	if strings.TrimSpace(rule.Provider) != "" {
		updated = updated.WithProviderHint(rule.Provider)
	}
	if strings.TrimSpace(rule.Account) != "" {
		updated = updated.WithAccountHint(rule.Account)
	}
	return updated
}
