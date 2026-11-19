package main

import (
	"io"
	"strings"
	"time"
)

// lsJSONDocument 是 `aih ls --json` / `aih <provider> ls --json` 的稳定输出。
//
// Node 版本没有 JSON 输出（--json 会被忽略或报错）；这是 Go 侧新增的脚本接口：
// 只暴露公开账号事实，不包含凭据、Token 或内部投影键。
type lsJSONDocument struct {
	OK        bool             `json:"ok"`
	Generated int64            `json:"generatedAt"`
	Providers []lsJSONProvider `json:"providers"`
}

type lsJSONProvider struct {
	Provider string       `json:"provider"`
	Count    int          `json:"count"`
	Accounts []lsJSONItem `json:"accounts"`
}

type lsJSONItem struct {
	ID            int64    `json:"id"`
	AccountRef    string   `json:"accountRef"`
	Provider      string   `json:"provider"`
	DisplayName   string   `json:"displayName,omitempty"`
	Email         string   `json:"email,omitempty"`
	Configured    bool     `json:"configured"`
	Enabled       bool     `json:"enabled"`
	APIKeyMode    bool     `json:"apiKeyMode"`
	BaseURL       string   `json:"baseUrl,omitempty"`
	MaskedKey     string   `json:"maskedKey,omitempty"`
	PlanType      string   `json:"planType,omitempty"`
	PlanLabel     string   `json:"planLabel,omitempty"`
	RemainingPct  *float64 `json:"remainingPct,omitempty"`
	QuotaStatus   string   `json:"quotaStatus,omitempty"`
	RuntimeStatus string   `json:"runtimeStatus,omitempty"`
	RuntimeReason string   `json:"runtimeReason,omitempty"`
	RuntimeUntil  int64    `json:"runtimeUntil,omitempty"`
	IsDefault     bool     `json:"isDefault"`
	IsMobile      bool     `json:"isMobile"`
	IdentityKey   string   `json:"identityKey,omitempty"`
	Throttle      []string `json:"throttle,omitempty"`
}

func writeLSJSON(output io.Writer, data *lsData) error {
	document := lsJSONDocument{OK: true, Generated: time.Now().UnixMilli(), Providers: []lsJSONProvider{}}
	if data == nil {
		return writeJSONDocument(output, document)
	}
	providerIDs := lsProviderIDsWithCounts(data.ProviderOrder, data.ProviderCounts, data.ProviderScope)
	byProvider := make(map[string][]*lsAccount)
	for _, account := range data.Accounts {
		if account == nil || account.Hidden {
			continue
		}
		byProvider[account.Account.Provider] = append(byProvider[account.Account.Provider], account)
	}
	for _, provider := range providerIDs {
		group := byProvider[provider]
		entry := lsJSONProvider{Provider: provider, Count: len(group), Accounts: []lsJSONItem{}}
		for _, account := range group {
			entry.Accounts = append(entry.Accounts, lsJSONItemFromAccount(account))
		}
		document.Providers = append(document.Providers, entry)
	}
	return writeJSONDocument(output, document)
}

func lsJSONItemFromAccount(account *lsAccount) lsJSONItem {
	item := lsJSONItem{
		ID:            account.Account.CLIAccountID,
		AccountRef:    account.Account.AccountRef,
		Provider:      account.Account.Provider,
		DisplayName:   strings.TrimSpace(account.Account.DisplayName),
		Email:         strings.TrimSpace(account.Account.Email),
		Configured:    account.Configured,
		Enabled:       account.Account.Enabled,
		APIKeyMode:    account.APIKeyMode,
		BaseURL:       strings.TrimSpace(account.BaseURL),
		MaskedKey:     strings.TrimSpace(account.MaskedKey),
		PlanType:      strings.TrimSpace(account.PlanType),
		PlanLabel:     strings.TrimSpace(account.PlanLabel),
		RemainingPct:  account.RemainingPct,
		QuotaStatus:   strings.TrimSpace(account.QuotaStatus),
		RuntimeStatus: account.Runtime.Status,
		RuntimeReason: account.Runtime.Reason,
		IsDefault:     account.Account.IsDefault,
		IsMobile:      account.IsMobile,
		IdentityKey:   strings.TrimSpace(account.IdentityKey),
		Throttle:      append([]string(nil), account.Throttle...),
	}
	if !account.Runtime.Until.IsZero() {
		item.RuntimeUntil = account.Runtime.Until.UnixMilli()
	}
	if item.DisplayName == "" && item.Email != "" {
		item.DisplayName = item.Email
	}
	return item
}
