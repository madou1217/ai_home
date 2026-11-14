package aihserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

type stubRoutingWeightsAuthorizer struct{}

func (stubRoutingWeightsAuthorizer) Authorized(r *http.Request) bool {
	return r != nil && r.Header.Get("X-AIH-Client-Key") == "secret"
}

type stubRoutingWeightsRows struct {
	rows []webuiaccountsapi.Row
}

func (s stubRoutingWeightsRows) ListAccountRows(_ context.Context, query webuiaccountsapi.Query) (webuiaccountsapi.Result, error) {
	filtered := make([]webuiaccountsapi.Row, 0, len(s.rows))
	for _, row := range s.rows {
		if (query.Provider == "" || row.Provider == query.Provider) &&
			(query.AccountRef == "" || row.AccountRef == query.AccountRef) {
			filtered = append(filtered, row)
		}
	}
	return webuiaccountsapi.Result{
		Rows: filtered,
	}, nil
}

func TestBuildWebUIRoutingWeightsRoutes_ServeMuxAndSelectionLoad(t *testing.T) {
	t.Setenv("AIH_SERVER_STRATEGY", "random")
	tracker := hookSessionActivityTracker{
		activity: sessionactivity.NewAccountActivity(sessionactivity.AccountActivityOptions{
			Window: time.Minute,
			Now:    time.Now,
		}),
	}
	tracker.activity.Begin("codex", "acc-1", "gpt-5.4")
	defer tracker.activity.End("codex", "acc-1", "gpt-5.4")

	routes, err := buildWebUIRoutingWeightsRoutes(webuiRouteDependencies{
		AIHomeDir:  t.TempDir(),
		Authorizer: stubRoutingWeightsAuthorizer{},
		AccountRows: stubRoutingWeightsRows{
			rows: []webuiaccountsapi.Row{
				{
					AccountRef: "acc-1",
					Provider:   "codex",
					Email:      "one@example.com",
					Enabled:    true,
					Configured: true,
					Status:     "up",
					IsDefault:  true,
				},
			},
		},
		AccountActivity: tracker,
	})
	if err != nil {
		t.Fatalf("buildWebUIRoutes returned error: %v", err)
	}

	mux := http.NewServeMux()
	for _, route := range routes {
		mux.Handle(route.Pattern, route.Handler)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/management/webui/routing/weights?provider=codex&model=gpt-5.4", nil)
	req.Header.Set("X-AIH-Client-Key", "secret")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var payload struct {
		OK            bool `json:"ok"`
		EligibleCount int  `json:"eligibleCount"`
		TotalCount    int  `json:"totalCount"`
		Candidates    []struct {
			AccountRef string `json:"accountRef"`
			InFlight   int    `json:"inFlight"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !payload.OK || payload.EligibleCount != 1 || payload.TotalCount != 1 || len(payload.Candidates) != 1 {
		t.Fatalf("unexpected payload: %+v", payload)
	}
	if payload.Candidates[0].AccountRef != "acc-1" || payload.Candidates[0].InFlight != 1 {
		t.Fatalf("unexpected candidate load: %+v", payload.Candidates[0])
	}
}
