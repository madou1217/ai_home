// Package codexdefault coordinates local Codex defaults with native files and
// Go-owned account state. It never reaches a remote Server to mutate host files.
package codexdefault

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	codexconfig "github.com/madou1217/ai_home/internal/host/aihdefault/content/codex"
	"github.com/madou1217/ai_home/internal/runtime/codexgateway"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
)

type Options struct {
	AIHomeDir          string
	HostHomeDir        string
	AuthCommand        string
	Selector           string
	ExpectedAccountRef string
	OnlyIfUnselected   bool
	LookupEnv          func(string) (string, bool)
}

type Result struct {
	AccountRef   string
	CLIAccountID string
	Gateway      bool
	UpdatedAtMS  int64
	ConfigPath   string
	Applied      bool
}

// Apply takes a numeric selector or .aih-server; empty also selects the gateway.
// Invalid/missing/disabled accounts are rejected before any native write.
func Apply(ctx context.Context, options Options) (Result, error) {
	var result Result
	if ctx == nil || !filepath.IsAbs(options.AIHomeDir) || !filepath.IsAbs(options.HostHomeDir) || !filepath.IsAbs(options.AuthCommand) {
		return result, fmt.Errorf("codex_default_scope_invalid")
	}
	selector := strings.TrimSpace(options.Selector)
	gateway := selector == "" || selector == ".aih-server"
	var alias accountcore.CLIAccountID
	var err error
	var selectedRef accountcore.AccountRef
	if !gateway {
		if strings.HasPrefix(selector, "acct_") {
			selectedRef, err = accountcore.ParseAccountRef(selector)
		} else {
			alias, err = accountcore.ParseCLIAccountID(selector)
		}
		if err != nil {
			return result, fmt.Errorf("invalid_codex_account_id")
		}
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return result, err
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: options.AIHomeDir, Catalog: catalog})
	if err != nil {
		return result, err
	}
	defer store.Close()
	var account accountcore.Account
	var credential accountapp.CredentialSnapshot
	if !gateway {
		if selectedRef.IsValid() {
			account, err = store.GetByRef(ctx, selectedRef)
		} else {
			account, err = store.GetByCLIAccountID(ctx, "codex", alias)
		}
		if err == nil && account.ProviderID() != "codex" {
			return result, accountapp.ErrProviderDefaultMismatch
		}
		if err != nil {
			return result, err
		}
		if !account.Enabled() {
			return result, accountapp.ErrProviderDefaultDisabled
		}
		credential, err = store.GetCredentialSnapshot(ctx, account.Ref())
		if err != nil {
			return result, err
		}
	}
	connection, err := codexgateway.Read(ctx, options.AIHomeDir, options.LookupEnv)
	if err != nil {
		return result, err
	}
	// A server upgraded without its sibling CLI must not write an unusable
	// credential callback. Probe locally with a bounded command and never log it.
	probeCtx, cancelProbe := context.WithTimeout(ctx, 3*time.Second)
	probe := exec.CommandContext(probeCtx, options.AuthCommand, "codex", "gateway-auth", "--ai-home", options.AIHomeDir)
	probe.Stderr = io.Discard
	key, probeErr := probe.Output()
	cancelProbe()
	if probeErr != nil || string(key) != connection.APIKey() {
		clear(key)
		return result, fmt.Errorf("codex_host_auth_cli_unavailable")
	}
	clear(key)

	home := filepath.Join(options.HostHomeDir, providerroot.ConfigDir("codex"))
	configPath, release, err := codexpreferences.AcquireHostLock(home)
	if err != nil {
		return result, err
	}
	defer release()
	originalHome := home
	initialDirectory, err := os.Stat(home)
	if err != nil || !initialDirectory.IsDir() {
		return result, fmt.Errorf("codex_host_directory_invalid")
	}
	checkPaths := func() error {
		currentDirectory, err := os.Stat(originalHome)
		if err != nil || !os.SameFile(initialDirectory, currentDirectory) {
			return fmt.Errorf("codex_host_directory_changed")
		}
		resolved, err := filepath.EvalSymlinks(filepath.Join(originalHome, "config.toml"))
		if err == nil && resolved != configPath {
			return fmt.Errorf("codex_host_config_redirected")
		}
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("codex_host_config_redirected")
		}
		return nil
	}
	authPath := filepath.Join(home, "auth.json")
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
		authPath = filepath.Join(home, "auth.json")
	}
	if err := requireNoPreservedConflict(configPath); err != nil {
		return result, err
	}
	if err := requireNoPreservedConflict(authPath); err != nil {
		return result, err
	}
	journalFile := journalPath(home)
	if err := recoverJournal(ctx, journalFile, configPath, authPath, store, options.AIHomeDir); err != nil {
		return result, err
	}
	initialState, err := readDefaultState(ctx, store, options.AIHomeDir)
	if err != nil {
		return result, err
	}
	if options.OnlyIfUnselected && initialState.Ref != "" {
		return Result{Gateway: gateway, Applied: false}, nil
	}
	if options.ExpectedAccountRef != "" && initialState.Ref != options.ExpectedAccountRef && !(initialState.Ref == "" && initialState.ExpectedRef == options.ExpectedAccountRef) {
		return Result{Gateway: gateway, Applied: false}, nil
	}

	configBefore, err := readHostFile(configPath)
	if err != nil {
		return result, err
	}
	authBefore, err := readHostFile(authPath)
	if err != nil {
		return result, err
	}
	spec := codexconfig.HostSpec{GatewayURL: connection.BaseURL, AuthCommand: options.AuthCommand, AIHomeDir: options.AIHomeDir, Gateway: gateway}
	var encodedAuth []byte
	if !gateway {
		// Preserve the outgoing registered OAuth identity before replacing its only
		// newer native copy, even when the incoming target is an API-key account.
		if err := adoptOutgoingHostCredential(ctx, store, authBefore); err != nil {
			return result, err
		}
		credential, err = store.GetCredentialSnapshot(ctx, account.Ref())
		if err != nil {
			return result, err
		}

		credential, err = adoptNewerHostCredential(ctx, store, credential, authBefore)
		if err != nil {
			return result, err
		}
		auth, ok := credential.Credential().(codex.Auth)
		if !ok {
			return result, fmt.Errorf("codex_credential_invalid")
		}
		encodedAuth, err = authfile.Encode(auth)
		if err != nil {
			return result, err
		}
		spec.AccountRef = account.Ref().String()
		if api, ok := auth.(*codex.APIKeyAuth); ok {
			spec.NativeAPIURL = api.BaseURL()
		}
	}
	patched, err := codexconfig.PatchHost(string(configBefore.Data), spec)
	if err != nil {
		return result, err
	}
	changes := []fileChange{{Before: configBefore, After: []byte(patched), Mode: configBefore.Mode}}
	if !gateway {
		changes = append(changes, fileChange{Before: authBefore, After: encodedAuth, Mode: 0o600})
	}
	before := initialState
	change, err := store.BeginCodexHostDefault(ctx, options.AIHomeDir, account.Ref(), credential.UpdatedAt(), gateway, before)
	if err != nil {
		return result, err
	}
	defer change.Rollback()
	if err := stageChanges(changes); err != nil {
		// No publication has happened; these files were created by this invocation.
		for _, file := range changes {
			if file.Staged != "" {
				_ = os.Remove(file.Staged)
			}
		}
		return result, err
	}
	journalWritten := false
	defer func() {
		if !journalWritten {
			for _, file := range changes {
				_ = os.Remove(file.Staged)
			}
		}
	}()
	entry := journal{Version: 2, Before: before, After: change.After, Files: changes}
	if err := writeJournal(journalFile, entry); err != nil {
		// A failed directory fsync can leave a published journal. Keep its stages.
		if _, statErr := os.Lstat(journalFile); statErr == nil {
			journalWritten = true
		}
		return result, err
	}
	journalWritten = true
	published := 0
	for _, file := range changes {
		if err = checkPaths(); err != nil {
			break
		}
		if err = publishStaged(file); err != nil {
			break
		}
		published++
	}
	if err == nil {
		if pathErr := checkPaths(); pathErr != nil {
			err = pathErr
		} else {
			err = verifyPublished(changes)
		}
	}
	commitAttempted := err == nil
	if commitAttempted {
		err = change.Commit()
	}
	if err != nil {
		change.Rollback()
		if errors.Is(err, errExternalFilePreserved) {
			return result, err
		}
		if commitAttempted {
			observed, observeErr := readDefaultState(context.WithoutCancel(ctx), store, options.AIHomeDir)
			if observeErr != nil || observed != before {
				// A commit error can leave its outcome uncertain. Keep the native
				// files and journal unless the single business DB is proven to
				// still contain this operation's exact preimage.
				return result, fmt.Errorf("codex_default_recovery_required")
			}
		}
		if stageErr := verifyStages(changes); stageErr != nil {
			return result, stageErr
		}
		if restoreErr := rollbackFiles(changes[:min(published+1, len(changes))]); restoreErr != nil {
			return result, fmt.Errorf("codex_default_recovery_required: %w", restoreErr)
		}
		if stageErr := cleanupStages(changes); stageErr != nil {
			return result, stageErr
		}
		_ = removeJournal(journalFile)
		return result, err
	}
	if err := verifyPublished(changes); err != nil {
		return result, fmt.Errorf("codex_default_recovery_external_edit")
	}
	if stageErr := cleanupStages(changes); stageErr != nil {
		return result, stageErr
	}
	if err := removeJournal(journalFile); err != nil {
		return result, fmt.Errorf("codex_default_journal_cleanup_failed")
	}
	result = Result{Gateway: gateway, AccountRef: spec.AccountRef, ConfigPath: configPath, UpdatedAtMS: change.After.Version, Applied: true}
	if !gateway {
		result.CLIAccountID = account.CLIAccountID().String()
	}
	return result, nil
}
