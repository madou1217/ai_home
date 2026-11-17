package nativeexportread

import (
	"errors"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	ErrSelector  = errors.New("public_export_selector_unknown")
	ErrNoMatches = errors.New("public_export_no_matches")
)

type Selection struct {
	Records     []Record
	AccountRefs []string
	Providers   []string
}

// Select preserves the public command's provider/ref/number union, including
// duplicate selector metadata used by the old default filename rule.
func Select(selectors []string, records []Record, catalog *providers.Catalog) (Selection, error) {
	result := Selection{Records: []Record{}, AccountRefs: []string{}, Providers: []string{}}
	if catalog == nil {
		return result, ErrSelector
	}
	byRef := make(map[string]Record, len(records))
	for _, record := range records {
		byRef[record.AccountRef] = record
	}
	for _, raw := range selectors {
		token := strings.TrimSpace(raw)
		lower := strings.ToLower(token)
		if _, err := accountcore.ParseAccountRef(lower); err == nil {
			if _, exists := byRef[lower]; !exists {
				return result, ErrSelector
			}
			result.AccountRefs = append(result.AccountRefs, lower)
			continue
		}
		parts := strings.SplitN(lower, ":", 3)
		provider, ok := catalog.CanonicalID(parts[0])
		if !ok {
			return result, ErrSelector
		}
		if len(parts) < 2 || parts[1] == "" {
			result.Providers = append(result.Providers, provider)
			continue
		}
		for _, id := range strings.Split(parts[1], ",") {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			found := false
			for _, record := range records {
				if record.Provider == provider && record.CLIAccountID == id {
					result.AccountRefs = append(result.AccountRefs, record.AccountRef)
					found = true
					break
				}
			}
			if !found {
				return result, ErrSelector
			}
		}
	}
	selectedProviders := make(map[string]bool)
	for _, provider := range result.Providers {
		selectedProviders[provider] = true
	}
	if len(result.Providers) > 0 {
		refs := []string{}
		seen := map[string]bool{}
		for _, ref := range result.AccountRefs {
			if !selectedProviders[byRef[ref].Provider] && !seen[ref] {
				refs = append(refs, ref)
				seen[ref] = true
			}
		}
		for _, record := range records {
			if selectedProviders[record.Provider] && !seen[record.AccountRef] {
				refs = append(refs, record.AccountRef)
				seen[record.AccountRef] = true
			}
		}
		result.AccountRefs = refs
	}
	selected := map[string]bool{}
	for _, ref := range result.AccountRefs {
		selected[ref] = true
	}
	if len(selectors) > 0 && len(selected) == 0 {
		return result, ErrNoMatches
	}
	for _, record := range records {
		if len(selectors) == 0 || selected[record.AccountRef] {
			result.Records = append(result.Records, record)
		}
	}
	return result, nil
}

// Tokens preserves provider-scoped export syntax without keeping a second Node
// selector compiler. Only a final .json token is an output filename.
func Tokens(tokens []string, provider string, catalog *providers.Catalog) ([]string, string, error) {
	values := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token = strings.TrimSpace(token); token != "" {
			values = append(values, token)
		}
	}
	target := ""
	if len(values) > 0 && strings.HasSuffix(strings.ToLower(values[len(values)-1]), ".json") {
		target = values[len(values)-1]
		values = values[:len(values)-1]
	}
	if provider != "" {
		canonical, ok := catalog.CanonicalID(provider)
		if !ok {
			return nil, "", ErrSelector
		}
		ids := []string{}
		for _, value := range values {
			if digits(value) {
				ids = append(ids, value)
			}
		}
		value := canonical
		if len(ids) > 0 {
			value += ":" + strings.Join(ids, ",")
		}
		values = []string{value}
	}
	return values, target, nil
}
