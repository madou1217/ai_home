package chatruntime

import (
	"context"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

func (r *NativeModelCatalogResolver) readAccountModels(ctx context.Context, target NativeExecutionDescriptor) (nativeModelCatalogRead, error) {
	read := nativeModelCatalogRead{observation: NativeModelCatalogObservation{Source: "account_models"}}
	if r.AccountStore == nil {
		return read, NewError("native_model_accounts_unavailable", http.StatusServiceUnavailable, nil)
	}
	if err := r.checkNativeAccount(ctx, target); err != nil {
		return read, err
	}
	catalog, err := r.AccountStore.ListAllAccountModels(ctx)
	if err != nil {
		return read, nativeModelSourceError("native_model_catalog_unavailable", err)
	}
	var set *accountapp.AccountModelSet
	for i := range catalog.Sets {
		if catalog.Sets[i].AccountRef.String() != target.AccountRef {
			continue
		}
		if set != nil || catalog.Sets[i].ProviderID != target.Provider {
			return read, NewError("native_model_catalog_identity_mismatch", http.StatusUnprocessableEntity, nil)
		}
		set = &catalog.Sets[i]
	}
	policies := map[string]accountapp.AccountModel{}
	if set != nil {
		for _, model := range set.Models {
			id := model.ModelID().String()
			if !model.IsValid() || model.AccountRef().String() != target.AccountRef {
				return read, NewError("native_model_catalog_invalid", http.StatusServiceUnavailable, nil)
			}
			if _, duplicate := policies[id]; duplicate {
				return read, NewError("native_model_catalog_invalid", http.StatusServiceUnavailable, nil)
			}
			policies[id] = model
		}
	}

	ids := []string{}
	if r.ReadNativeModels != nil {
		read.observation.Source = "native_catalog"
		native, err := r.ReadNativeModels(ctx, target)
		if err != nil {
			return read, nativeModelSourceError("native_model_catalog_unavailable", err)
		}
		if native.Execution != target {
			return read, NewError("native_model_catalog_identity_mismatch", http.StatusUnprocessableEntity, nil)
		}
		if !native.Known {
			return read, NewError("native_model_catalog_unknown", http.StatusServiceUnavailable, nil)
		}
		for _, id := range native.Models {
			if _, err := runtimecore.NewModelID(id); err != nil {
				return read, NewError("native_model_catalog_invalid", http.StatusServiceUnavailable, nil)
			}
			// A fresh native directory supersedes an old discovery result, but
			// never the exact account/model manual deny policy.
			if policy, found := policies[id]; !found || policy.ManualPolicy() != accountapp.ModelPolicyForceDisable {
				ids = append(ids, id)
			}
		}
		for id, policy := range policies {
			if policy.ManualPolicy() == accountapp.ModelPolicyForceEnable {
				ids = append(ids, id)
			}
		}
		read.defaultModel = native.DefaultModel
	} else {
		if set == nil {
			return read, NewError("native_model_catalog_unknown", http.StatusServiceUnavailable, nil)
		}
		read.observation.StaleKnown = true
		read.observation.Stale = set.LastSource == accountapp.ModelProbeSourceError || set.LastErrorCode != ""
		if read.observation.Stale {
			read.observation.ProbeErrorCode = nativeModelProbeErrorCode(set.LastErrorCode)
		}
		if set.LastSource != "" && set.LastSource != accountapp.ModelProbeSourceRemote && set.LastSource != accountapp.ModelProbeSourceError {
			return read, NewError("native_model_catalog_invalid", http.StatusServiceUnavailable, nil)
		}
		// A refresh failure updates the probe, not account_models. Keep the
		// exact last-good rows usable, applying current manual policy normally.
		// Without any known rows, failure must not masquerade as known-empty.
		if len(set.Models) == 0 {
			if read.observation.Stale {
				return read, nativeModelObservedError("native_model_catalog_probe_failed", http.StatusServiceUnavailable, read.observation)
			}
			if set.LastAttemptAt.IsZero() || set.LastSource == "" {
				return read, nativeModelObservedError("native_model_catalog_unknown", http.StatusServiceUnavailable, read.observation)
			}
			if set.LastModelCount > 0 {
				return read, NewError("native_model_catalog_invalid", http.StatusServiceUnavailable, nil)
			}
		}
		for id, policy := range policies {
			// Honor the canonical case-sensitive, account-local policy exactly;
			// force_enable is a user policy, not claimed upstream validation.
			if policy.Effective() {
				ids = append(ids, id)
			}
		}
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !r.supportsNativeText(target.Provider, id) {
			continue
		}
		// Reuse the actual command encoder. Unknown AGY IDs must not silently
		// drop --model and thereby execute the CLI's unrelated default.
		if target.Provider == "agy" && (sessionchat.IsImageGenerationModel(id) || sessionchat.ResolveAgyCliModelName(id) == "") {
			continue
		}
		out = append(out, id)
	}
	if len(ids) > 0 && len(out) == 0 {
		return read, nativeModelObservedError("native_model_selection_unsupported", http.StatusUnprocessableEntity, read.observation)
	}
	read.models = out
	return read, nil
}

func (r *NativeModelCatalogResolver) checkNativeAccount(ctx context.Context, target NativeExecutionDescriptor) error {
	var after accountcore.AccountRef
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		query, err := accountapp.NewOverviewQuery(after, accountapp.DefaultOverviewLimit)
		if err != nil {
			return nativeModelSourceError("native_model_accounts_unavailable", err)
		}
		page, err := r.AccountStore.ListAccountOverviews(ctx, query)
		if err != nil {
			return nativeModelSourceError("native_model_accounts_unavailable", err)
		}
		for _, overview := range page {
			account := overview.Account()
			if !account.IsValid() || account.Ref().String() <= after.String() {
				return NewError("native_model_accounts_invalid", http.StatusServiceUnavailable, nil)
			}
			after = account.Ref()
			if account.Ref().String() != target.AccountRef {
				continue
			}
			if account.ProviderID() != target.Provider {
				return NewError("native_model_account_provider_mismatch", http.StatusUnprocessableEntity, nil)
			}
			if !account.Enabled() {
				return NewError("native_model_account_disabled", http.StatusUnprocessableEntity, nil)
			}
			if !overview.HasCredential() {
				return NewError("native_model_account_unavailable", http.StatusUnprocessableEntity, nil)
			}
			return nil
		}
		if len(page) < accountapp.DefaultOverviewLimit {
			return NewError("native_model_account_not_found", http.StatusUnprocessableEntity, nil)
		}
	}
}

// nativeModelProbeErrorCode accepts only the stable codes emitted by account
// model management. A syntactically valid arbitrary string is not necessarily
// low sensitivity; never pass through messages, URLs or unknown persisted codes.
func nativeModelProbeErrorCode(code string) string {
	switch code {
	case "timeout", "discovery_unsupported", "authentication_rejected",
		"discovery_failed", "invalid_catalog", "credential_conflict",
		"credential_missing", "account_not_found", "refresh_failed":
		return code
	default:
		return "refresh_failed"
	}
}
