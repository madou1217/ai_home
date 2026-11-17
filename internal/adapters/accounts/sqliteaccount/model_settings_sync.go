package sqliteaccount

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/fsnotify/fsnotify"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelsettingssync"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

// Separate ownership from the remaining credential sync writer's state. Node
// still updates go-account-sync:state but must never overwrite this Go marker.
const modelSettingsManagedKey = "go-model-settings:managed:v1"

type modelSettingsOwnership struct {
	Version           int      `json:"version"`
	Keys              []string `json:"keys"`
	IgnoredStaleCount int      `json:"ignored_stale_count"`
	AppliedCount      int      `json:"applied_count"`
}

// migrateModelSettings plans on every open. The marker records ownership, never
// permission to skip new accounts, rebound links or removed settings.
func (store *Store) migrateModelSettings(ctx context.Context) error {
	_, err := store.applyModelSettings(ctx, nil, nil)
	return err
}

func (store *Store) SaveModelSettings(ctx context.Context, document modelsettingssync.Document) (modelsettingssync.Result, error) {
	if document.Value == "" || document.UpdatedAtMS <= 0 {
		return modelsettingssync.Result{}, modelsettingssync.ErrInvalidSettings
	}
	return store.applyModelSettings(ctx, &document, nil)
}

func (store *Store) UpdateModelSettings(ctx context.Context, mutate modelsettingssync.Mutation) (modelsettingssync.Result, error) {
	if mutate == nil {
		return modelsettingssync.Result{}, modelsettingssync.ErrInvalidSettings
	}
	return store.applyModelSettings(ctx, nil, mutate)
}

func (store *Store) applyModelSettings(ctx context.Context, document *modelsettingssync.Document, mutate modelsettingssync.Mutation) (modelsettingssync.Result, error) {
	if store == nil || store.db == nil || ctx == nil {
		return modelsettingssync.Result{}, modelsettingssync.ErrInvalidSettings
	}
	transaction, err := store.beginModelTransaction(ctx)
	if err != nil {
		return modelsettingssync.Result{}, fmt.Errorf("model_settings_admission: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	if err := prepareModelSettingsKV(ctx, transaction); err != nil {
		return modelsettingssync.Result{}, err
	}
	ownership, migrated, err := readModelSettingsOwnership(ctx, transaction)
	if err != nil {
		return modelsettingssync.Result{}, err
	}
	snapshot, err := readModelSettingsSnapshot(ctx, transaction, !migrated)
	if err != nil {
		return modelsettingssync.Result{}, err
	}
	if migrated {
		snapshot.Managed = ownership.Keys
	}
	raw, found, err := readModelSettingsKV(ctx, transaction, modelcatalogsettings.DatabaseKey)
	if err != nil {
		return modelsettingssync.Result{}, err
	}
	if found {
		var object map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &object); err != nil || object == nil {
			return modelsettingssync.Result{}, errors.New("model_settings_document_invalid")
		}
	}
	if mutate != nil {
		next, err := mutate(raw, found)
		if err != nil {
			return modelsettingssync.Result{}, err
		}
		if next.Value == "" || next.UpdatedAtMS <= 0 {
			return modelsettingssync.Result{}, modelsettingssync.ErrInvalidSettings
		}
		document = &next
	}
	value := raw
	if document != nil {
		value = document.Value
	} else if found {
		encoded, err := json.Marshal(modelcatalogsettings.Normalize(raw))
		if err != nil {
			return modelsettingssync.Result{}, err
		}
		value = string(encoded)
	}
	var settings modelsettingssync.Settings
	if found || document != nil {
		settings, err = modelsettingssync.ReadSettings(value)
		if err != nil {
			return modelsettingssync.Result{}, err
		}
	}
	plan, err := modelsettingssync.Build(settings, snapshot)
	if err != nil {
		return modelsettingssync.Result{}, err
	}
	routes, err := store.readModelSettingsRoutes(ctx, transaction)
	if err != nil {
		// A previous included snapshot is not safe after canonical facts become
		// unreadable. Reset the digest so exact recovery must republish the routes.
		store.routes.quarantineRoutingSnapshot()
		store.modelSettingsDigest = [32]byte{}
		return modelsettingssync.Result{}, err
	}
	routeFacts := make([]modelSettingsRouteFact, 0, len(routes))
	for _, entry := range routes {
		routeFacts = append(routeFacts, modelSettingsRouteFact{Ref: entry.account.Ref().String(), Provider: entry.account.ProviderID(), Alias: entry.account.CLIAccountID().Int64(), Enabled: entry.enabled, Excluded: entry.excluded, CredentialExcluded: entry.credentialExcluded, Models: entry.models})
	}
	input, err := json.Marshal(struct {
		Value     string
		Snapshot  modelsettingssync.Snapshot
		Ownership modelSettingsOwnership
		Routes    []modelSettingsRouteFact
	}{raw, snapshot, ownership, routeFacts})
	if err != nil {
		return modelsettingssync.Result{}, err
	}
	digest := sha256.Sum256(input)
	if document == nil && migrated && len(plan.Writes) == 0 && store.modelSettingsDigest == digest {
		return modelsettingssync.Result{IgnoredStaleCount: plan.IgnoredStaleCount}, nil
	}
	nowMS := time.Now().UnixMilli()
	if document != nil {
		nowMS = document.UpdatedAtMS
	}
	if err := store.writeModelSettingsPolicies(ctx, transaction, plan.Writes, nowMS); err != nil {
		return modelsettingssync.Result{}, err
	}
	if document != nil {
		if err := writeModelSettingsKV(ctx, transaction, modelcatalogsettings.DatabaseKey, document.Value, nowMS); err != nil {
			return modelsettingssync.Result{}, err
		}
	}
	changed := !migrated || document != nil || len(plan.Writes) > 0 || ownership.IgnoredStaleCount != plan.IgnoredStaleCount || !sameModelSettingsKeys(ownership.Keys, plan.Managed)
	if changed {
		ownership = modelSettingsOwnership{Version: 1, Keys: plan.Managed, IgnoredStaleCount: plan.IgnoredStaleCount, AppliedCount: len(plan.Writes)}
		encoded, err := json.Marshal(ownership)
		if err != nil {
			return modelsettingssync.Result{}, err
		}
		if err := writeModelSettingsKV(ctx, transaction, modelSettingsManagedKey, string(encoded), nowMS); err != nil {
			return modelsettingssync.Result{}, err
		}
	}
	if len(plan.Writes) > 0 {
		routes, err = store.readModelSettingsRoutes(ctx, transaction)
		if err != nil {
			store.routes.quarantineRoutingSnapshot()
			store.modelSettingsDigest = [32]byte{}
			return modelsettingssync.Result{}, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return modelsettingssync.Result{}, fmt.Errorf("model_settings_commit: %w", err)
	}
	// Keep the stable index object and observer: other processes' committed model
	// writes must also publish here even when this process has no policy diff.
	store.publishModelSettingsRoutes(routes)
	store.modelSettingsDigest = digest
	if changed {
		store.modelSettingsDigest = [32]byte{}
	}
	return modelsettingssync.Result{AppliedCount: len(plan.Writes), IgnoredStaleCount: plan.IgnoredStaleCount}, nil
}

func sameModelSettingsKeys(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func prepareModelSettingsKV(ctx context.Context, transaction *modelTransaction) error {
	var kind string
	err := transaction.QueryRowContext(ctx, "SELECT type FROM sqlite_master WHERE name = 'app_kv'").Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = transaction.ExecContext(ctx, "CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
		return err
	}
	if err != nil {
		return err
	}
	if kind != "table" {
		return errors.New("model_settings_kv_invalid")
	}
	return nil
}

func readModelSettingsKV(ctx context.Context, transaction *modelTransaction, key string) (string, bool, error) {
	var value string
	err := transaction.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("model_settings_read: %w", err)
	}
	return value, true, nil
}

func writeModelSettingsKV(ctx context.Context, transaction *modelTransaction, key, value string, nowMS int64) error {
	_, err := transaction.ExecContext(ctx, `INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?)
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, value, nowMS)
	return err
}

func readModelSettingsOwnership(ctx context.Context, transaction *modelTransaction) (modelSettingsOwnership, bool, error) {
	raw, found, err := readModelSettingsKV(ctx, transaction, modelSettingsManagedKey)
	if err != nil || !found {
		return modelSettingsOwnership{}, found, err
	}
	var ownership modelSettingsOwnership
	if err := json.Unmarshal([]byte(raw), &ownership); err != nil || ownership.Version != 1 || ownership.Keys == nil || ownership.IgnoredStaleCount < 0 || ownership.AppliedCount < 0 {
		return modelSettingsOwnership{}, false, errors.New("model_settings_ownership_invalid")
	}
	for _, key := range ownership.Keys {
		if _, _, err := modelsettingssync.ParsePolicyKey(key); err != nil {
			return modelSettingsOwnership{}, false, err
		}
	}
	return ownership, true, nil
}

func readModelSettingsSnapshot(ctx context.Context, transaction *modelTransaction, inheritLegacy bool) (modelsettingssync.Snapshot, error) {
	snapshot := modelsettingssync.Snapshot{Accounts: map[string]string{}, Links: map[string]string{}, Current: map[string]accountapp.ModelManualPolicy{}}
	raw, found, err := readModelSettingsKV(ctx, transaction, accountrefmap.SyncStateKey)
	if err != nil {
		return snapshot, err
	}
	if found {
		// Parse in this same transaction, not via a second connection or permissive
		// Load. Validate the state envelope so malformed input is never identity.
		var state struct {
			Links   map[string]json.RawMessage `json:"links"`
			Managed []string                   `json:"modelPolicies"`
		}
		if err := json.Unmarshal([]byte(raw), &state); err != nil || state.Links == nil {
			return snapshot, errors.New("model_settings_sync_state_invalid")
		}
		table, err := accountrefmap.Parse(raw)
		if err != nil || table.Len() != len(state.Links) {
			return snapshot, errors.New("model_settings_ref_map_invalid")
		}
		snapshot.Links = table.Links()
		for nodeRef, goRef := range snapshot.Links {
			if _, err := accountcore.ParseAccountRef(nodeRef); err != nil {
				return snapshot, errors.New("model_settings_ref_map_invalid")
			}
			if _, err := accountcore.ParseAccountRef(goRef); err != nil {
				return snapshot, errors.New("model_settings_ref_map_invalid")
			}
		}
		if inheritLegacy {
			for _, key := range state.Managed {
				if _, _, err := modelsettingssync.ParsePolicyKey(key); err != nil {
					return snapshot, err
				}
			}
			snapshot.Managed = state.Managed
		}
	}
	rows, err := transaction.QueryContext(ctx, "SELECT account_ref,provider_id FROM accounts ORDER BY account_ref")
	if err != nil {
		return snapshot, err
	}
	for rows.Next() {
		var ref, provider string
		if err := rows.Scan(&ref, &provider); err != nil {
			_ = rows.Close()
			return snapshot, err
		}
		if _, err := accountcore.ParseAccountRef(ref); err != nil {
			_ = rows.Close()
			return snapshot, ErrIncompatibleDatabase
		}
		snapshot.Accounts[ref] = provider
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return snapshot, err
	}
	rows, err = transaction.QueryContext(ctx, "SELECT account_ref,model_id,manual_policy FROM account_models")
	if err != nil {
		return snapshot, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref, id, value string
		if err := rows.Scan(&ref, &id, &value); err != nil {
			return snapshot, err
		}
		key := modelsettingssync.PolicyKey(ref, id)
		if _, _, err := modelsettingssync.ParsePolicyKey(key); err != nil {
			return snapshot, ErrIncompatibleDatabase
		}
		policy, err := accountapp.ParseModelManualPolicy(value)
		if err != nil {
			return snapshot, ErrIncompatibleDatabase
		}
		snapshot.Current[key] = policy
	}
	return snapshot, rows.Err()
}

func (store *Store) writeModelSettingsPolicies(ctx context.Context, transaction *modelTransaction, writes []modelsettingssync.Write, nowMS int64) error {
	for _, write := range writes {
		if _, _, err := modelsettingssync.ParsePolicyKey(modelsettingssync.PolicyKey(write.AccountRef, write.ModelID)); err != nil || !write.Policy.IsValid() {
			return modelsettingssync.ErrInvalidSettings
		}
		if _, err := transaction.ExecContext(ctx, `INSERT INTO account_models(account_ref,model_id,upstream_available,manual_policy,updated_at_ms)
   VALUES(?,?,0,?,?) ON CONFLICT(account_ref,model_id) DO UPDATE SET manual_policy=excluded.manual_policy,updated_at_ms=excluded.updated_at_ms`, write.AccountRef, write.ModelID, write.Policy.String(), nowMS); err != nil {
			return err
		}
		if write.Policy == accountapp.ModelPolicyInherit {
			if _, err := transaction.ExecContext(ctx, `DELETE FROM account_models WHERE account_ref=? AND model_id=? AND upstream_available=0 AND manual_policy='inherit'`, write.AccountRef, write.ModelID); err != nil {
				return err
			}
		}
	}
	return nil
}

type modelSettingsRouteFact struct {
	Ref                string
	Provider           string
	Alias              int64
	Enabled            bool
	Excluded           bool
	CredentialExcluded bool
	Models             []runtimecore.ModelID
}

func (store *Store) readModelSettingsRoutes(ctx context.Context, transaction *modelTransaction) ([]indexedRoutingAccount, error) {
	guards, err := store.readCredentialRoutingGuards(ctx, transaction)
	if err != nil {
		return nil, err
	}
	manual, err := store.readManualRoutingExclusions(ctx, transaction)
	if err != nil {
		return nil, err
	}
	rows, err := transaction.QueryContext(ctx, `SELECT a.account_ref,a.provider_id,a.cli_account_id,a.enabled,0
  FROM accounts a ORDER BY a.account_ref`)
	if err != nil {
		return nil, err
	}
	entries := []indexedRoutingAccount{}
	for rows.Next() {
		var ref, provider string
		var alias int64
		var enabled, excluded bool
		if err := rows.Scan(&ref, &provider, &alias, &enabled, &excluded); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_, account, err := restoreIndexedRoutingAccount(store.catalog, ref, provider, alias)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		entries = append(entries, indexedRoutingAccount{account: account, enabled: enabled, excluded: manual[account.Ref().String()], credentialExcluded: canonicalRoutingGuard(guards, account.Ref())})
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	for i := range entries {
		models, err := store.listAccountModels(ctx, transaction, entries[i].account.Ref())
		if err != nil {
			return nil, err
		}
		effective, err := accountapp.EffectiveModelIDs(models)
		if err != nil {
			return nil, err
		}
		entries[i].models = effective
	}
	return entries, nil
}

func (store *Store) publishModelSettingsRoutes(entries []indexedRoutingAccount) {
	index := store.routes
	if index == nil {
		return
	}
	index.mu.Lock()
	affected := map[routingIndexKey]struct{}{}
	for key := range index.reverse {
		affected[key] = struct{}{}
	}
	// Only this complete, successfully committed canonical snapshot may release
	// a quarantine. Per-account manual/credential writes cannot bypass it.
	index.quarantined = false
	index.accounts = make(map[accountcore.AccountRef]indexedRoutingAccount, len(entries))
	index.reverse = map[routingIndexKey][]accountapp.RoutingAccount{}
	for _, entry := range entries {
		index.replaceGuardedAccountDataLocked(entry.account, entry.enabled, entry.excluded, entry.credentialExcluded, entry.models)
	}
	for key := range index.reverse {
		affected[key] = struct{}{}
	}
	index.publishSnapshotsLocked(affected)
	index.mu.Unlock()
	index.notifyRoutableModelsChanged()
}

// modelSettingsFileWatch hides only the platform handle lifecycle, not policy.
type modelSettingsFileWatch struct {
	Events <-chan fsnotify.Event
	Errors <-chan error
	close  func()
}

func (watch *modelSettingsFileWatch) Close() {
	if watch != nil && watch.close != nil {
		watch.close()
	}
}

// One event consumer belongs to this Store, not a second settings business
// writer. All invalidations re-enter the same planner/transaction/publication.
type modelSettingsWatch struct {
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

func (watch *modelSettingsWatch) close() {
	if watch == nil {
		return
	}
	watch.once.Do(func() { watch.cancel(); <-watch.done })
}

func (store *Store) startModelSettingsWatch(root string) error {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return err
	}
	// Never use a watcher to widen an explicitly selected canonical root.
	if resolved != absolute {
		return errors.New("model_settings_watch_symlink_root")
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		return errors.New("model_settings_watch_root_invalid")
	}
	watcher, err := newModelSettingsFileWatch(absolute)
	if err != nil {
		return fmt.Errorf("model_settings_watch_open: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	watch := &modelSettingsWatch{cancel: cancel, done: make(chan struct{})}
	store.modelSettingsWatch = watch
	go func() {
		defer close(watch.done)
		defer func() {
			if watcher != nil {
				watcher.Close()
			}
		}()
		// Immediate invalidation closes the gap between initial load and watch setup.
		timer := time.NewTimer(0)
		defer timer.Stop()
		pending := true
		schedule := func(delay time.Duration) {
			if !pending {
				timer.Reset(delay)
				pending = true
			}
		}
		var events <-chan fsnotify.Event = watcher.Events
		var failures <-chan error = watcher.Errors
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-events:
				if !ok {
					log.Printf("model_settings_watch_events_closed: rescan required")
					events = nil
					failures = nil
					watcher.Close()
					watcher = nil
					schedule(100 * time.Millisecond)
					continue
				}
				name := filepath.Clean(event.Name)
				if name == absolute && event.Op&(fsnotify.Rename|fsnotify.Remove) != 0 {
					log.Printf("model_settings_watch_root_moved: waiting for original root")
					events = nil
					failures = nil
					watcher.Close()
					watcher = nil
					schedule(100 * time.Millisecond)
					continue
				}
				if name == absolute || filepath.Dir(name) == absolute && (filepath.Base(name) == DatabaseFileName || filepath.Base(name) == DatabaseFileName+"-wal") {
					schedule(80 * time.Millisecond)
				}
			case failure, ok := <-failures:
				if !ok {
					failures = nil
					continue
				}
				log.Printf("model_settings_watch_error: %v; rescan required", failure)
				// Overflow does not invalidate the watch registration; always rescan it.
				schedule(100 * time.Millisecond)
			case <-timer.C:
				pending = false
				if watcher == nil {
					current, statErr := os.Stat(absolute)
					target, pathErr := filepath.EvalSymlinks(absolute)
					if statErr != nil || pathErr != nil || target != absolute || !os.SameFile(info, current) {
						log.Printf("model_settings_watch_root_unavailable: original canonical directory required")
						schedule(time.Second)
						continue
					}
					next, err := newModelSettingsFileWatch(absolute)
					if err != nil {
						if next != nil {
							next.Close()
						}
						log.Printf("model_settings_watch_reopen_failed: %v", err)
						schedule(time.Second)
						continue
					}
					watcher = next
					events = watcher.Events
					failures = watcher.Errors
				}
				result, err := store.applyModelSettings(ctx, nil, nil)
				if err != nil {
					if ctx.Err() != nil {
						return
					}
					log.Printf("model_settings_reconcile_failed: %v", err)
					schedule(time.Second)
				} else if result.AppliedCount > 0 {
					log.Printf("model_settings_reconciled: applied_count=%d ignored_stale_count=%d", result.AppliedCount, result.IgnoredStaleCount)
				}
			}
		}
	}()
	return nil
}
