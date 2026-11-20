package chatruntime

import (
	"context"
	"net/http"
	"slices"
	"sort"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// listPublishedChatModels narrows the gateway's execution catalog to a pinned
// account, or preserves its global pool for All accounts. Discovery snapshots
// alone cannot become composer defaults or valid turn selections.
func (r *ModelCatalogResolver) listPublishedChatModels(ctx context.Context, session *Session, idx *AccountModelIndex) ([]ModelEntry, error) {
	models, err := r.GatewayModels.ListRoutableModelCarriers(ctx)
	if err != nil {
		return nil, err
	}
	accountRef := strings.TrimSpace(session.ExecutionAccountRef)
	pinned := !IsGatewayRuntimeScope(accountRef)
	if pinned {
		resolver := r.accountRefResolver(ctx)
		accountRef = mapAccountRefKey(accountRef, idx.AccountProvider, resolver)
		if r.GatewayAccounts == nil {
			return nil, NewErrorWithMessage("chat_harness_account_models_unavailable", http.StatusUnprocessableEntity,
				"当前账号不可用，请选择可用账号或全部账号", nil)
		}
	}
	providersByModel := map[string][]string{}
	entries := map[string]ModelEntry{}
	for _, model := range models {
		id, provider := model.ModelID().String(), model.ProviderID()
		if !r.supportsChatOutput(provider, id) {
			continue
		}
		if pinned {
			candidates, err := r.GatewayAccounts.LoadRoutingCandidates(ctx, provider, model.ModelID())
			if err != nil {
				return nil, err
			}
			if _, found := candidates.FindByRef(accountcore.AccountRef(accountRef)); !found {
				continue
			}
		}
		providersByModel[id] = append(providersByModel[id], provider)
		if _, exists := entries[id]; !exists {
			entries[id] = r.buildModelEntry(provider, accountRef, id, idx)
		}
	}
	aliases, err := r.GatewayModels.ListDisplayModelsForProtocol(ctx, inference.ClientProtocolOpenAIChatCompletions)
	if err != nil {
		return nil, err
	}
	for _, alias := range aliases {
		providers := providersByModel[alias.Target]
		if alias.Alias == "" || len(providers) == 0 || (alias.Provider != "" && !slices.Contains(providers, alias.Provider)) {
			continue
		}
		if _, exists := entries[alias.Alias]; exists {
			continue
		}
		provider := alias.Provider
		if provider == "" {
			provider = providers[0]
		}
		entry := r.buildModelEntry(provider, accountRef, alias.Target, idx)
		entry.Model, entry.DisplayName = alias.Alias, alias.Alias
		entries[alias.Alias] = entry
	}
	if len(entries) == 0 {
		return nil, NewErrorWithMessage("chat_harness_account_models_unavailable", http.StatusUnprocessableEntity,
			"当前没有可发送消息的模型，请检查账号和模型状态", nil)
	}
	ids := make([]string, 0, len(entries))
	for id := range entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]ModelEntry, 0, len(ids))
	for _, id := range ids {
		out = append(out, entries[id])
	}
	return out, nil
}

// The shared gateway also publishes image/audio-only models for their own APIs.
// Unknown metadata keeps the existing text fallback; known non-text output must
// not become a Chat selection or default.
func (r *ModelCatalogResolver) supportsChatOutput(provider, model string) bool {
	if r.MetadataIndex == nil {
		return true
	}
	modalities, known := r.MetadataIndex.LookupModalities(provider, model)
	return !known || slices.Contains(modalities.Output(), "text")
}
