package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/host/backupaccounts"
)

// Private Node-to-Go pipe adapter; no server autostart, host discovery, or
// credential argv. stdout is either JSON or empty, errors never echo stdin.
func runBackupAccounts(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 2 && args[0] == "export-public" && args[1] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, "aih-public-export-v1")
		return err
	}
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
	case "export-public":
		if len(args) != 1 {
			return errors.New("public_export_arguments_invalid")
		}
		return runPublicExport(ctx, home, runtime)
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

// The public export uses a separately bounded typed port. Its stdout never
// contains the exported account document or credential diagnostics.
func runPublicExport(ctx context.Context, home string, runtime commandRuntime) error {
	type input struct {
		raw []byte
		err error
	}
	ready := make(chan input, 1)
	go func() {
		raw, err := io.ReadAll(io.LimitReader(runtime.stdin, backupaccounts.PublicExportMaxInput+1))
		ready <- input{raw, err}
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var raw []byte
	select {
	case <-ctx.Done():
		return errors.New("public_export_cancelled")
	case <-timer.C:
		return errors.New("public_export_input_timeout")
	case in := <-ready:
		raw = in.raw
		if in.err != nil || len(raw) > backupaccounts.PublicExportMaxInput {
			return errors.New("public_export_input_invalid")
		}
	}
	defer clear(raw)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	result, err := backupaccounts.ExportPublic(ctx, home, raw)
	if err != nil {
		return err
	}
	return json.NewEncoder(runtime.stdout).Encode(result)
}
