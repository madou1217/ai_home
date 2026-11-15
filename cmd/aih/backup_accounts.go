package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/madou1217/ai_home/internal/host/backupaccounts"
)

// Private Node-to-Go pipe adapter; no server autostart, host discovery, or
// credential argv. stdout is either JSON or empty, errors never echo stdin.
func runBackupAccounts(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New("backup_accounts_invalid_action")
	}
	explicit, found := runtime.lookupEnv("AIH_HOME_DIR")
	if !found || strings.TrimSpace(explicit) == "" {
		return errors.New("backup_accounts_explicit_home_required")
	}
	home, e := resolveAIHomeDir(runtime)
	if e != nil {
		return e
	}
	var result backupaccounts.Result
	switch args[0] {
	case "export":
		if len(args) != 1 {
			return errors.New("backup_accounts_invalid_action")
		}
		result, e = backupaccounts.Export(ctx, home)
	case "import":
		dry := len(args) == 2 && args[1] == "--dry-run"
		if len(args) == 2 && !dry {
			return errors.New("backup_accounts_invalid_action")
		}
		raw, err := io.ReadAll(io.LimitReader(runtime.stdin, 64*1024*1024+1))
		if err != nil || len(raw) > 64*1024*1024 {
			return errors.New("backup_import_input_too_large")
		}
		defer clear(raw)
		var request backupaccounts.Request
		decoder := json.NewDecoder(bytes.NewReader(raw))
		if decoder.Decode(&request) != nil {
			return errors.New("backup_import_invalid_json")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return errors.New("backup_import_invalid_json")
		}
		result, e = backupaccounts.Import(ctx, home, request, dry)
	default:
		return errors.New("backup_accounts_invalid_action")
	}
	if e != nil {
		return errors.New("backup_accounts_core_failed")
	}
	return json.NewEncoder(runtime.stdout).Encode(result)
}
