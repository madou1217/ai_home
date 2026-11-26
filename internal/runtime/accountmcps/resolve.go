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
			`SELECT account_ref FROM accounts WHERE account_ref = ? AND provider_id = ? LIMIT 1`,
			token, provider).Scan(&accountRef)
	} else {
		err = database.QueryRowContext(ctx, `
			SELECT account_ref
			  FROM accounts
			 WHERE provider_id = ? AND cli_account_id = ?
			 LIMIT 1`, provider, token).Scan(&accountRef)
	}
	accountRef = strings.TrimSpace(accountRef)
	if err != nil || accountRef == "" {
		return "", false
	}
	return accountRef, true
}
