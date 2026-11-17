package aihserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/runtime/accountadmission"
)

const deletionRecoveryPath = "/v1/management/webui/account-deletion-runtime/recovery"

var deletionLeaseToken = regexp.MustCompile(`^[a-f0-9]{64}$`)

// A restarted private Node process may restore a prepared fence. It can release
// that fence only after Go proves the deletion owner no longer holds its OS
// intent lock and observes canonical account existence under the same lock.
func accountDeletionRecoveryRoute(deps webuiRouteDependencies) webuiRoute {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		respond := func(code int, value any) { w.WriteHeader(code); _ = json.NewEncoder(w).Encode(value) }
		if deps.Authorizer == nil || !deps.Authorizer.Authorized(r) {
			respond(http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		if r.Method != http.MethodPost {
			respond(http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		var input struct {
			Provider   string `json:"provider"`
			AccountRef string `json:"accountRef"`
			Lease      string `json:"lease"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 4097))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil || !deletionLeaseToken.MatchString(input.Lease) {
			respond(400, map[string]any{"ok": false, "error": "invalid_recovery_request"})
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			respond(400, map[string]any{"ok": false, "error": "invalid_recovery_request"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		table, err := accountrefmap.LoadStrict(ctx, deps.AIHomeDir)
		if err != nil {
			respond(503, map[string]any{"ok": false, "error": "account_runtime_unverifiable"})
			return
		}
		ref, err := accountcore.ParseAccountRef(table.GoRef(input.AccountRef))
		if err != nil || deps.Store == nil {
			respond(400, map[string]any{"ok": false, "error": "invalid_recovery_request"})
			return
		}
		if deps.Catalog == nil {
			respond(503, map[string]any{"ok": false, "error": "account_runtime_unverifiable"})
			return
		}
		canonical, known := deps.Catalog.CanonicalID(input.Provider)
		if !known || canonical != input.Provider {
			respond(400, map[string]any{"ok": false, "error": "invalid_recovery_request"})
			return
		}
		result := map[string]any{"ok": true, "provider": input.Provider, "accountRef": input.AccountRef, "lease": input.Lease, "state": "pending"}
		lock, err := accountadmission.Deleting(deps.AIHomeDir, input.Provider, ref.String())
		if errors.Is(err, accountadmission.ErrBusy) {
			respond(200, result)
			return
		}
		if err != nil {
			respond(503, map[string]any{"ok": false, "error": "account_runtime_unverifiable"})
			return
		}
		defer lock.Close()
		account, err := deps.Store.GetByRef(ctx, ref)
		switch {
		case err == nil && account.ProviderID() == input.Provider:
			result["state"] = "aborted"
		case errors.Is(err, accountapp.ErrAccountNotFound):
			result["state"] = "committed"
		default:
			respond(503, map[string]any{"ok": false, "error": "account_runtime_unverifiable"})
			return
		}
		respond(200, result)
	})
	return webuiRoute{Pattern: "POST " + deletionRecoveryPath, Handler: handler, SkipPublicAlias: true}
}
