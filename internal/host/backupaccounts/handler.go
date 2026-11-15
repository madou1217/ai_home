package backupaccounts

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/portableaccount"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
)

func Handler(store Store, catalog *providers.Catalog) func(context.Context, string, []byte) ([]byte, error) {
	return func(ctx context.Context, action string, raw []byte) ([]byte, error) {
		var result Result
		var e error
		switch action {
		case "import", "preflight":
			var req Request
			if json.Unmarshal(raw, &req) != nil {
				return nil, errors.New("backup_import_invalid_json")
			}
			result, e = ImportInto(ctx, store, catalog, req, action == "preflight")
		case "export":
			export, err := (remotebackup.SQLiteAccountExporter{Store: store, Catalog: catalog}).ExportAccounts(ctx)
			if err != nil {
				return nil, err
			}
			req := &Request{Kind: "aih-accounts", Version: 1, Accounts: []portableaccount.AihAccountsImportEntry{}}
			for _, record := range export.Accounts {
				native, err := json.Marshal(record.NativeAuth)
				if err != nil {
					return nil, err
				}
				req.Accounts = append(req.Accounts, portableaccount.AihAccountsImportEntry{Provider: record.Provider, AccountRef: record.AccountRef, CLIAccountID: record.CLIAccountID, Status: record.Status, Env: record.Env, NativeAuth: native})
			}
			result = Result{ProtocolVersion: 1, OK: true, Document: req, Skipped: export.Skipped}
		default:
			return nil, errors.New("backup_accounts_invalid_action")
		}
		if e != nil {
			return nil, e
		}
		return json.Marshal(result)
	}
}
