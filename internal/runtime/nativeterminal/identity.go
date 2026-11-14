package nativeterminal

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// specIntent proves that argv and addressing metadata name the same mode,
// provider and alias. AccountRef itself is verified against the selected store.
func specIntent(spec Spec) (providerlaunch.LaunchIntent, error) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return providerlaunch.LaunchIntent{}, err
	}
	if len(spec.Args) < 2 || spec.Args[0] != spec.Provider {
		return providerlaunch.LaunchIntent{}, ErrInvalid
	}
	intent, err := providerlaunch.ParseLaunchIntent(catalog, spec.Provider, spec.Args[1:])
	if err != nil || !intent.HasPinnedAccount() || intent.ClientProviderID() != spec.Provider || intent.RelayProviderID() != spec.IdentityProvider || intent.CLIAccountID().Int64() != spec.CLIAccountID {
		return providerlaunch.LaunchIntent{}, errors.New("native_terminal_identity_mismatch")
	}
	if intent.Mode() == providerlaunch.LaunchModeNativeDirect && spec.Provider != spec.IdentityProvider {
		return providerlaunch.LaunchIntent{}, errors.New("native_terminal_identity_mismatch")
	}
	// Model metadata is only display state: do not let it disagree with the
	// actual official CLI option, including duplicate --model/-m spellings.
	selected := ""
	args := intent.Arguments()
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if arg == "--model" || arg == "-m" {
			if i+1 >= len(args) {
				return providerlaunch.LaunchIntent{}, ErrInvalid
			}
			i++
			selected = args[i]
		} else if strings.HasPrefix(arg, "--model=") {
			selected = strings.TrimPrefix(arg, "--model=")
		}
	}
	if selected != spec.Model {
		return providerlaunch.LaunchIntent{}, errors.New("native_terminal_model_mismatch")
	}
	return intent, nil
}

// validateIdentity runs once before create and once inside the pane. It performs
// no token refresh and no table-wide scan. Relay uses the same management alias
// adapter as cmd/aih so a different Server cannot silently resolve another ref.
func validateIdentity(ctx context.Context, home string, spec Spec, env []string) error {
	intent, err := specIntent(spec)
	if err != nil {
		return err
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if intent.Mode() == providerlaunch.LaunchModeGatewayRelay {
		client, err := managementapi.New(&http.Client{Timeout: 5 * time.Second}, managementapi.Config{BaseURL: envValue(env, "AIH_SERVER_BASE_URL"), ManagementKey: envValue(env, "AIH_SERVER_MANAGEMENT_KEY")})
		if err != nil {
			return errors.New("native_terminal_gateway_identity_unavailable")
		}
		account, err := client.ResolveAlias(readCtx, spec.IdentityProvider, intent.CLIAccountID())
		if err != nil {
			return errors.New("native_terminal_gateway_identity_unavailable")
		}
		if account.AccountRef.String() != spec.AccountRef || !account.Enabled {
			return errors.New("native_terminal_identity_mismatch")
		}
		return nil
	}
	db, err := appstate.OpenReadOnly(readCtx, filepath.Join(home, "aih.db"))
	if err != nil {
		return errors.New("native_terminal_account_store_unavailable")
	}
	defer db.Close()
	var ref string
	var enabled bool
	err = db.QueryRowContext(readCtx, `SELECT account_ref, enabled FROM accounts WHERE provider_id = ? AND cli_account_id = ? LIMIT 1`, spec.IdentityProvider, spec.CLIAccountID).Scan(&ref, &enabled)
	if err != nil || ref != spec.AccountRef || !enabled {
		return errors.New("native_terminal_identity_mismatch")
	}
	return nil
}

// Keep missing data distinguishable from schema/read failures in title I/O.
func missingUsage(err error) bool {
	return errors.Is(err, sql.ErrNoRows) || errors.Is(err, os.ErrNotExist)
}
