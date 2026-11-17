package modelsettingssync

import (
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func PolicyKey(accountRef, modelID string) string { return accountRef + "\x00" + modelID }

func ParsePolicyKey(key string) (string, string, error) {
	parts := strings.Split(key, "\x00")
	if len(parts) != 2 {
		return "", "", ErrInvalidSettings
	}
	if _, err := accountcore.ParseAccountRef(parts[0]); err != nil {
		return "", "", ErrInvalidSettings
	}
	if _, err := runtimecore.NewModelID(parts[1]); err != nil {
		return "", "", ErrInvalidSettings
	}
	return parts[0], parts[1], nil
}

// Build preserves the legacy planner's disable-wins rule and only releases
// previously owned overrides. Canonical absence is not a request to create an account.
func Build(settings Settings, snapshot Snapshot) (Plan, error) {
	desired := make(map[string]Write)
	plan := Plan{Managed: []string{}}
	resolve := func(ref string) string {
		if linked, found := snapshot.Links[ref]; found {
			return linked
		}
		return ref
	}
	add := func(ref string, record Record) error {
		policy := accountapp.ModelPolicyInherit
		if !record.Enabled {
			policy = accountapp.ModelPolicyForceDisable
		} else if record.Manual {
			policy = accountapp.ModelPolicyForceEnable
		}
		if policy == accountapp.ModelPolicyInherit {
			return nil
		}
		key := PolicyKey(ref, record.ID)
		if _, _, err := ParsePolicyKey(key); err != nil {
			return err
		}
		if old, found := desired[key]; !found || old.Policy != accountapp.ModelPolicyForceDisable {
			desired[key] = Write{AccountRef: ref, ModelID: record.ID, Policy: policy}
		}
		return nil
	}
	for _, record := range settings.LegacyModels {
		for ref, provider := range snapshot.Accounts {
			if record.Provider != "" && record.Provider != provider {
				continue
			}
			if err := add(ref, record); err != nil {
				return Plan{}, err
			}
		}
	}
	for _, record := range settings.AccountModels {
		ref := resolve(record.AccountRef)
		if _, found := snapshot.Accounts[ref]; !found {
			plan.IgnoredStaleCount++
			continue
		}
		if err := add(ref, record); err != nil {
			return Plan{}, err
		}
	}
	for key := range desired {
		plan.Managed = append(plan.Managed, key)
	}
	sort.Strings(plan.Managed)
	for _, key := range plan.Managed {
		target := desired[key]
		if snapshot.Current[key] != target.Policy {
			plan.Writes = append(plan.Writes, target)
		}
	}
	seen := make(map[string]bool)
	for _, key := range snapshot.Managed {
		ref, id, err := ParsePolicyKey(key)
		if err != nil {
			return Plan{}, err
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		if _, wanted := desired[key]; wanted {
			continue
		}
		if _, exists := snapshot.Accounts[ref]; !exists {
			continue
		}
		if current, exists := snapshot.Current[key]; exists && current != accountapp.ModelPolicyInherit {
			plan.Writes = append(plan.Writes, Write{AccountRef: ref, ModelID: id, Policy: accountapp.ModelPolicyInherit})
		}
	}
	sort.Slice(plan.Writes, func(i, j int) bool {
		return PolicyKey(plan.Writes[i].AccountRef, plan.Writes[i].ModelID) < PolicyKey(plan.Writes[j].AccountRef, plan.Writes[j].ModelID)
	})
	return plan, nil
}
