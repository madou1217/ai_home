package rulesenv

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

const testRef = "acct_0123456789abcdef0123"

type fixture struct {
	store *Store
	db    *sql.DB
	path  string
}

func newFixture(t *testing.T, envJSON string, envUpdatedAt int64) *fixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app-state.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, statement := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE account_credentials (account_ref TEXT PRIMARY KEY, env_json TEXT NOT NULL DEFAULT '{}', native_auth_json TEXT NOT NULL DEFAULT '{}', env_updated_at INTEGER NOT NULL DEFAULT 0, native_auth_updated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	if _, err := db.Exec("INSERT INTO account_refs VALUES (?, 'claude', 1, 1)", testRef); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	nativeAuth := string(mustJSON(t, map[string]any{"token": "native"}))
	if _, err := db.Exec(
		"INSERT INTO account_credentials (account_ref, env_json, native_auth_json, env_updated_at, native_auth_updated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		testRef, envJSON, nativeAuth, envUpdatedAt, 1700000000111, 1700000000222,
	); err != nil {
		t.Fatalf("insert account_credentials: %v", err)
	}
	store, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return &fixture{store: store, db: db, path: path}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}

func (f *fixture) storedEnv(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	var raw string
	if err := f.db.QueryRow("SELECT env_json FROM account_credentials WHERE account_ref = ?", testRef).Scan(&raw); err != nil {
		t.Fatalf("read env_json: %v", err)
	}
	env := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("decode env_json: %v", err)
	}
	return env
}

func (f *fixture) rowTimestamps(t *testing.T) (envUpdatedAt int64, nativeAuthUpdatedAt int64, updatedAt int64, nativeAuth string) {
	t.Helper()
	if err := f.db.QueryRow(
		"SELECT env_updated_at, native_auth_updated_at, updated_at, native_auth_json FROM account_credentials WHERE account_ref = ?",
		testRef,
	).Scan(&envUpdatedAt, &nativeAuthUpdatedAt, &updatedAt, &nativeAuth); err != nil {
		t.Fatalf("read timestamps: %v", err)
	}
	return envUpdatedAt, nativeAuthUpdatedAt, updatedAt, nativeAuth
}

func envString(t *testing.T, env map[string]json.RawMessage, key string) string {
	t.Helper()
	raw, exists := env[key]
	if !exists {
		t.Fatalf("env key %s missing", key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode env value %s: %v", key, err)
	}
	return value
}

func seedEnv(t *testing.T, rules []map[string]any, groupIDs []string) string {
	t.Helper()
	env := map[string]string{"OPENAI_API_KEY": "sk-live"}
	if rules != nil {
		env[RulesEnvKey] = string(mustJSON(t, rules))
	}
	if groupIDs != nil {
		env[GroupIDsEnvKey] = string(mustJSON(t, groupIDs))
	}
	return string(mustJSON(t, env))
}

func TestUpdatePreservesOtherEnvKeysAndCredentialTimestamp(t *testing.T) {
	f := newFixture(t, seedEnv(t, []map[string]any{{"name": "old"}}, []string{"legacy"}), 1710000000000)
	f.store.now = func() time.Time { return time.UnixMilli(1710000009999) }

	newRules := []json.RawMessage{json.RawMessage(mustJSON(t, map[string]any{"name": "new"}))}
	result, err := f.store.Update(context.Background(), "  "+testRef+"  ", Change{
		Rules:    newRules,
		GroupIDs: []string{" billing ", "billing", "quota"},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !result.Changed {
		t.Fatalf("expected change")
	}
	if result.EnvUpdatedAt != 1710000000000 {
		t.Fatalf("result env_updated_at = %d", result.EnvUpdatedAt)
	}

	env := f.storedEnv(t)
	if got := envString(t, env, "OPENAI_API_KEY"); got != "sk-live" {
		t.Fatalf("other env key changed: %q", got)
	}
	var rules []map[string]any
	if err := json.Unmarshal([]byte(envString(t, env, RulesEnvKey)), &rules); err != nil {
		t.Fatalf("decode rules: %v", err)
	}
	if len(rules) != 1 || rules[0]["name"] != "new" {
		t.Fatalf("rules = %#v", rules)
	}
	var groupIDs []string
	if err := json.Unmarshal([]byte(envString(t, env, GroupIDsEnvKey)), &groupIDs); err != nil {
		t.Fatalf("decode group ids: %v", err)
	}
	if fmt.Sprint(groupIDs) != "[billing quota]" {
		t.Fatalf("group ids = %v", groupIDs)
	}

	envUpdatedAt, nativeAuthUpdatedAt, updatedAt, nativeAuth := f.rowTimestamps(t)
	if envUpdatedAt != 1710000000000 {
		t.Fatalf("env_updated_at changed to %d", envUpdatedAt)
	}
	if nativeAuthUpdatedAt != 1700000000111 {
		t.Fatalf("native_auth_updated_at changed to %d", nativeAuthUpdatedAt)
	}
	if nativeAuth != string(mustJSON(t, map[string]any{"token": "native"})) {
		t.Fatalf("native_auth_json changed: %s", nativeAuth)
	}
	if updatedAt != 1710000009999 {
		t.Fatalf("updated_at = %d", updatedAt)
	}
}

func TestUpdateClearsRulesWithoutTouchingOtherKeys(t *testing.T) {
	f := newFixture(t, seedEnv(t, []map[string]any{{"name": "old"}}, []string{"legacy"}), 1710000000000)
	f.store.now = func() time.Time { return time.UnixMilli(1710000001234) }

	result, err := f.store.Update(context.Background(), testRef, Change{
		Rules:    []json.RawMessage{},
		GroupIDs: []string{},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !result.Changed {
		t.Fatalf("expected change")
	}
	env := f.storedEnv(t)
	if _, exists := env[RulesEnvKey]; exists {
		t.Fatalf("rules key not deleted")
	}
	if _, exists := env[GroupIDsEnvKey]; exists {
		t.Fatalf("group ids key not deleted")
	}
	if got := envString(t, env, "OPENAI_API_KEY"); got != "sk-live" {
		t.Fatalf("other env key changed: %q", got)
	}
	envUpdatedAt, _, updatedAt, _ := f.rowTimestamps(t)
	if envUpdatedAt != 1710000000000 {
		t.Fatalf("env_updated_at changed to %d", envUpdatedAt)
	}
	if updatedAt != 1710000001234 {
		t.Fatalf("updated_at = %d", updatedAt)
	}
}

func TestUpdateKeepsUnspecifiedRulesKey(t *testing.T) {
	f := newFixture(t, seedEnv(t, []map[string]any{{"name": "old"}}, []string{"legacy"}), 1710000000000)

	newRules := []json.RawMessage{json.RawMessage(mustJSON(t, map[string]any{"name": "new"}))}
	if _, err := f.store.Update(context.Background(), testRef, Change{Rules: newRules}); err != nil {
		t.Fatalf("update rules only: %v", err)
	}
	env := f.storedEnv(t)
	var groupIDs []string
	if err := json.Unmarshal([]byte(envString(t, env, GroupIDsEnvKey)), &groupIDs); err != nil {
		t.Fatalf("decode group ids: %v", err)
	}
	if fmt.Sprint(groupIDs) != "[legacy]" {
		t.Fatalf("group ids = %v", groupIDs)
	}

	if _, err := f.store.Update(context.Background(), testRef, Change{GroupIDs: []string{"billing"}}); err != nil {
		t.Fatalf("update groups only: %v", err)
	}
	env = f.storedEnv(t)
	var rules []map[string]any
	if err := json.Unmarshal([]byte(envString(t, env, RulesEnvKey)), &rules); err != nil {
		t.Fatalf("decode rules: %v", err)
	}
	if len(rules) != 1 || rules[0]["name"] != "new" {
		t.Fatalf("rules = %#v", rules)
	}
}

func TestUpdateNoOpSkipsWrite(t *testing.T) {
	rules := []map[string]any{{"name": "same"}}
	f := newFixture(t, seedEnv(t, rules, []string{"legacy"}), 1710000000000)

	result, err := f.store.Update(context.Background(), testRef, Change{
		Rules:    []json.RawMessage{json.RawMessage(mustJSON(t, map[string]any{"name": "same"}))},
		GroupIDs: []string{"legacy"},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if result.Changed {
		t.Fatalf("expected no change")
	}
	envUpdatedAt, _, updatedAt, _ := f.rowTimestamps(t)
	if envUpdatedAt != 1710000000000 {
		t.Fatalf("env_updated_at changed to %d", envUpdatedAt)
	}
	if updatedAt != 1700000000222 {
		t.Fatalf("updated_at rewritten to %d", updatedAt)
	}
}

func TestUpdateRefusesNonObjectEnv(t *testing.T) {
	f := newFixture(t, "[]", 1710000000000)

	_, err := f.store.Update(context.Background(), testRef, Change{Rules: []json.RawMessage{json.RawMessage("{}")}})
	if !errors.Is(err, ErrInvalidEnvJSON) {
		t.Fatalf("err = %v", err)
	}
	_, _, updatedAt, _ := f.rowTimestamps(t)
	if updatedAt != 1700000000222 {
		t.Fatalf("updated_at rewritten to %d", updatedAt)
	}
}

func TestUpdateUnknownAccount(t *testing.T) {
	f := newFixture(t, seedEnv(t, nil, nil), 1710000000000)

	if _, err := f.store.Update(context.Background(), "acct_ffffffffffffffffffff", Change{Rules: []json.RawMessage{}}); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("err = %v", err)
	}
	if _, err := f.store.Update(context.Background(), "   ", Change{Rules: []json.RawMessage{}}); !errors.Is(err, ErrInvalidAccountRef) {
		t.Fatalf("err = %v", err)
	}
}

func TestUpdateValidatesPayloadBeforeWriting(t *testing.T) {
	f := newFixture(t, seedEnv(t, []map[string]any{{"name": "old"}}, []string{"legacy"}), 1710000000000)
	ctx := context.Background()

	invalidRules := []json.RawMessage{json.RawMessage("1")}
	if _, err := f.store.Update(ctx, testRef, Change{Rules: invalidRules}); !errors.Is(err, ErrInvalidRules) {
		t.Fatalf("scalar rule err = %v", err)
	}
	nullRule := []json.RawMessage{json.RawMessage("null")}
	if _, err := f.store.Update(ctx, testRef, Change{Rules: nullRule}); !errors.Is(err, ErrInvalidRules) {
		t.Fatalf("null rule err = %v", err)
	}
	if _, err := f.store.Update(ctx, testRef, Change{GroupIDs: []string{"bad id!"}}); !errors.Is(err, ErrInvalidGroupIDs) {
		t.Fatalf("bad group err = %v", err)
	}
	tooMany := make([]string, 0, 21)
	for index := 0; index < 21; index++ {
		tooMany = append(tooMany, fmt.Sprintf("g%d", index))
	}
	if _, err := f.store.Update(ctx, testRef, Change{GroupIDs: tooMany}); !errors.Is(err, ErrInvalidGroupIDs) {
		t.Fatalf("too many groups err = %v", err)
	}
	_, _, updatedAt, _ := f.rowTimestamps(t)
	if updatedAt != 1700000000222 {
		t.Fatalf("updated_at rewritten to %d", updatedAt)
	}
}

func TestReadReturnsRulesAndCredentialTimestamp(t *testing.T) {
	f := newFixture(t, seedEnv(t, []map[string]any{{"name": "old"}}, []string{"billing"}), 1710000000000)

	state, err := f.store.Read(context.Background(), testRef)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(state.Rules) != 1 {
		t.Fatalf("rules = %#v", state.Rules)
	}
	if len(state.GroupIDs) != 1 || state.GroupIDs[0] != "billing" {
		t.Fatalf("group ids = %v", state.GroupIDs)
	}
	if state.EnvUpdatedAt != 1710000000000 {
		t.Fatalf("env_updated_at = %d", state.EnvUpdatedAt)
	}
}

func TestConcurrentWritersMergeDistinctKeys(t *testing.T) {
	f := newFixture(t, seedEnv(t, nil, nil), 1710000000000)
	second, err := Open(context.Background(), f.path)
	if err != nil {
		t.Fatalf("open second store: %v", err)
	}
	defer func() { _ = second.Close() }()

	const rounds = 20
	var wait sync.WaitGroup
	errs := make(chan error, rounds*2)
	for index := 0; index < rounds; index++ {
		wait.Add(2)
		go func(round int) {
			defer wait.Done()
			rules := []json.RawMessage{json.RawMessage(mustJSON(t, map[string]any{"name": fmt.Sprintf("rule-%d", round)}))}
			if _, err := f.store.Update(context.Background(), testRef, Change{Rules: rules}); err != nil {
				errs <- err
			}
		}(index)
		go func(round int) {
			defer wait.Done()
			if _, err := second.Update(context.Background(), testRef, Change{GroupIDs: []string{fmt.Sprintf("group-%d", round)}}); err != nil {
				errs <- err
			}
		}(index)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent update: %v", err)
	}

	env := f.storedEnv(t)
	if _, exists := env[RulesEnvKey]; !exists {
		t.Fatalf("rules key lost")
	}
	if _, exists := env[GroupIDsEnvKey]; !exists {
		t.Fatalf("group ids key lost")
	}
	if got := envString(t, env, "OPENAI_API_KEY"); got != "sk-live" {
		t.Fatalf("other env key lost: %q", got)
	}
}
