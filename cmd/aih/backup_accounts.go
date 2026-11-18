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
	"github.com/madou1217/ai_home/internal/host/boundedinput"
)

// Private Node-to-Go pipe adapter; no server autostart, host discovery, or
// credential argv. stdout is either JSON or empty, errors never echo stdin.
func runBackupAccounts(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 2 && args[0] == "export-compat" && args[1] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, "aih-compat-export-v1")
		return err
	}
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
	case "export-compat":
		if len(args) != 1 {
			return errors.New("compat_export_arguments_invalid")
		}
		return runCompatibilityExport(ctx, home, runtime)
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
		raw, err := readBackupAccountsInput(ctx, runtime.stdin, 64*1024*1024)
		if err != nil {
			if ctx.Err() != nil {
				return errors.New("backup_import_cancelled")
			}
			if errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, boundedinput.ErrTooLarge) {
				return errors.New("backup_import_input_timeout")
			}
			return errors.New("backup_import_input_too_large")
		}
		defer clear(raw)
		if ctx.Err() != nil {
			return errors.New("backup_import_cancelled")
		}
		var request backupaccounts.Request
		decoder := json.NewDecoder(bytes.NewReader(raw))
		if decoder.Decode(&request) != nil {
			return errors.New("backup_import_invalid_json")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return errors.New("backup_import_invalid_json")
		}
		if ctx.Err() != nil {
			return errors.New("backup_import_cancelled")
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
	raw, err := readBackupAccountsInput(ctx, runtime.stdin, backupaccounts.PublicExportMaxInput)
	if err != nil {
		if ctx.Err() != nil {
			return errors.New("public_export_cancelled")
		}
		if errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, boundedinput.ErrTooLarge) {
			return errors.New("public_export_input_timeout")
		}
		return errors.New("public_export_input_invalid")
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

// Command stdin is exclusively owned while reading. The shared reader joins its
// cancellation callback before return and leaves the caller descriptor open.
// Regular-file cancellation remains cooperative during kernel I/O.
func readBackupAccountsInput(ctx context.Context, reader io.Reader, limit int64) ([]byte, error) {
	inputCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := boundedinput.Read(inputCtx, reader, limit)
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		err = inputCtx.Err()
	}
	if err != nil {
		clear(raw)
		return nil, err
	}
	return raw, nil
}

// This credential-bearing private pipe never writes an export file or starts a
// server. Its single consumer retains canonical merge and remote orchestration.
func runCompatibilityExport(ctx context.Context, home string, runtime commandRuntime) error {
	raw, err := readBackupAccountsInput(ctx, runtime.stdin, backupaccounts.CompatibilityExportMaxInput)
	if err != nil {
		if ctx.Err() != nil {
			return errors.New("compat_export_cancelled")
		}
		if errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, boundedinput.ErrTooLarge) {
			return errors.New("compat_export_input_timeout")
		}
		return errors.New("compat_export_input_invalid")
	}
	defer clear(raw)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	output, err := backupaccounts.ExportCompatibilityDocument(ctx, home, raw)
	if err != nil {
		return err
	}
	defer clear(output)
	if ctx.Err() != nil {
		return errors.New("compat_export_cancelled")
	}
	_, err = runtime.stdout.Write(output)
	return err
}
