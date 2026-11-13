package translation

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

type stubOverviewLister struct {
	overviews []accountapp.AccountOverview
}

func (s stubOverviewLister) ListAccountOverviews(_ context.Context) ([]accountapp.AccountOverview, error) {
	return s.overviews, nil
}

type stubAccountModelLister struct {
	cat accountapp.AccountModelCatalog
}

func (s stubAccountModelLister) ListAllAccountModels(_ context.Context) (accountapp.AccountModelCatalog, error) {
	return s.cat, nil
}

type stubAliasLister struct {
	records []modelalias.Record
}

func (s stubAliasLister) ListModelAliases(_ context.Context) ([]modelalias.Record, int64, error) {
	return s.records, 1, nil
}

type stubExclusions struct {
	excluded map[string]bool
}

func (s stubExclusions) LoadRoutingExclusions(_ context.Context) (map[string]bool, error) {
	return s.excluded, nil
}

type stubEligibility struct {
	blocked map[string]bool
}

func (s stubEligibility) CheckEligibility(_ context.Context, route runtimecore.ModelRoute) (runtimecore.Eligibility, error) {
	if s.blocked[route.AccountRef().String()+"|"+route.ModelID().String()] {
		return runtimecore.QuotaBlockedEligibility(), nil
	}
	return runtimecore.AvailableEligibility(), nil
}

func mustTestAccountOverview(t *testing.T, cat *providers.Catalog, providerID string, subject string, cliID int64) (accountcore.Account, accountapp.AccountOverview) {
	t.Helper()
	now := time.Unix(1700000000, 0).UTC()
	ident, err := accountcore.NewNativeSubjectIdentity(providerID, subject)
	if err != nil {
		t.Fatalf("NewNativeSubjectIdentity(%s): %v", providerID, err)
	}
	aliasID, err := accountcore.NewCLIAccountID(cliID)
	if err != nil {
		t.Fatalf("NewCLIAccountID: %v", err)
	}
	acc, err := accountcore.NewAccount(cat, accountcore.NewAccountInput{
		Identity:     ident,
		CLIAccountID: aliasID,
		CreatedAt:    now,
	})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}
	ov, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       acc,
		HasCredential: true,
		AuthKind:      "oauth",
		AuthMode:      "oauth",
	})
	if err != nil {
		t.Fatalf("NewAccountOverview: %v", err)
	}
	return acc, ov
}

func TestBuildTranslationModelCatalogAndResolution(t *testing.T) {
	ctx := context.Background()
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}
	modalities, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New: %v", err)
	}
	now := time.Unix(1700000000, 0).UTC()

	accPrimary, ovPrimary := mustTestAccountOverview(t, cat, "kimi", "user-kimi-1", 1)
	accExcluded, ovExcluded := mustTestAccountOverview(t, cat, "cline", "user-cline-excluded", 2)

	policyAuto := accountapp.ModelPolicyInherit
	m1, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accPrimary.Ref(),
		ModelID:           "kimi-k2",
		UpstreamAvailable: true,
		ManualPolicy:      policyAuto,
		UpdatedAt:         now,
	}); if err != nil { t.Fatalf("NewAccountModel m1: %v", err) }
	// 纯图像生成模型应被翻译目录过滤
	mImg, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accPrimary.Ref(),
		ModelID:           "gpt-image-1",
		UpstreamAvailable: true,
		ManualPolicy:      policyAuto,
		UpdatedAt:         now,
	})
	mBlocked, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accPrimary.Ref(),
		ModelID:           "kimi-k2-thinking",
		UpstreamAvailable: true,
		ManualPolicy:      policyAuto,
		UpdatedAt:         now,
	})
	mExcl, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accExcluded.Ref(),
		ModelID:           "cline-pass/gpt-5",
		UpstreamAvailable: true,
		ManualPolicy:      policyAuto,
		UpdatedAt:         now,
	})

	enabled := true
	deps := CatalogDependencies{
		Accounts: stubOverviewLister{overviews: []accountapp.AccountOverview{ovPrimary, ovExcluded}},
		AccountModels: stubAccountModelLister{cat: accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{
				{AccountRef: accPrimary.Ref(), ProviderID: "kimi", Models: []accountapp.AccountModel{m1, mImg, mBlocked}},
				{AccountRef: accExcluded.Ref(), ProviderID: "cline", Models: []accountapp.AccountModel{mExcl}},
			},
		}},
		Aliases: stubAliasLister{records: []modelalias.Record{
			{ID: "a1", Alias: "fast-trans", Target: "kimi-k2", Provider: "all", TargetProvider: "auto", Enabled: &enabled},
		}},
		Exclusions: stubExclusions{excluded: map[string]bool{accExcluded.Ref().String(): true}},
		Runtime: stubEligibility{blocked: map[string]bool{
			accPrimary.Ref().String() + "|kimi-k2-thinking": true,
		}},
		Providers:    cat,
		Modalities:   modalities,
		DatabasePath: filepath.Join(t.TempDir(), "app-state.db"),
	}

	res, err := BuildTranslationModelCatalog(ctx, deps, &Settings{Model: "kimi-k2", Provider: "kimi"})
	if err != nil {
		t.Fatalf("BuildTranslationModelCatalog err = %v", err)
	}

	byID := map[string]ModelEntry{}
	for _, item := range res.Models {
		byID[item.ID] = item
	}
	if _, hasImg := byID["gpt-image-1"]; hasImg {
		t.Fatalf("image model gpt-image-1 must be filtered out of translation catalog")
	}
	if _, hasExcl := byID["cline-pass/gpt-5"]; hasExcl {
		t.Fatalf("excluded account model cline-pass/gpt-5 should not appear")
	}
	if got, hasBlocked := byID["kimi-k2-thinking"]; !hasBlocked || got.AvailableAccountCount != 0 {
		t.Fatalf("ineligible model kimi-k2-thinking should have AvailableAccountCount=0, got %+v ok=%v", got, hasBlocked)
	}
	if got, ok := byID["kimi-k2"]; !ok || got.AvailableAccountCount != 1 {
		t.Fatalf("expected kimi-k2 count=1, got %+v ok=%v", got, ok)
	}
	if got, ok := byID["fast-trans"]; !ok || got.Source != "alias" {
		t.Fatalf("expected alias fast-trans in catalog, got %+v ok=%v", got, ok)
	}
	if res.DefaultModel != "kimi-k2" || res.DefaultProvider != "kimi" {
		t.Fatalf("unexpected default: %s/%s", res.DefaultProvider, res.DefaultModel)
	}

	resolvedM, resolvedP, err := ResolveRequestModel("", "", res)
	if err != nil || resolvedM != "kimi-k2" || resolvedP != "kimi" {
		t.Fatalf("ResolveRequestModel default mismatch: m=%q p=%q err=%v", resolvedM, resolvedP, err)
	}
	if _, _, err := ResolveRequestModel("", "", ModelCatalog{}); err == nil {
		t.Fatalf("expected error when resolving against empty catalog")
	}
}
