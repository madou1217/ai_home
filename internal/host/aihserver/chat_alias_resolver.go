package aihserver

import (
	"context"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// chatAliasResolver 在 relay/native chat 入口做一次别名前置解析。
//
// Scope 的匹配口径与 canonical 路由一致：all 对任意模型生效，其它 provider
// 只在“请求模型归属该 provider”时命中。relay 目标不经过 canonical RouteRule，
// 因此必须在账号征召前把 model 改成真实目标。
type chatAliasResolver struct {
	aliases *modelalias.Store
	models  accountapp.RoutableModelReader
}

func newChatAliasResolver(aliases *modelalias.Store, models accountapp.RoutableModelReader) *chatAliasResolver {
	if aliases == nil || models == nil {
		return nil
	}
	return &chatAliasResolver{aliases: aliases, models: models}
}

type chatAliasMatch struct {
	target    string
	wildcard  bool
	prefixLen int
	priority  int32
	order     int
}

// ResolveChatModel 返回请求模型应改写的真实目标；没有匹配时返回 false。
func (resolver *chatAliasResolver) ResolveChatModel(ctx context.Context, model string) (string, bool) {
	if resolver == nil || resolver.aliases == nil || resolver.models == nil {
		return "", false
	}
	requested := strings.TrimSpace(model)
	if requested == "" {
		return "", false
	}
	records := resolver.aliases.Snapshot().Records()
	if len(records) == 0 {
		return "", false
	}
	models, err := resolver.models.ListRoutableModels(ctx)
	if err != nil {
		return "", false
	}
	providersByModel := make(map[string]map[string]bool, len(models))
	for _, item := range models {
		modelID := item.ModelID().String()
		if providersByModel[modelID] == nil {
			providersByModel[modelID] = make(map[string]bool)
		}
		providersByModel[modelID][strings.ToLower(item.ProviderID())] = true
	}
	matches := make([]chatAliasMatch, 0, len(records))
	for index, record := range records {
		if !record.IsEnabled() || !record.IsValid() {
			continue
		}
		match, ok := matchChatAlias(record.Alias, requested)
		if !ok {
			continue
		}
		scope := strings.ToLower(strings.TrimSpace(record.ScopeProvider()))
		if scope != modelalias.ScopeAll && !providersByModel[requested][scope] {
			continue
		}
		target, err := runtimecore.NewModelID(strings.TrimSpace(record.Target))
		if err != nil || len(providersByModel[target.String()]) == 0 {
			continue
		}
		explicit := strings.ToLower(strings.TrimSpace(record.ResolvedTargetProvider()))
		if explicit != modelalias.TargetProviderAuto && !providersByModel[target.String()][explicit] {
			continue
		}
		match.target = target.String()
		match.priority = record.Priority
		match.order = index
		matches = append(matches, match)
	}
	if len(matches) == 0 {
		return "", false
	}
	sort.SliceStable(matches, func(left, right int) bool {
		if matches[left].wildcard != matches[right].wildcard {
			return !matches[left].wildcard
		}
		if matches[left].prefixLen != matches[right].prefixLen {
			return matches[left].prefixLen > matches[right].prefixLen
		}
		if matches[left].priority != matches[right].priority {
			return matches[left].priority > matches[right].priority
		}
		return matches[left].order < matches[right].order
	})
	return matches[0].target, true
}

func matchChatAlias(pattern, model string) (chatAliasMatch, bool) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return chatAliasMatch{}, false
	}
	if !strings.HasSuffix(pattern, "*") {
		if pattern == model {
			return chatAliasMatch{}, true
		}
		return chatAliasMatch{}, false
	}
	prefix := strings.TrimSuffix(pattern, "*")
	if strings.Count(pattern, "*") != 1 || len(prefix) < 2 || !strings.HasPrefix(model, prefix) {
		return chatAliasMatch{}, false
	}
	return chatAliasMatch{wildcard: true, prefixLen: len(prefix)}, true
}
