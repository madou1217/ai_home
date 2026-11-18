package imagestudio

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

type catalogTestOverviews struct {
	items []accountapp.AccountOverview
}

func (stub catalogTestOverviews) ListAccountOverviews(context.Context) ([]accountapp.AccountOverview, error) {
	return stub.items, nil
}

type catalogTestAccountModels struct {
	catalog accountapp.AccountModelCatalog
}

func (stub catalogTestAccountModels) ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error) {
	return stub.catalog, nil
}

type catalogTestIdentity struct {
	provider string
	seed     string
}

func (identity catalogTestIdentity) ProviderID() string   { return identity.provider }
func (identity catalogTestIdentity) IdentitySeed() string { return identity.seed }

// buildDisabledNativeCatalogFixture 构造一个 agy 账号：
// gemini-2.5-flash-image 是需要 discovery 的 native 模型，policy 为空表示未命中任何人工策略。
func buildDisabledNativeCatalogFixture(t *testing.T, policy accountapp.ModelManualPolicy) CatalogDependencies {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}
	cliID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID: %v", err)
	}
	createdAt := time.Unix(1_700_000_000, 0).UTC()
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     catalogTestIdentity{provider: "agy", seed: "catalog-disable-fixture"},
		CLIAccountID: cliID,
		CreatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:       account,
		HasCredential: true,
		AuthKind:      "oauth",
	})
	if err != nil {
		t.Fatalf("NewAccountOverview: %v", err)
	}

	var sets []accountapp.AccountModelSet
	if policy != "" {
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        account.Ref(),
			ModelID:           "gemini-2.5-flash-image",
			UpstreamAvailable: false,
			ManualPolicy:      policy,
			UpdatedAt:         createdAt,
		})
		if err != nil {
			t.Fatalf("NewAccountModel: %v", err)
		}
		sets = []accountapp.AccountModelSet{{
			AccountRef: account.Ref(),
			ProviderID: "agy",
			Models:     []accountapp.AccountModel{model},
		}}
	}

	return CatalogDependencies{
		Accounts:      catalogTestOverviews{items: []accountapp.AccountOverview{overview}},
		AccountModels: catalogTestAccountModels{catalog: accountapp.AccountModelCatalog{Sets: sets}},
		Providers:     catalog,
	}
}

func findCatalogModel(models []ModelEntry, provider, id string) *ModelEntry {
	for index := range models {
		if models[index].Provider == provider && models[index].ID == id {
			return &models[index]
		}
	}
	return nil
}

func TestListModelsHidesUndiscoveredNativeModel(t *testing.T) {
	deps := buildDisabledNativeCatalogFixture(t, "")
	models, err := ListModels(context.Background(), deps, "agy")
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if entry := findCatalogModel(models, "agy", "gemini-2.5-flash-image"); entry != nil {
		t.Fatalf("未发现且未禁用的 native 模型不应出现在目录中: %+v", *entry)
	}
}

func TestListModelsShowsExplicitlyDisabledUndiscoveredNativeModel(t *testing.T) {
	deps := buildDisabledNativeCatalogFixture(t, accountapp.ModelPolicyForceDisable)
	models, err := ListModels(context.Background(), deps, "agy")
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	entry := findCatalogModel(models, "agy", "gemini-2.5-flash-image")
	if entry == nil {
		t.Fatalf("显式禁用的 native 模型应保留在目录中，实际模型: %+v", models)
	}
	if entry.AccountCount != 1 || entry.AvailableAccountCount != 0 {
		t.Fatalf("禁用模型计数应 all=1 available=0，实际 all=%d available=%d", entry.AccountCount, entry.AvailableAccountCount)
	}
	if len(entry.UnavailableReasons) != 1 || entry.UnavailableReasons[0].Reason != "model_disabled" || entry.UnavailableReasons[0].Count != 1 {
		t.Fatalf("禁用模型不可用原因应为 model_disabled x1，实际 %+v", entry.UnavailableReasons)
	}
}
