package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ReadCodexDefaultSelection returns one authoritative, effective selection and
// operation receipt. It fails closed if the selected account is disabled/deleted.
func (store *Store) ReadCodexDefaultSelection(ctx context.Context) (owned, gateway bool, ref accountcore.AccountRef, operation string, err error) {
	var expected, selected sql.NullString
	err = store.db.QueryRowContext(ctx, `SELECT o.expected_ref,o.operation_id,
        CASE WHEN a.enabled=1 AND a.provider_id='codex' AND c.account_ref IS NOT NULL
          THEN d.account_ref ELSE NULL END
        FROM account_default_ownership o
        LEFT JOIN account_defaults d ON d.provider_id=o.provider_id
        LEFT JOIN accounts a ON a.account_ref=d.account_ref
        LEFT JOIN account_credentials c ON c.account_ref=a.account_ref
        WHERE o.provider_id='codex' AND o.owner='go'`).Scan(&expected, &operation, &selected)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, "", "", nil
	}
	if err != nil {
		return false, false, "", "", err
	}
	if !expected.Valid {
		if selected.Valid {
			return false, false, "", "", fmt.Errorf("codex_default_receipt_mismatch")
		}
		return true, true, "", operation, nil
	}
	if !selected.Valid || selected.String != expected.String {
		return false, false, "", "", fmt.Errorf("codex_default_unavailable")
	}
	ref, err = accountcore.ParseAccountRef(selected.String)
	return true, false, ref, operation, err
}
