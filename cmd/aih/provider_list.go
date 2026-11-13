package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// runProviderList 实现 aih <provider> ls：账号列表与额度来自 Go Management API。
//
// 只做只读投影：不读 Node 账号索引、不打开本地 SQLite。
func runProviderList(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	filterID := int64(0)
	for _, argument := range arguments {
		if isRootHelp(argument) {
			writeProviderListUsage(runtime.stdout, providerID)
			return nil
		}
		text := strings.TrimSpace(argument)
		if text == "" {
			continue
		}
		value, err := strconv.ParseInt(text, 10, 64)
		if err != nil || value <= 0 || filterID != 0 {
			writeProviderListUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: 用法 aih %s ls [id]", errInvalidCommand, providerID)
		}
		filterID = value
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	states, _ := client.ListAccountUIStates(ctx)
	displayNames := make(map[string]string, len(states))
	for _, state := range states {
		displayNames[state.AccountRef] = state.DisplayName
	}
	accounts := make([]managementapi.AccountView, 0)
	afterRef := ""
	for page := 0; page < 10; page++ {
		result, listErr := client.ListAccounts(ctx, managementapi.ListOptions{
			AfterRef: afterRef,
			Limit:    200,
		})
		if listErr != nil {
			return fmt.Errorf("读取 Server 账号列表失败: %w", listErr)
		}
		for _, account := range result.Accounts {
			if account.ProviderID != providerID {
				continue
			}
			if filterID != 0 && account.CLIAccountID.Int64() != filterID {
				continue
			}
			accounts = append(accounts, account)
		}
		if !result.HasMore || result.NextAfterRef == "" {
			break
		}
		afterRef = result.NextAfterRef
	}
	writeProviderList(runtime.stdout, providerID, accounts, displayNames, client, ctx)
	return nil
}

func writeProviderList(
	output io.Writer,
	providerID string,
	accounts []managementapi.AccountView,
	displayNames map[string]string,
	client *managementapi.Client,
	ctx context.Context,
) {
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "📦 AI Home Accounts Overview")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintf(output, "▶ %s\n", providerID)
	if len(accounts) == 0 {
		_, _ = fmt.Fprintln(output, "  No profiles found.")
		return
	}
	for _, account := range accounts {
		writeAccountListRow(output, account, displayNames, client, ctx)
	}
}

// writeAccountListRow 是单个账号的固定行格式（单 Provider 与全局列表共用）。
func writeAccountListRow(
	output io.Writer,
	account managementapi.AccountView,
	displayNames map[string]string,
	client *managementapi.Client,
	ctx context.Context,
) {
	plan := ""
	remaining := ""
	if usage, err := client.GetUsage(ctx, account.AccountRef); err == nil {
		plan = titleCase(usage.Snapshot().PlanType())
		if min := usage.Snapshot().MinRemaining(); min.Known {
			remaining = fmt.Sprintf("%.1f%%", float64(min.BasisPoints)/100)
		}
	}
	identity := strings.TrimSpace(account.DisplayName)
	if identity == "" {
		identity = strings.TrimSpace(displayNames[account.AccountRef.String()])
	}
	if identity == "" {
		identity = strings.TrimSpace(account.Email)
	}
	if identity == "" {
		identity = "未命名"
	}
	prefix := ""
	if plan != "" {
		prefix = "[" + plan + "] "
	}
	status := ""
	if !account.Enabled {
		status = " [停用]"
	}
	remainingLabel := "Unknown"
	if remaining != "" {
		remainingLabel = remaining
	}
	_, _ = fmt.Fprintf(
		output,
		"  - %sAccount ID: %d (%s)%s [Remaining: %s]\n",
		prefix,
		account.CLIAccountID.Int64(),
		identity,
		status,
		remainingLabel,
	)
}

func writeProviderListUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "用法:\n  aih %s ls\n", providerID)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  账号与额度来自 Go Management API；仅列出该 Provider 的账号。")
}

func titleCase(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	return strings.ToUpper(text[:1]) + text[1:]
}
