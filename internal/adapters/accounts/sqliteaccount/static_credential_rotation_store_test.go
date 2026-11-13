package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/providers"
)

type noopRuntimeCleanup struct{}

func (noopRuntimeCleanup) ForgetAccount(accountcore.AccountRef) {}

func TestRotateStaticCredentialCoversAllStaticProvidersAndUIState(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	currentTime := time.UnixMilli(1700000000000).UTC()
	clock := func() time.Time {
		currentTime = currentTime.Add(10 * time.Millisecond)
		return currentTime
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, clock)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	rotator, err := accountapp.NewStaticCredentialRotator(catalog, store, clock, noopRuntimeCleanup{})
	if err != nil {
		t.Fatalf("NewStaticCredentialRotator() error = %v", err)
	}

	for _, provider := range []string{"kimi", "opencode", "zcode", "grok"} {
		cred, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
			ProviderID: provider,
			APIKey:     "sk-" + provider + "-old",
			BaseURL:    "https://relay.example.com/" + provider,
		})
		if err != nil {
			t.Fatalf("NewStaticAPIKeyAuth(%s) error = %v", provider, err)
		}
		acc, err := registrar.Register(ctx, cred, nil)
		if err != nil {
			t.Fatalf("Register(%s) error = %v", provider, err)
		}
		uiState, err := accountcore.NewUIState(accountcore.UIStateInput{
			AccountRef:  acc.Ref(),
			Status:      "up",
			DisplayName: "Custom " + provider,
			AuthMode:    "api-key",
			APIKeyMode:  true,
			Configured:  true,
			BaseURL:     "https://relay.example.com/" + provider,
			UpdatedAt:   clock(),
		})
		if err != nil {
			t.Fatalf("NewUIState(%s) error = %v", provider, err)
		}
		if err := store.ReplaceAccountUIState(ctx, uiState); err != nil {
			t.Fatalf("ReplaceAccountUIState(%s) error = %v", provider, err)
		}

		updated, err := rotator.Edit(ctx, acc.Ref(), accountapp.StaticCredentialEdit{
			APIKey:         "sk-" + provider + "-new",
			BaseURL:        "https://next.example.com/" + provider + "/",
			IncludeBaseURL: true,
		})
		if err != nil {
			t.Fatalf("Edit(%s) error = %v", provider, err)
		}
		if updated.Ref() != acc.Ref() {
			t.Fatalf("accountRef changed: got %s, want %s", updated.Ref(), acc.Ref())
		}

		snap, err := store.GetCredentialSnapshot(ctx, acc.Ref())
		if err != nil {
			t.Fatalf("GetCredentialSnapshot(%s) error = %v", provider, err)
		}
		restored := snap.Credential().(*accountcore.StaticAPIKeyAuth)
		if restored.APIKey() != "sk-"+provider+"-new" || restored.BaseURL() != "https://next.example.com/"+provider {
			t.Fatalf("restored(%s) = %s / %s", provider, restored.APIKey(), restored.BaseURL())
		}

		states, err := store.ListAccountUIStates(ctx)
		if err != nil {
			t.Fatalf("ListAccountUIStates() error = %v", err)
		}
		var matched *accountcore.UIState
		for index := range states {
			if states[index].AccountRef() == acc.Ref() {
				matched = &states[index]
				break
			}
		}
		if matched == nil || matched.DisplayName() != "Custom "+provider || matched.BaseURL() != "https://next.example.com/"+provider {
			t.Fatalf("ui state after edit(%s) = %#v", provider, matched)
		}
	}

	// Claude switches api-key -> auth-token and syncs auth_mode in account_ui_state.
	claudeCred, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey:  "sk-ant-old",
		BaseURL: "https://relay.claude.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	claudeAcc, err := registrar.Register(ctx, claudeCred, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rotator.Edit(ctx, claudeAcc.Ref(), accountapp.StaticCredentialEdit{
		APIKey:         "tok-ant-new",
		AuthKind:       "auth-token",
		BaseURL:        "",
		IncludeBaseURL: true,
	}); err != nil {
		t.Fatalf("Edit(claude) error = %v", err)
	}
	states, err := store.ListAccountUIStates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var claudeState *accountcore.UIState
	for index := range states {
		if states[index].AccountRef() == claudeAcc.Ref() {
			claudeState = &states[index]
			break
		}
	}
	if claudeState == nil || claudeState.AuthMode() != "auth-token" || claudeState.BaseURL() != "" || !claudeState.APIKeyMode() {
		t.Fatalf("claude ui state = %#v", claudeState)
	}

	// Gemini StaticAPIKeyAuth keeps empty baseURL and rejects custom baseURL.
	gemCred, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "gemini",
		APIKey:     "AIza-old",
	})
	if err != nil {
		t.Fatal(err)
	}
	gemAcc, err := registrar.Register(ctx, gemCred, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rotator.Edit(ctx, gemAcc.Ref(), accountapp.StaticCredentialEdit{
		APIKey: "AIza-new",
	}); err != nil {
		t.Fatalf("Edit(gemini) error = %v", err)
	}
	if _, err := rotator.Edit(ctx, gemAcc.Ref(), accountapp.StaticCredentialEdit{
		BaseURL:        "https://relay.example.com",
		IncludeBaseURL: true,
	}); !errors.Is(err, accountapp.ErrStaticBaseURLUnsupported) {
		t.Fatalf("Edit(gemini with baseUrl) = %v, want ErrStaticBaseURLUnsupported", err)
	}
}
