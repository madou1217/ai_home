package harnessrun

import (
	"context"
	"fmt"
	"sort"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/harnesses"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// ModelsScope describes a read-only view, not a native harness launch intent.
// An omitted account means the provider's aggregate catalog (or the whole pool).
type ModelsScope struct {
	Provider string
	Account  string
	Harness  string
}

// ModelModalities contains only capabilities published by the target Server.
type ModelModalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// ListedModel preserves the Server's model identifiers and ownership facts.
type ListedModel struct {
	ID               string           `json:"id"`
	OwnedBy          string           `json:"owned_by"`
	Providers        []string         `json:"providers"`
	AccountRefs      []string         `json:"account_refs"`
	Modalities       *ModelModalities `json:"aih_modalities,omitempty"`
	ReasoningEfforts []string         `json:"aih_reasoning_efforts,omitempty"`
}

// ModelsList is a credential-free view of a cached Server catalog.
type ModelsList struct {
	Object     string        `json:"object"`
	Provider   string        `json:"provider,omitempty"`
	Harness    string        `json:"harness,omitempty"`
	AccountRef string        `json:"account_ref,omitempty"`
	Source     string        `json:"source"`
	UpdatedAt  int64         `json:"updated_at"`
	Data       []ListedModel `json:"data"`
}

// ListModels reads the same catalog used by the WebUI, retaining server-side
// alias expansion and model settings. It never prepares a harness, probes an
// upstream, writes a projection, or falls back to an invented/offline catalog.
func ListModels(ctx context.Context, httpClient managementapi.HTTPClient, config managementapi.Config, scope ModelsScope) (ModelsList, error) {
	result := ModelsList{Object: "list", Source: modelsCatalogPath, Data: []ListedModel{}}
	client, err := managementapi.New(httpClient, config)
	if err != nil {
		return result, err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return result, err
	}
	if scope.Provider != "" {
		canonical, found := catalog.CanonicalID(scope.Provider)
		if !found {
			return result, fmt.Errorf("未知 Provider：%s", scope.Provider)
		}
		scope.Provider = canonical
	}
	if scope.Harness != "" {
		harness, found := harnesses.Get(scope.Harness)
		if !found || !harness.SupportsModelSelection {
			return result, fmt.Errorf("harness 不支持模型查看：%s", scope.Harness)
		}
		scope.Harness = harness.ID
	}
	result.Provider, result.Harness = scope.Provider, scope.Harness
	var account *managementapi.AccountSnapshot
	if scope.Account != "" {
		selected, selectErr := resolveModelsAccount(ctx, client, scope)
		if selectErr != nil {
			return result, selectErr
		}
		account = &selected
		result.AccountRef = selected.AccountRef.String()
		result.Provider = selected.ProviderID
	}
	published, err := readModelsCatalog(ctx, httpClient, config, result.AccountRef)
	if err != nil {
		return result, err
	}
	result.UpdatedAt = published.UpdatedAt
	if account != nil && !account.Enabled {
		return result, nil
	}
	// In an account view, the effective model policy is authoritative. Catalog
	// cache entries or global aliases must not resurrect a force-disabled model.
	var effective map[string]bool
	if account != nil {
		models, listErr := client.ListAccountModels(ctx, account.AccountRef)
		if listErr != nil {
			return result, listErr
		}
		effective = make(map[string]bool, len(models.Models))
		for _, model := range models.Models {
			if model.Effective {
				effective[model.ModelID] = true
			}
		}
	}
	providerModels := make(map[string]bool)
	for _, id := range published.ByProvider[result.Provider] {
		providerModels[id] = true
	}
	seen := make(map[string]bool, len(published.Data))
	for _, model := range published.Data {
		if model.ID == "" || seen[model.ID] {
			continue
		}
		if effective != nil && !effective[model.ID] {
			continue
		}
		if result.Provider != "" {
			// owned_by is a model vendor, not the account's provider. E.g. GPT
			// served by AGY must not appear under Codex merely due to its name.
			owned := containsString(model.Providers, result.Provider)
			alias := len(model.Providers) == 0 && providerModels[model.ID]
			if !owned && !alias {
				continue
			}
		}
		if scope.Harness != "" && model.Modalities != nil && len(model.Modalities.Output) > 0 && !containsString(model.Modalities.Output, "text") {
			// Match fetchGatewayModelCatalog: pure image output cannot be
			// selected by Pi/DSH, but stays visible in a provider-only view.
			continue
		}
		seen[model.ID] = true
		result.Data = append(result.Data, model)
	}
	sort.Slice(result.Data, func(i, j int) bool { return result.Data[i].ID < result.Data[j].ID })
	return result, nil
}

func resolveModelsAccount(ctx context.Context, client *managementapi.Client, scope ModelsScope) (managementapi.AccountSnapshot, error) {
	var ref accountcore.AccountRef
	if isAccountRef(scope.Account) {
		ref, _ = accountcore.ParseAccountRef(scope.Account)
	} else {
		if scope.Provider == "" || !numericCLIAccountID.MatchString(scope.Account) {
			return managementapi.AccountSnapshot{}, fmt.Errorf("账号需要 accountRef；数字账号还需要 --provider <p>")
		}
		id, err := accountcore.ParseCLIAccountID(scope.Account)
		if err != nil {
			return managementapi.AccountSnapshot{}, fmt.Errorf("账号 ID 必须是正整数")
		}
		selected, err := client.ResolveAlias(ctx, scope.Provider, id)
		if err != nil {
			return managementapi.AccountSnapshot{}, err
		}
		ref = selected.AccountRef
	}
	selected, err := client.GetAccount(ctx, ref)
	if err != nil {
		return selected, err
	}
	if scope.Provider != "" && selected.ProviderID != scope.Provider {
		return selected, fmt.Errorf("账号所属 Provider 是 %s，不是 %s", selected.ProviderID, scope.Provider)
	}
	return selected, nil
}

// ModelsAccountValid is shared by the CLI parser; no database is consulted.
func ModelsAccountValid(account string, allowNumeric bool) bool {
	if isAccountRef(account) {
		return true
	}
	_, err := accountcore.ParseCLIAccountID(account)
	return allowNumeric && err == nil
}
