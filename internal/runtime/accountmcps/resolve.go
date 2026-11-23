package accountmcps

import (
	"context"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// resolveTimeout bounds the read-only alias lookup; CLI startup must not wait on
// a locked database when no policy is involved.
const resolveTimeout = 1500 * time.Millisecond

// ResolveAccountRef maps a user-visible CLI token (number or accountRef) to its
// accountRef for one provider. Unknown tokens and database failures return false.
func ResolveAccountRef(aiHomeDir, provider, token string) (string, bool) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	token = strings.TrimSpace(token)
	if provider == "" || token == "" {
		return "", false
	}
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), resolveTimeout)
	defer cancel()
	database, err := appstate.OpenReadOnly(ctx, path)
	if err != nil {
		return "", false
	}
	defer func() { _ = database.Close() }()

	var accountRef string
	if strings.HasPrefix(token, "acct_") {
		err = database.QueryRowContext(ctx,
			`SELECT account_ref FROM account_refs WHERE account_ref = ? AND provider = ? LIMIT 1`,
			token, provider).Scan(&accountRef)
	} else {
		err = database.QueryRowContext(ctx, `
			SELECT a.account_ref
			  FROM account_cli_aliases a
			  INNER JOIN account_refs r ON r.account_ref = a.account_ref
			 WHERE a.provider = ? AND a.cli_account_id = ? AND r.provider = ?
			 ORDER BY a.updated_at DESC
			 LIMIT 1`, provider, token, provider).Scan(&accountRef)
	}
	accountRef = strings.TrimSpace(accountRef)
	if err != nil || accountRef == "" {
		return "", false
	}
	return accountRef, true
}
