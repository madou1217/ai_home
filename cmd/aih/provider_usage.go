package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runProviderUsage 实现 aih <provider> usage [id] [--refresh]。
//
// 数据面固定走 Go Management API：账号解析、额度快照、完整快照文档与刷新都在
// Go 侧完成，不再由 Node CLI 本地读缓存再拼展示。
func runProviderUsage(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	for _, argument := range arguments {
		if isRootHelp(argument) {
			writeProviderUsageUsage(runtime.stdout, providerID)
			return nil
		}
	}
	refresh := false
	accountID := ""
	for _, argument := range arguments {
		if argument == "--refresh" {
			if refresh {
				return fmt.Errorf("%w: --refresh 不能重复", errInvalidCommand)
			}
			refresh = true
			continue
		}
		if accountID != "" {
			return fmt.Errorf("%w: usage 只接受一个账号 ID", errInvalidCommand)
		}
		if _, err := strconv.ParseUint(argument, 10, 64); err != nil {
			return fmt.Errorf("%w: 账号 ID 必须是正整数", errInvalidCommand)
		}
		accountID = argument
	}
	if accountID == "" {
		if err := runProviderUsageAll(ctx, providerID, refresh, runtime); err != nil {
			return err
		}
		return nil
	}
	target, err := aihaccount.ParseAccountTarget(providerID + ":" + accountID)
	if err != nil {
		return fmt.Errorf("%w: 账号目标无效", errInvalidCommand)
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	accountRef, err := resolveManagementAccountRef(ctx, client, target)
	if err != nil {
		return fmt.Errorf("解析 Server 账号目标失败: %w", err)
	}
	var result managementapi.UsageResult
	if refresh {
		// 刷新要打上游，额度探测可能超过 10s；单独放宽超时。
		refreshClient := client
		if slower, slowErr := newAccountManagementClientWithTimeout(runtime, 60*time.Second); slowErr == nil {
			refreshClient = slower
		}
		result, err = refreshClient.RefreshUsage(ctx, accountRef)
		if err != nil {
			// 与 Node 一致：刷新失败时退回缓存快照并显式告警，不让命令整体失败。
			cached, cachedErr := client.GetUsage(ctx, accountRef)
			if cachedErr != nil {
				// Server 在刷新失败的瞬间可能把错误连带返回给读接口；短暂退避后重试一次。
				select {
				case <-time.After(400 * time.Millisecond):
				case <-ctx.Done():
					return ctx.Err()
				}
				cached, cachedErr = client.GetUsage(ctx, accountRef)
			}
			if cachedErr != nil {
				return fmt.Errorf("读取 Server 账号额度失败: %w", cachedErr)
			}
			result = cached
			err = nil
			// 快照本身是新鲜的（刷新其实已落库，只是响应失败/被 single-flight 合并）时
			// 不打扰用户；只有缓存确实过期才提示。
			if cached.Stale() {
				_, _ = fmt.Fprintln(runtime.stderr, "[aih] 额度刷新失败，显示缓存快照")
			}
		}
	} else {
		result, err = client.GetUsage(ctx, accountRef)
	}
	if err != nil {
		return fmt.Errorf("读取 Server 账号额度失败: %w", err)
	}
	writeAccountUsageResult(runtime.stdout, result)
	if document, documentErr := client.GetUsageDocument(ctx, accountRef); documentErr == nil {
		writeUsageDocumentDetails(runtime.stdout, document)
	}
	return nil
}

// runProviderUsageAll 打印该 Provider 全部账号的额度摘要（Node usage 无 id 形态）：
// 每行一个账号，下列出非聚合额度条目；--refresh 逐账号刷新。
func runProviderUsageAll(
	ctx context.Context,
	providerID string,
	refresh bool,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	accounts, err := listProviderAccounts(ctx, client, providerID)
	if err != nil {
		return err
	}
	states, _ := client.ListAccountUIStates(ctx)
	displayNames := make(map[string]string, len(states))
	for _, state := range states {
		displayNames[state.AccountRef] = state.DisplayName
	}
	_, _ = fmt.Fprintf(runtime.stdout, "%s usage（%d 个账号）:\n", providerID, len(accounts))
	if len(accounts) == 0 {
		return nil
	}
	for _, account := range accounts {
		var result managementapi.UsageResult
		if refresh {
			result, err = client.RefreshUsage(ctx, account.AccountRef)
		} else {
			result, err = client.GetUsage(ctx, account.AccountRef)
		}
		if err != nil {
			// 与单账号刷新一致：失败时退回缓存快照并标注。
			if cached, cachedErr := client.GetUsage(ctx, account.AccountRef); cachedErr == nil {
				writeAccountUsageSummary(
					runtime.stdout,
					account,
					displayNames[account.AccountRef.String()],
					cached,
				)
				if cached.Stale() {
					_, _ = fmt.Fprintf(runtime.stdout, "      （刷新失败，显示缓存快照）\n")
				}
				err = nil
				continue
			}
			_, _ = fmt.Fprintf(
				runtime.stdout,
				"  #%d  读取失败: %v\n",
				account.CLIAccountID.Int64(),
				err,
			)
			err = nil
			continue
		}
		writeAccountUsageSummary(runtime.stdout, account, displayNames[account.AccountRef.String()], result)
	}
	return nil
}

// writeAccountUsageSummary 输出单账号的紧凑摘要。
func writeAccountUsageSummary(
	output io.Writer,
	account managementapi.AccountView,
	stateDisplayName string,
	result managementapi.UsageResult,
) {
	snapshot := result.Snapshot()
	identity := strings.TrimSpace(account.DisplayName)
	if identity == "" {
		identity = strings.TrimSpace(stateDisplayName)
	}
	if identity == "" {
		identity = strings.TrimSpace(account.Email)
	}
	if identity == "" {
		identity = "未命名"
	}
	plan := snapshot.PlanType()
	planLabel := ""
	if plan != "" {
		planLabel = "[" + titleCase(plan) + "] "
	}
	remaining := "Unknown"
	if min := snapshot.MinRemaining(); min.Known {
		remaining = fmt.Sprintf("%.1f%%", float64(min.BasisPoints)/100)
	}
	status := ""
	if !account.Enabled {
		status = " [停用]"
	}
	_, _ = fmt.Fprintf(
		output,
		"  #%d  %s%s  剩余 %s%s\n",
		account.CLIAccountID.Int64(),
		planLabel,
		identity,
		remaining,
		status,
	)
	for _, entry := range snapshot.Entries() {
		bucket := entry.Bucket()
		if bucket == "" {
			bucket = entry.LimitID()
		}
		if bucket == "" || strings.EqualFold(bucket, "credits") {
			continue
		}
		_, _ = fmt.Fprintf(
			output,
			"      %s  剩余 %s\n",
			bucket,
			accountUsageRemainingLabel(entry),
		)
	}
}

// writeUsageDocumentDetails 打印完整快照里的明细条目；聚合 credits 已在表里出现过。
func writeUsageDocumentDetails(output io.Writer, document managementapi.UsageDocument) {
	var payload struct {
		Entries []struct {
			Bucket         string   `json:"bucket"`
			RemainingPct   *float64 `json:"remainingPct"`
			TotalUnits     *float64 `json:"totalUnits"`
			RemainingUnits *float64 `json:"remainingUnits"`
			UnitType       string   `json:"unitType"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(document.Payload, &payload); err != nil || len(payload.Entries) == 0 {
		return
	}
	printed := false
	for _, entry := range payload.Entries {
		if entry.Bucket == "" || entry.Bucket == "credits" {
			continue
		}
		if !printed {
			_, _ = fmt.Fprintln(output, "明细:")
			printed = true
		}
		unit := entry.UnitType
		if unit == "" {
			unit = "credits"
		}
		_, _ = fmt.Fprintf(
			output,
			"  - %s: %s/%s %s remaining%s\n",
			entry.Bucket,
			formatUsageUnit(entry.RemainingUnits),
			formatUsageUnit(entry.TotalUnits),
			unit,
			formatUsagePct(entry.RemainingPct),
		)
	}
}

func formatUsageUnit(value *float64) string {
	if value == nil {
		return "unknown"
	}
	return strconv.FormatFloat(*value, 'f', -1, 64)
}

func formatUsagePct(value *float64) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf(" (%.2f%%)", *value)
}

func writeProviderUsageUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "用法:\\n  aih %s usage <id> [--refresh]\\n", providerID)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  --refresh  让 Go Server 立即重探该账号额度")
}
