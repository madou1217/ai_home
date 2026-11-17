package distributioninstall

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"runtime"
)

// Some pre-Go releases route unknown /v1 management paths into inference and
// return no_available_account. Only an authenticated, empty legacy gateway can
// use this compatibility proof. A nonempty/unknown account or queue stays busy.
func legacyEmptyGatewayIdle(ctx context.Context, home string, c config) (bool, error) {
	if _, err := os.Stat(filepath.Join(home, "aih.db")); err == nil {
		return false, nil
	} else if !os.IsNotExist(err) {
		return false, err
	}
	ready, readyCode, readyErr := getLocal(ctx, c, "/readyz")
	if readyErr != nil || readyCode != 200 || ready["ok"] != true {
		return false, errors.New("legacy_idle_unverifiable")
	}
	core, ok := ready["go_core"].(map[string]any)
	if !ok || core["enabled"] != false || core["state"] != "disabled" {
		return false, nil
	}
	status, code, err := getLocal(ctx, c, "/v0/management/status")
	if err != nil || code != 200 || status["ok"] != true {
		return false, errors.New("legacy_idle_unverifiable")
	}
	zero := func(v any) bool { n, ok := v.(float64); return ok && n == 0 }
	if !zero(status["totalAccounts"]) || !zero(status["activeAccounts"]) {
		return false, nil
	}
	queues, ok := status["queue"].(map[string]any)
	if !ok || len(queues) == 0 {
		return false, nil
	}
	expected := []string{"codex", "gemini", "claude", "agy", "opencode", "grok", "qoder", "qodercn", "kimi", "kiro", "zcode", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn", "cline"}
	if len(queues) != len(expected) {
		return false, nil
	}
	for _, provider := range expected {
		q, ok := queues[provider].(map[string]any)
		if !ok || !zero(q["running"]) || !zero(q["queued"]) {
			return false, nil
		}
	}

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(home, "app-state.db"))+"?mode=ro")
	if err != nil {
		return false, err
	}
	defer db.Close()
	for _, table := range []string{"account_refs", "account_credentials"} {
		var count int
		if err = db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			return false, errors.New("legacy_accounts_unverifiable")
		}
	}
	scanner := hostapps.NewScanner(runtime.GOOS)
	instances, err := scanner.ListCLIInstancesStrict(ctx)
	if err != nil {
		return false, err
	}
	if len(instances) > 0 {
		return false, nil
	}
	dir := filepath.Join(home, "run", "persistent-sessions")
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return false, err
		}
		var record map[string]any
		if json.Unmarshal(raw, &record) != nil {
			return false, nil
		}
		return false, nil
	}
	return true, nil
}
