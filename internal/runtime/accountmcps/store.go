// Package accountmcps persists per-account MCP policies.
package accountmcps

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/mcpscope"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const keyPrefix = "account:mcp-policy:"

// Store keeps one MCP policy per account in app-state.
type Store struct {
	aiHomeDir    string
	databasePath string
}

// NewStore resolves the app-state path once at wiring time.
func NewStore(aiHomeDir string) (*Store, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &Store{aiHomeDir: aiHomeDir, databasePath: path}, nil
}

// Get returns the saved policy, or auto when none exists.
func (store *Store) Get(ctx context.Context, accountRef string) (mcpscope.Policy, error) {
	raw, found, err := appstate.ReadKV(ctx, store.databasePath, key(accountRef))
	if err != nil {
		return mcpscope.Policy{}, err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return mcpscope.Policy{Mode: mcpscope.ModeAuto}, nil
	}
	var policy mcpscope.Policy
	if err := json.Unmarshal([]byte(raw), &policy); err != nil {
		return mcpscope.Policy{}, err
	}
	if policy.Mode == "" {
		policy.Mode = mcpscope.ModeAuto
	}
	return policy, nil
}

// Save validates and persists the policy.
func (store *Store) Save(ctx context.Context, accountRef string, policy mcpscope.Policy) error {
	definitions, err := mcpscope.LoadRegistry(store.aiHomeDir)
	if err != nil {
		return err
	}
	if err := mcpscope.ValidateWith(definitions, policy); err != nil {
		return err
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	return appstate.WriteKV(ctx, store.databasePath, key(accountRef), string(raw), time.Now().UnixMilli())
}

// LookupProvider returns the provider that owns accountRef.
func (store *Store) LookupProvider(ctx context.Context, accountRef string) (string, bool, error) {
	return appstate.LookupAccountProvider(ctx, store.databasePath, accountRef)
}

func key(accountRef string) string {
	return keyPrefix + strings.TrimSpace(accountRef)
}
