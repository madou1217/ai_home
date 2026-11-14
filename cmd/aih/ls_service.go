package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/accountlistread"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// lsOptions 是 `aih ls` / `aih <provider> ls` 的查询条件。
type lsOptions struct {
	Providers        []string
	FilterID         int64
	ProviderExplicit bool
}

// lsData 是一次列表构建的完整数据。
type lsData struct {
	Accounts           []*lsAccount
	ProviderOrder      []string
	ProviderScope      map[string]bool
	ProviderScopeOrder []string
	ProviderCounts     map[string]int
	Now                time.Time
}

func loadLSData(ctx context.Context, runtime commandRuntime, options lsOptions) (*lsData, error) {
	return loadLSDataMode(ctx, runtime, options, true)
}

func loadLSDataMode(ctx context.Context, runtime commandRuntime, options lsOptions, withNodeOverlay bool) (*lsData, error) {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return nil, err
	}
	var snapshot *accountlistread.Snapshot
	if withNodeOverlay {
		snapshot, err = accountlistread.Read(ctx, aiHomeDir)
	} else {
		snapshot, err = accountlistread.ReadBasic(ctx, aiHomeDir)
	}
	if err != nil {
		if errors.Is(err, accountlistread.ErrDatabaseMissing) {
			// 兼容旧部署/测试：本机还没有 aih.db 时退回 Management API；
			// 正常本机安装始终走只读本地投影。
			if fallback, fallbackErr := loadLSDataFromManagement(ctx, runtime, options); fallbackErr == nil && fallback != nil {
				return fallback, nil
			}
			snapshot = &accountlistread.Snapshot{}
		} else {
			return nil, fmt.Errorf("读取本机账号库失败: %w", err)
		}
	}
	return buildLSDataFromSnapshot(snapshot, options, aiHomeDir, time.Now())
}

func buildLSDataFromSnapshot(
	snapshot *accountlistread.Snapshot,
	options lsOptions,
	aiHomeDir string,
	now time.Time,
) (*lsData, error) {
	accounts := buildLSAccounts(snapshot, readLSMobileRef(aiHomeDir), now)

	scope := make(map[string]bool)
	for _, provider := range options.Providers {
		provider = strings.ToLower(strings.TrimSpace(provider))
		if provider != "" {
			scope[provider] = true
		}
	}
	if len(scope) > 0 {
		filtered := accounts[:0]
		for _, account := range accounts {
			if scope[account.Account.Provider] {
				filtered = append(filtered, account)
			}
		}
		accounts = filtered
	}
	providerCounts := make(map[string]int)
	for _, account := range accounts {
		providerCounts[account.Account.Provider]++
	}
	if options.FilterID > 0 {
		filtered := accounts[:0]
		for _, account := range accounts {
			if account.Account.CLIAccountID == options.FilterID {
				filtered = append(filtered, account)
			}
		}
		accounts = filtered
		if len(scope) == 0 && !options.ProviderExplicit {
			providerCounts = make(map[string]int)
			for _, account := range accounts {
				providerCounts[account.Account.Provider]++
			}
		}
	}

	order := lsProviderOrder()
	sortLSAccounts(accounts, order)
	assignLSRotationSlots(accounts)
	return &lsData{
		Accounts:           accounts,
		ProviderOrder:      order,
		ProviderScope:      scope,
		ProviderScopeOrder: append([]string(nil), options.Providers...),
		ProviderCounts:     providerCounts,
		Now:                now,
	}, nil
}

func loadLSDataFromManagement(ctx context.Context, runtime commandRuntime, options lsOptions) (*lsData, error) {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return nil, err
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return nil, err
	}
	views := make([]managementapi.AccountView, 0)
	afterRef := ""
	for page := 0; page < 10; page++ {
		result, listErr := client.ListAccounts(ctx, managementapi.ListOptions{AfterRef: afterRef, Limit: 200})
		if listErr != nil {
			return nil, listErr
		}
		views = append(views, result.Accounts...)
		if !result.HasMore || result.NextAfterRef == "" {
			break
		}
		afterRef = result.NextAfterRef
	}
	snapshot := &accountlistread.Snapshot{Accounts: make([]accountlistread.Account, 0, len(views))}
	for _, view := range views {
		credentialJSON := []byte(nil)
		if view.HasCredential {
			credentialJSON = []byte("{}")
		}
		snapshot.Accounts = append(snapshot.Accounts, accountlistread.Account{
			AccountRef:     view.AccountRef.String(),
			Provider:       view.ProviderID,
			CLIAccountID:   view.CLIAccountID.Int64(),
			Enabled:        view.Enabled,
			CreatedAt:      view.CreatedAt,
			UpdatedAt:      view.UpdatedAt,
			AuthKind:       view.AuthKind,
			AuthMode:       view.AuthMode,
			CredentialJSON: credentialJSON,
			HasProfile:     view.HasProfile,
			DisplayName:    view.DisplayName,
			Email:          view.Email,
		})
	}
	return buildLSDataFromSnapshot(snapshot, options, aiHomeDir, time.Now())
}

func lsProviderOrder() []string {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	definitions := append([]providers.Definition(nil), catalog.List()...)
	sort.SliceStable(definitions, func(left, right int) bool {
		leftOrder, leftHas := 0, definitions[left].CLI != nil
		rightOrder, rightHas := 0, definitions[right].CLI != nil
		if leftHas {
			leftOrder = definitions[left].CLI.Order
		}
		if rightHas {
			rightOrder = definitions[right].CLI.Order
		}
		if leftHas != rightHas {
			return leftHas
		}
		if leftHas && leftOrder != rightOrder {
			return leftOrder < rightOrder
		}
		return definitions[left].ID < definitions[right].ID
	})
	order := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		order = append(order, definition.ID)
	}
	return order
}

func sortLSAccounts(accounts []*lsAccount, order []string) {
	rank := make(map[string]int, len(order))
	for index, provider := range order {
		rank[provider] = index
	}
	sort.SliceStable(accounts, func(left, right int) bool {
		leftRank, leftKnown := rank[accounts[left].Account.Provider]
		rightRank, rightKnown := rank[accounts[right].Account.Provider]
		if leftKnown != rightKnown {
			return leftKnown
		}
		if leftKnown && leftRank != rightRank {
			return leftRank < rightRank
		}
		if accounts[left].Account.Provider != accounts[right].Account.Provider {
			return accounts[left].Account.Provider < accounts[right].Account.Provider
		}
		return accounts[left].Account.CLIAccountID < accounts[right].Account.CLIAccountID
	})
}

func assignLSRotationSlots(accounts []*lsAccount) {
	rotating := 0
	for _, account := range accounts {
		multi := len(account.UsageVariants) > 1 || len(account.IdentityVariants) > 1 || len(account.Throttle) > 1
		if multi {
			account.rotationSlot = rotating
			rotating++
		} else {
			account.rotationSlot = -1
		}
	}
	for _, account := range accounts {
		account.rotatingCount = rotating
	}
}

func readLSMobileRef(aiHomeDir string) string {
	path := filepath.Join(aiHomeDir, "run", "codex", "desktop-hook-state.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var state struct {
		DesktopAccountRef string `json:"desktopAccountRef"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return ""
	}
	ref := strings.TrimSpace(state.DesktopAccountRef)
	if !regexp.MustCompile(`^acct_[a-f0-9]{20}$`).MatchString(ref) {
		return ""
	}
	return ref
}

// lsReadActivity 读取服务端落盘的账号活动；文件缺失/损坏时返回空表。
type lsActivity struct {
	AccountRef string
	InFlight   int
	Rate       int
}

func readLSActivity(aiHomeDir string) map[string]lsActivity {
	activities := make(map[string]lsActivity)
	raw, err := os.ReadFile(filepath.Join(aiHomeDir, "run", "account-activity.json"))
	if err != nil {
		return activities
	}
	var payload struct {
		Accounts map[string]struct {
			AccountRef string  `json:"accountRef"`
			InFlight   float64 `json:"inFlight"`
			Rate       float64 `json:"rate"`
		} `json:"accounts"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return activities
	}
	for key, value := range payload.Accounts {
		ref := strings.TrimSpace(value.AccountRef)
		if ref == "" {
			continue
		}
		activities[key] = lsActivity{
			AccountRef: ref,
			InFlight:   maxInt(0, int(value.InFlight)),
			Rate:       maxInt(0, int(value.Rate)),
		}
	}
	return activities
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}
