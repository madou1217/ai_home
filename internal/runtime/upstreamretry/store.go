// Package upstreamretry manages persistent storage (app_kv in the shared
// business SQLite database) and coherent cross-writer hot reads for global and
// per-account upstream HTTP 429 retry policies.
package upstreamretry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	appretry "github.com/madou1217/ai_home/application/upstreamretry"
	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"

	_ "modernc.org/sqlite"
)

const (
	// ServerConfigKey is the shared app_kv key for server settings.
	ServerConfigKey = appstate.KeyServerConfig
	// AccountOverrideKeyPrefix is the app_kv prefix for per-account 429 retry overrides.
	AccountOverrideKeyPrefix = "account:upstream-429-retry:"
	// defaultRefreshInterval bounds external CLI/Node write visibility even when
	// filesystem mtime/size granularity does not change.
	defaultRefreshInterval = 500 * time.Millisecond
	busyTimeoutMS          = 5000
)

var _ appretry.PolicyResolver = (*Store)(nil)

// AccountPolicyView aggregates an account's stored override, global policy,
// and resolved effective policy for management API responses.
type AccountPolicyView struct {
	Override  corepolicy.AccountOverride `json:"override"`
	Global    corepolicy.GlobalPolicy    `json:"global"`
	Effective corepolicy.EffectivePolicy `json:"effective"`
}

type dbFingerprint struct {
	mainExists bool
	mainSize   int64
	mainModNS  int64
	walExists  bool
	walSize    int64
	walModNS   int64
}

type policySnapshot struct {
	global             corepolicy.GlobalPolicy
	overrides          map[string]corepolicy.AccountOverride
	fingerprint        dbFingerprint
	fingerprintTrusted bool
	refreshedAt        time.Time
}

// Store persists per-account 429 overrides in app_kv and serves lock-free hot
// reads via an atomic immutable snapshot loaded from a single read transaction,
// staying coherent across concurrent Go writes and external CLI/Node writes.
type Store struct {
	aiHomeDir       string
	dbPath          string
	refreshInterval time.Duration
	now             func() time.Time

	writeMu        sync.Mutex
	hasDurableLoad bool
	snapshot       atomic.Pointer[policySnapshot]
}

// OpenStore initializes the policy store backed by appstate.DatabasePath(aiHomeDir)
// and eagerly loads the initial coherent snapshot. Missing database or missing
// app_kv table on a fresh home initializes defaults; unreadable/corrupt storage
// or canceled contexts return the error instead of silently enabling defaults.
func OpenStore(ctx context.Context, aiHomeDir string) (*Store, error) {
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	store := &Store{
		aiHomeDir:       strings.TrimSpace(aiHomeDir),
		dbPath:          dbPath,
		refreshInterval: defaultRefreshInterval,
		now:             time.Now,
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := store.Reload(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

// Resolve returns the effective upstream 429 retry policy for accountRef.
//
// Fast path uses a lock-free atomic snapshot when its stat fingerprint is
// trusted and within the bounded 500ms refresh window; otherwise performs a
// coherent single-transaction full reload so external CLI/Node edits are never
// missed even within the same millisecond or row count.
func (store *Store) Resolve(
	ctx context.Context,
	accountRef string,
) corepolicy.EffectivePolicy {
	if store == nil {
		return corepolicy.EffectivePolicy{
			Enabled:        false,
			BackoffSeconds: corepolicy.DefaultBackoffSeconds(),
			Source:         corepolicy.SourceGlobal,
		}
	}
	snap := store.currentSnapshot(ctx)
	ref := strings.TrimSpace(accountRef)
	override, found := snap.overrides[ref]
	return corepolicy.ResolveEffective(snap.global, override, found)
}

// GlobalPolicy returns the current sanitized global policy snapshot.
func (store *Store) GlobalPolicy(ctx context.Context) corepolicy.GlobalPolicy {
	if store == nil {
		return corepolicy.GlobalPolicy{
			Enabled:        false,
			BackoffSeconds: corepolicy.DefaultBackoffSeconds(),
		}
	}
	return store.currentSnapshot(ctx).global.Clone()
}

// GetAccountPolicy reloads coherently from SQLite so management GET always
// observes authoritative persisted state and propagates real storage errors.
func (store *Store) GetAccountPolicy(
	ctx context.Context,
	accountRef string,
) (AccountPolicyView, error) {
	if store == nil {
		return AccountPolicyView{}, fmt.Errorf("upstream 429 retry store unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	store.writeMu.Lock()
	snap, err := store.loadLocked(ctx)
	store.writeMu.Unlock()
	if err != nil {
		return AccountPolicyView{}, err
	}
	return accountPolicyViewFromSnapshot(snap, accountRef), nil
}

// UpdateGlobal refreshes the in-memory snapshot directly from committed SQLite
// state after an in-process config:server write. Reloading under writeMu avoids
// stamping fresh metadata onto stale overrides or letting out-of-order
// callbacks overwrite newer committed values.
func (store *Store) UpdateGlobal(_ corepolicy.GlobalPolicy) {
	if store == nil {
		return
	}
	store.writeMu.Lock()
	defer store.writeMu.Unlock()
	if _, err := store.loadLocked(context.Background()); err != nil {
		store.invalidateFingerprintTrustLocked()
	}
}

// SaveAccountOverride validates and persists a per-account override into app_kv
// (deleting the exact key on inherit; transactionally merging owned fields on
// enabled/disabled so stored unknown fields survive), then reloads coherently.
func (store *Store) SaveAccountOverride(
	ctx context.Context,
	accountRef string,
	override corepolicy.AccountOverride,
) (AccountPolicyView, error) {
	if store == nil {
		return AccountPolicyView{}, fmt.Errorf("upstream 429 retry store unavailable")
	}
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return AccountPolicyView{}, fmt.Errorf("accountRef is required")
	}
	validated, err := corepolicy.ValidateAccountOverride(override)
	if err != nil {
		return AccountPolicyView{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}

	store.writeMu.Lock()
	defer store.writeMu.Unlock()

	key := AccountOverrideKeyPrefix + ref
	if validated.Mode == corepolicy.ModeInherit {
		if err := appstate.DeleteKV(ctx, store.dbPath, key); err != nil {
			return AccountPolicyView{}, err
		}
	} else {
		updatedAt := store.now().UnixMilli()
		err := appstate.UpdateKV(ctx, store.dbPath, key, func(current string, found bool) (string, error) {
			stored := map[string]any{}
			if found && strings.TrimSpace(current) != "" {
				var decoded any
				if unmarshalErr := json.Unmarshal([]byte(current), &decoded); unmarshalErr != nil {
					return "", fmt.Errorf("corrupt account 429 override JSON: %w", unmarshalErr)
				}
				if mapped, ok := decoded.(map[string]any); ok && mapped != nil {
					stored = mapped
				}
			}
			stored["mode"] = string(validated.Mode)
			stored["updatedAt"] = updatedAt
			if validated.Mode == corepolicy.ModeEnabled {
				stored["backoffSeconds"] = validated.BackoffSeconds
			} else {
				delete(stored, "backoffSeconds")
			}
			encoded, marshalErr := json.Marshal(stored)
			if marshalErr != nil {
				return "", marshalErr
			}
			return string(encoded), nil
		})
		if err != nil {
			return AccountPolicyView{}, err
		}
	}

	snap, reloadErr := store.loadLocked(ctx)
	if reloadErr != nil {
		store.invalidateFingerprintTrustLocked()
		return AccountPolicyView{}, reloadErr
	}
	return accountPolicyViewFromSnapshot(snap, ref), nil
}

// DeleteAccountOverride removes the account's persisted override from app_kv
// and reloads a coherent snapshot from SQLite.
func (store *Store) DeleteAccountOverride(ctx context.Context, accountRef string) error {
	if store == nil {
		return nil
	}
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	store.writeMu.Lock()
	defer store.writeMu.Unlock()

	if err := appstate.DeleteKV(ctx, store.dbPath, AccountOverrideKeyPrefix+ref); err != nil {
		return err
	}
	if _, reloadErr := store.loadLocked(ctx); reloadErr != nil {
		store.invalidateFingerprintTrustLocked()
		return reloadErr
	}
	return nil
}

// RekeyAccountOverride atomically migrates an account's 429 retry override from
// previousRef to currentRef inside a single BEGIN IMMEDIATE transaction.
//
// Destination conflict policy: if currentRef already has a persisted override,
// the existing destination override is preserved and only the orphaned source
// key is removed. Otherwise the raw JSON value (including any stored unknown
// fields) is copied to currentRef and removed from previousRef atomically.
func (store *Store) RekeyAccountOverride(
	ctx context.Context,
	previousRef string,
	currentRef string,
) error {
	if store == nil {
		return nil
	}
	prevRef := strings.TrimSpace(previousRef)
	nextRef := strings.TrimSpace(currentRef)
	if prevRef == "" || nextRef == "" || prevRef == nextRef {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	store.writeMu.Lock()
	defer store.writeMu.Unlock()

	if _, statErr := os.Stat(store.dbPath); statErr != nil {
		if os.IsNotExist(statErr) && !store.hasDurableLoad {
			return nil
		}
		store.invalidateFingerprintTrustLocked()
		return statErr
	}

	db, err := openWritableImmediate(ctx, store.dbPath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	prevKey := AccountOverrideKeyPrefix + prevRef
	nextKey := AccountOverrideKeyPrefix + nextRef

	var prevRaw string
	err = tx.QueryRowContext(ctx, `SELECT value FROM app_kv WHERE key = ?`, prevKey).Scan(&prevRaw)
	if errors.Is(err, sql.ErrNoRows) || (isMissingTableError(err) && !store.hasDurableLoad) {
		return nil
	}
	if err != nil {
		if isMissingTableError(err) {
			store.invalidateFingerprintTrustLocked()
		}
		return err
	}

	var destSentinel int
	destErr := tx.QueryRowContext(ctx, `SELECT 1 FROM app_kv WHERE key = ?`, nextKey).Scan(&destSentinel)
	destExists := destErr == nil
	if destErr != nil && !errors.Is(destErr, sql.ErrNoRows) {
		return destErr
	}
	if !destExists {
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)`,
			nextKey,
			prevRaw,
			store.now().UnixMilli(),
		); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM app_kv WHERE key = ?`, prevKey); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if _, reloadErr := store.loadLocked(ctx); reloadErr != nil {
		store.invalidateFingerprintTrustLocked()
		return reloadErr
	}
	return nil
}

// Reload forcefully refreshes the in-memory snapshot from SQLite inside a
// single read transaction.
func (store *Store) Reload(ctx context.Context) error {
	if store == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	store.writeMu.Lock()
	defer store.writeMu.Unlock()
	_, err := store.loadLocked(ctx)
	return err
}

func (store *Store) currentSnapshot(ctx context.Context) *policySnapshot {
	snap := store.snapshot.Load()
	now := store.now()
	fp := statDBFingerprint(store.dbPath)
	if snap != nil && snap.fingerprintTrusted && fp == snap.fingerprint && now.Sub(snap.refreshedAt) < store.refreshInterval {
		return snap
	}
	store.writeMu.Lock()
	defer store.writeMu.Unlock()

	snap = store.snapshot.Load()
	now = store.now()
	fp = statDBFingerprint(store.dbPath)
	if snap != nil && snap.fingerprintTrusted && fp == snap.fingerprint && now.Sub(snap.refreshedAt) < store.refreshInterval {
		return snap
	}
	if ctx == nil {
		ctx = context.Background()
	}
	loaded, err := store.loadLocked(ctx)
	if err == nil && loaded != nil {
		return loaded
	}
	// On transient reload failure after successful startup, keep the last known
	// safe snapshot (untrusted so the next request retries) instead of replacing
	// an explicit disabled policy with enabled defaults.
	if latest := store.snapshot.Load(); latest != nil {
		return latest
	}
	if snap != nil {
		return snap
	}
	return &policySnapshot{
		global: corepolicy.GlobalPolicy{
			Enabled:        false,
			BackoffSeconds: corepolicy.DefaultBackoffSeconds(),
		},
		overrides:          map[string]corepolicy.AccountOverride{},
		fingerprintTrusted: false,
	}
}

func (store *Store) loadLocked(ctx context.Context) (*policySnapshot, error) {
	if err := ctx.Err(); err != nil {
		store.invalidateFingerprintTrustLocked()
		return nil, err
	}
	if _, statErr := os.Stat(store.dbPath); statErr != nil {
		if os.IsNotExist(statErr) && !store.hasDurableLoad {
			snap := &policySnapshot{
				global:             corepolicy.DefaultGlobalPolicy(),
				overrides:          map[string]corepolicy.AccountOverride{},
				fingerprint:        statDBFingerprint(store.dbPath),
				fingerprintTrusted: true,
				refreshedAt:        store.now(),
			}
			store.snapshot.Store(snap)
			return snap, nil
		}
		store.invalidateFingerprintTrustLocked()
		if os.IsNotExist(statErr) {
			return nil, fmt.Errorf("upstream 429 retry storage missing after durable load: %w", statErr)
		}
		return nil, statErr
	}

	fpBefore := statDBFingerprint(store.dbPath)
	db, err := appstate.OpenReadOnly(ctx, store.dbPath)
	if err != nil {
		store.invalidateFingerprintTrustLocked()
		return nil, err
	}
	defer func() { _ = db.Close() }()

	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		store.invalidateFingerprintTrustLocked()
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(
		ctx,
		`SELECT key, value FROM app_kv WHERE key = ? OR key LIKE ? ORDER BY key`,
		ServerConfigKey,
		AccountOverrideKeyPrefix+"%",
	)
	if err != nil {
		if isMissingTableError(err) && !store.hasDurableLoad {
			fpAfter := statDBFingerprint(store.dbPath)
			snap := &policySnapshot{
				global:             corepolicy.DefaultGlobalPolicy(),
				overrides:          map[string]corepolicy.AccountOverride{},
				fingerprint:        fpBefore,
				fingerprintTrusted: fpBefore == fpAfter,
				refreshedAt:        store.now(),
			}
			store.snapshot.Store(snap)
			return snap, nil
		}
		store.invalidateFingerprintTrustLocked()
		if isMissingTableError(err) {
			return nil, fmt.Errorf("upstream 429 retry app_kv table missing after durable load: %w", err)
		}
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	global := corepolicy.DefaultGlobalPolicy()
	overrides := map[string]corepolicy.AccountOverride{}
	for rows.Next() {
		var key, raw string
		if scanErr := rows.Scan(&key, &raw); scanErr != nil {
			store.invalidateFingerprintTrustLocked()
			return nil, scanErr
		}
		if key == ServerConfigKey {
			trimmed := strings.TrimSpace(raw)
			if trimmed == "" {
				continue
			}
			var decoded any
			if unmarshalErr := json.Unmarshal([]byte(trimmed), &decoded); unmarshalErr != nil {
				store.invalidateFingerprintTrustLocked()
				return nil, fmt.Errorf("corrupt %s JSON: %w", ServerConfigKey, unmarshalErr)
			}
			parsed, ok := decoded.(map[string]any)
			if !ok || parsed == nil {
				store.invalidateFingerprintTrustLocked()
				return nil, fmt.Errorf("invalid %s JSON object", ServerConfigKey)
			}
			if rawRetry, exists := parsed["upstream429Retry"]; exists {
				global = corepolicy.SanitizeGlobalRaw(rawRetry)
			}
			continue
		}
		if strings.HasPrefix(key, AccountOverrideKeyPrefix) {
			ref := strings.TrimSpace(strings.TrimPrefix(key, AccountOverrideKeyPrefix))
			if ref == "" {
				continue
			}
			if override, active := corepolicy.SanitizeAccountOverrideJSON(raw); active {
				overrides[ref] = override
			}
		}
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		store.invalidateFingerprintTrustLocked()
		return nil, rowsErr
	}
	if closeErr := rows.Close(); closeErr != nil {
		store.invalidateFingerprintTrustLocked()
		return nil, closeErr
	}
	if commitErr := tx.Commit(); commitErr != nil {
		store.invalidateFingerprintTrustLocked()
		return nil, commitErr
	}

	store.hasDurableLoad = true
	fpAfter := statDBFingerprint(store.dbPath)
	snap := &policySnapshot{
		global:             global,
		overrides:          overrides,
		fingerprint:        fpBefore,
		fingerprintTrusted: fpBefore == fpAfter,
		refreshedAt:        store.now(),
	}
	store.snapshot.Store(snap)
	return snap, nil
}

func (store *Store) invalidateFingerprintTrustLocked() {
	prev := store.snapshot.Load()
	if prev == nil || !prev.fingerprintTrusted {
		return
	}
	copied := *prev
	copied.fingerprintTrusted = false
	store.snapshot.Store(&copied)
}

func accountPolicyViewFromSnapshot(snap *policySnapshot, accountRef string) AccountPolicyView {
	ref := strings.TrimSpace(accountRef)
	override, found := snap.overrides[ref]
	if !found {
		override = corepolicy.DefaultAccountOverride()
	}
	return AccountPolicyView{
		Override:  override.Clone(),
		Global:    snap.global.Clone(),
		Effective: corepolicy.ResolveEffective(snap.global, override, found),
	}
}

func openWritableImmediate(ctx context.Context, databasePath string) (*sql.DB, error) {
	if err := businessdb.CheckReady(ctx, databasePath); err != nil {
		return nil, err
	}
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Set("mode", "rwc")
	query.Set("_txlock", "immediate")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMS))
	fileURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func isMissingTableError(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table")
}

func statDBFingerprint(dbPath string) dbFingerprint {
	var fp dbFingerprint
	if info, err := os.Stat(dbPath); err == nil {
		fp.mainExists = true
		fp.mainSize = info.Size()
		fp.mainModNS = info.ModTime().UnixNano()
	}
	if info, err := os.Stat(dbPath + "-wal"); err == nil {
		fp.walExists = true
		fp.walSize = info.Size()
		fp.walModNS = info.ModTime().UnixNano()
	}
	return fp
}
