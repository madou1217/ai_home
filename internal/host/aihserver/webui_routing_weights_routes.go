package aihserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiroutingweightsapi"
)

const routingWeightsPoolPageSize = 200

type selectionLoadTracker interface {
	SelectionLoad(provider, accountRef, model string) sessionactivity.SelectionLoad
}

// buildWebUIRoutingWeightsRoutes 装配 GET /v1/management/webui/routing/weights 只读诊断路由。
//
// 选号权重、目录收窄、运行态资格与并发负载全部来自 Go 自己的真相源（AccountRows /
// sqliteaccount.Store / AccountRuntime / UsageService / AccountActivity），与服务端
// 征召共享同一个 strategy 与 usageSchedulingGate。
func buildWebUIRoutingWeightsRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}
	if dependencies.AccountRows == nil && dependencies.Store == nil {
		return nil, nil
	}

	strategy, err := accountrouting.ParseSelectionStrategy(os.Getenv("AIH_SERVER_STRATEGY"))
	if err != nil {
		return nil, fmt.Errorf("解析账号选号策略失败: %w", err)
	}

	var usageGate webuiroutingweightsapi.UsageGate
	if dependencies.UsageService != nil {
		usageGate = newUsageSchedulingGate(dependencies.UsageService, dependencies.AIHomeDir, time.Now)
	}

	var catalogSource webuiroutingweightsapi.ModelCatalogSource
	var stateSource webuiroutingweightsapi.AccountStateSource
	if dependencies.Store != nil {
		catalogSource = dependencies.Store
		stateSource = dependencies.Store
	}

	var settingsSource webuiroutingweightsapi.ModelSettingsSource
	if strings.TrimSpace(dependencies.AIHomeDir) != "" {
		settingsSource = appStateModelSettingsSource{aiHomeDir: dependencies.AIHomeDir}
	}

	runtimeSource, _ := dependencies.AccountRuntime.(webuiroutingweightsapi.RuntimeSource)
	eligibilitySource, _ := dependencies.AccountRuntime.(webuiroutingweightsapi.RuntimeEligibilitySource)

	handler, err := webuiroutingweightsapi.NewHandler(webuiroutingweightsapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Pool: routingWeightsPoolSource{
			rows:  dependencies.AccountRows,
			store: dependencies.Store,
		},
		Catalog:     catalogSource,
		Settings:    settingsSource,
		Runtime:     runtimeSource,
		Eligibility: eligibilitySource,
		States:      stateSource,
		UsageGate:   usageGate,
		Activity:    newRoutingWeightsActivitySource(dependencies.AccountActivity, dependencies.AIHomeDir),
		Strategy:    string(strategy),
	})
	if err != nil {
		return nil, fmt.Errorf("创建路由权重诊断接口失败: %w", err)
	}

	return []webuiRoute{
		{
			Pattern: "GET " + webuiroutingweightsapi.Path,
			Handler: handler,
		},
	}, nil
}

type routingWeightsPoolSource struct {
	rows  webuiaccountsapi.Source
	store *sqliteaccount.Store
}

func (source routingWeightsPoolSource) ListProviderPool(
	ctx context.Context,
	provider string,
) ([]webuiroutingweightsapi.PoolAccount, error) {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if source.rows != nil {
		return source.listFromRows(ctx, normalizedProvider)
	}
	if source.store != nil {
		return source.listFromStore(ctx, normalizedProvider)
	}
	return nil, nil
}

func (source routingWeightsPoolSource) listFromRows(
	ctx context.Context,
	provider string,
) ([]webuiroutingweightsapi.PoolAccount, error) {
	pool := make([]webuiroutingweightsapi.PoolAccount, 0)
	afterRef := ""
	for {
		result, err := source.rows.ListAccountRows(ctx, webuiaccountsapi.Query{
			Provider: provider,
			AfterRef: afterRef,
			Limit:    routingWeightsPoolPageSize,
		})
		if err != nil {
			return nil, err
		}
		for _, row := range result.Rows {
			if !row.Enabled || !row.Configured {
				continue
			}
			snapshotMap, _ := row.UsageSnapshot.(map[string]any)
			email := strings.TrimSpace(row.Email)
			if email == "" {
				email = extractSnapshotAccountEmail(snapshotMap)
			}
			var cliIDPtr *int64
			if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(row.DisplayID), 10, 64); parseErr == nil && parsed > 0 {
				cliIDPtr = &parsed
			}
			pool = append(pool, webuiroutingweightsapi.PoolAccount{
				AccountRef:        row.AccountRef,
				Provider:          strings.ToLower(strings.TrimSpace(row.Provider)),
				CLIAccountID:      cliIDPtr,
				Email:             email,
				Enabled:           row.Enabled,
				Configured:        row.Configured,
				APIKeyMode:        row.APIKeyMode,
				RemainingPct:      row.RemainingPct,
				UsageSnapshot:     snapshotMap,
				QuotaStatus:       row.QuotaStatus,
				SchedulableStatus: row.SchedulableStatus,
			})
		}
		if len(result.Rows) < routingWeightsPoolPageSize {
			break
		}
		lastRef := strings.TrimSpace(result.Rows[len(result.Rows)-1].AccountRef)
		if lastRef == "" || lastRef == afterRef {
			break
		}
		afterRef = lastRef
	}
	return pool, nil
}

func (source routingWeightsPoolSource) listFromStore(
	ctx context.Context,
	provider string,
) ([]webuiroutingweightsapi.PoolAccount, error) {
	pool := make([]webuiroutingweightsapi.PoolAccount, 0)
	var afterRef accountcore.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		overviews, err := source.store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		for _, overview := range overviews {
			account := overview.Account()
			if !strings.EqualFold(account.ProviderID(), provider) {
				continue
			}
			if !account.Enabled() || !overview.HasCredential() {
				continue
			}
			apiKeyMode := strings.EqualFold(overview.AuthMode(), "api-key") ||
				strings.EqualFold(overview.AuthKind(), "api_key") ||
				strings.EqualFold(overview.AuthKind(), "api-key")

			var cliIDPtr *int64
			if id := account.CLIAccountID().Int64(); id > 0 {
				cliIDPtr = &id
			}

			var remainingPtr *float64
			quotaStatus := ""
			if qState, found := overview.QuotaState(); found {
				quotaStatus = qState.Status()
				if !apiKeyMode && qState.HasNumericRemaining() {
					pct := float64(qState.RemainingBPS()) / 100.0
					remainingPtr = &pct
				}
			}

			var snapshotMap map[string]any
			if snap, hasSnap := overview.UsageSnapshot(); hasSnap {
				snapshotMap = buildSnapshotMap(snap)
				if remainingPtr == nil && !apiKeyMode {
					if minRem := snap.MinRemaining(); minRem.Known {
						pct := float64(minRem.BasisPoints) / 100.0
						remainingPtr = &pct
					}
				}
			}

			email := strings.TrimSpace(overview.Email())
			if email == "" {
				email = extractSnapshotAccountEmail(snapshotMap)
			}

			schedulableStatus := "schedulable"
			if strings.EqualFold(quotaStatus, "exhausted") {
				schedulableStatus = "blocked_by_quota"
			}

			pool = append(pool, webuiroutingweightsapi.PoolAccount{
				AccountRef:        account.Ref().String(),
				Provider:          strings.ToLower(strings.TrimSpace(account.ProviderID())),
				CLIAccountID:      cliIDPtr,
				Email:             email,
				Enabled:           account.Enabled(),
				Configured:        overview.HasCredential(),
				APIKeyMode:        apiKeyMode,
				RemainingPct:      remainingPtr,
				UsageSnapshot:     snapshotMap,
				QuotaStatus:       quotaStatus,
				SchedulableStatus: schedulableStatus,
			})
		}
		if len(overviews) < accountapp.MaxOverviewLimit {
			break
		}
		lastRef := overviews[len(overviews)-1].Account().Ref()
		if !lastRef.IsValid() || lastRef == afterRef {
			break
		}
		afterRef = lastRef
	}
	return pool, nil
}

func buildSnapshotMap(snapshot usagecore.Snapshot) map[string]any {
	entries := snapshot.Entries()
	models := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		if entry.Scope() != usagecore.ScopeModelFamily {
			continue
		}
		item := map[string]any{
			"model": entry.ScopeKey(),
		}
		if bps, known := entry.RemainingBasisPoints(); known {
			item["remainingPct"] = float64(bps) / 100.0
		}
		if resetAt := entry.ResetAt(); !resetAt.IsZero() {
			item["resetAtMs"] = resetAt.UTC().UnixMilli()
		}
		models = append(models, item)
	}
	return map[string]any{
		"capturedAt": snapshot.CapturedAt().UTC().UnixMilli(),
		"models":     models,
	}
}

func extractSnapshotAccountEmail(snapshot map[string]any) string {
	if len(snapshot) == 0 {
		return ""
	}
	accountObj, ok := snapshot["account"].(map[string]any)
	if !ok {
		return ""
	}
	email, _ := accountObj["email"].(string)
	return strings.TrimSpace(email)
}

type appStateModelSettingsSource struct {
	aiHomeDir string
}

func (source appStateModelSettingsSource) LoadModelSettings(ctx context.Context) (modelcatalogsettings.Settings, error) {
	databasePath, err := appstate.DatabasePath(source.aiHomeDir)
	if err != nil {
		return modelcatalogsettings.Normalize(nil), nil
	}
	return modelcatalogsettings.Load(ctx, databasePath)
}

type routingWeightsActivitySource struct {
	live      selectionLoadTracker
	aiHomeDir string
}

func newRoutingWeightsActivitySource(tracker any, aiHomeDir string) webuiroutingweightsapi.ActivitySource {
	live, _ := tracker.(selectionLoadTracker)
	return routingWeightsActivitySource{
		live:      live,
		aiHomeDir: strings.TrimSpace(aiHomeDir),
	}
}

func (source routingWeightsActivitySource) SelectionLoad(provider, accountRef, model string) sessionactivity.SelectionLoad {
	if source.live != nil {
		return source.live.SelectionLoad(provider, accountRef, model)
	}
	load := sessionactivity.SelectionLoad{
		WindowMS: sessionactivity.DefaultRateWindow.Milliseconds(),
	}
	if source.aiHomeDir == "" {
		return load
	}
	raw, err := os.ReadFile(filepath.Join(source.aiHomeDir, "run", "account-activity.json"))
	if err != nil {
		return load
	}
	var doc sessionactivity.ActivityDocument
	if json.Unmarshal(raw, &doc) != nil || len(doc.Accounts) == 0 {
		return load
	}
	key := strings.ToLower(strings.TrimSpace(provider)) + ":" + strings.TrimSpace(accountRef)
	snap, found := doc.Accounts[key]
	if !found {
		return load
	}
	load.InFlight = snap.InFlight
	load.Rate = snap.Rate
	return load
}

var _ webuiroutingweightsapi.RuntimeSource = (runtimeapp.Snapshotter)(nil)
