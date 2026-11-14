package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const lsRotationStep = 1500 * time.Millisecond

var lsSGRPattern = regexp.MustCompile("\\x1b\\[[0-9;]*m")

// lsRow 是一屏幕行；render 接收 4 列活动前缀。
type lsRow struct {
	kind     string
	provider string
	account  *lsAccount
	text     string
	render   func(prefix string) string
}

func buildLSRows(
	data *lsData,
	query string,
	palette terminalPalette,
	tty bool,
	rotationStart time.Time,
	now time.Time,
) []lsRow {
	counts := data.ProviderCounts
	if counts == nil {
		counts = make(map[string]int)
		for _, account := range data.Accounts {
			counts[account.Account.Provider]++
		}
	}
	providerIDs := lsProviderIDsWithCounts(data.ProviderOrder, counts, data.ProviderScope)
	rows := make([]lsRow, 0, len(data.Accounts)+len(providerIDs)*2+3)
	if len(providerIDs) == 0 {
		rows = append(rows, lsRow{
			kind:   "notice",
			render: func(string) string { return "  No profiles found." },
		})
		return rows
	}

	scopeLabel := ""
	if len(data.ProviderScope) > 1 {
		scopeLabel = palette.gray(" · " + strings.Join(lsScopeNames(data.ProviderScope, data.ProviderScopeOrder), ", "))
	}
	rows = append(rows,
		lsRow{kind: "spacer", render: func(string) string { return "" }},
		lsRow{kind: "title", render: func(string) string {
			return palette.cyan("📦 AI Home Accounts Overview") + scopeLabel
		}},
		lsRow{kind: "spacer", render: func(string) string { return "" }},
	)

	byProvider := make(map[string][]*lsAccount)
	for _, account := range data.Accounts {
		byProvider[account.Account.Provider] = append(byProvider[account.Account.Provider], account)
	}
	for _, provider := range providerIDs {
		providerName := provider
		rows = append(rows, lsRow{
			kind:     "provider",
			provider: providerName,
			text:     strings.ToLower(providerName),
			render: func(string) string {
				return palette.yellow("▶ " + providerName)
			},
		})
		group := byProvider[providerName]
		if len(group) == 0 {
			rows = append(rows, lsRow{
				kind:     "empty",
				provider: providerName,
				text:     strings.ToLower(providerName),
				render:   func(string) string { return "  (Empty)" },
			})
			continue
		}
		for _, account := range group {
			if account.Hidden {
				continue
			}
			current := account
			rows = append(rows, lsRow{
				kind:     "account",
				provider: providerName,
				account:  current,
				text:     strings.ToLower(providerName + " " + stripLSAnsi(formatLSAccountRow(current, "", false, 0, palette, rotationStart, now))),
				render: func(prefix string) string {
					return formatLSAccountRow(current, prefix, tty, lsRotationFor(current, rotationStart, now), palette, rotationStart, now)
				},
			})
		}
	}
	return filterLSRows(rows, query)
}

func lsProviderIDsWithCounts(order []string, counts map[string]int, scope map[string]bool) []string {
	set := make(map[string]bool)
	for provider, count := range counts {
		if count > 0 {
			set[provider] = true
		}
	}
	result := make([]string, 0, len(set))
	seen := make(map[string]bool)
	for _, provider := range order {
		if set[provider] && !seen[provider] {
			result = append(result, provider)
			seen[provider] = true
		}
	}
	extra := make([]string, 0)
	for provider := range set {
		if !seen[provider] {
			extra = append(extra, provider)
		}
	}
	sort.Strings(extra)
	return append(result, extra...)
}

func lsScopeNames(scope map[string]bool, order []string) []string {
	names := make([]string, 0, len(scope))
	seen := make(map[string]bool)
	for _, provider := range order {
		if scope[provider] && !seen[provider] {
			names = append(names, provider)
			seen[provider] = true
		}
	}
	extra := make([]string, 0)
	for provider := range scope {
		if !seen[provider] {
			extra = append(extra, provider)
		}
	}
	sort.Strings(extra)
	return append(names, extra...)
}

func filterLSRows(rows []lsRow, query string) []lsRow {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return rows
	}
	head := make([]lsRow, 0)
	blocks := make([][]lsRow, 0)
	var current []lsRow
	for _, row := range rows {
		if row.kind == "provider" {
			current = []lsRow{row}
			blocks = append(blocks, current)
			continue
		}
		if current != nil {
			current = append(current, row)
			blocks[len(blocks)-1] = current
		} else {
			head = append(head, row)
		}
	}
	kept := make([]lsRow, 0)
	for _, block := range blocks {
		header := block[0]
		children := block[1:]
		hits := make([]lsRow, 0, len(children))
		for _, child := range children {
			if strings.Contains(child.text, needle) {
				hits = append(hits, child)
			}
		}
		if len(hits) == 0 {
			continue
		}
		kept = append(kept, header)
		kept = append(kept, hits...)
	}
	if len(kept) == 0 {
		return []lsRow{{
			kind: "notice",
			render: func(string) string {
				return fmt.Sprintf("  No accounts match \"%s\".", query)
			},
		}}
	}
	return append(head, kept...)
}

func formatLSAccountRow(
	account *lsAccount,
	prefix string,
	tty bool,
	rotation int,
	palette terminalPalette,
	rotationStart time.Time,
	now time.Time,
) string {
	planPrefix := ""
	if account.PlanLabel != "" {
		planPrefix = palette.blue("["+account.PlanLabel+"]") + " "
	}
	badges := make([]string, 0, 4)
	if account.Account.IsDefault {
		badges = append(badges, palette.paint(ansiGreen, "[★ Default]"))
	}
	if account.IsMobile {
		badges = append(badges, palette.magenta("[📱 Mobile]"))
	}
	if !account.Account.Enabled {
		badges = append(badges, palette.gray("[关闭]"))
	} else if account.RuntimeBlocked {
		if account.Runtime.normalized() == "auth_invalid" {
			badges = append(badges, palette.paint(ansiRed, "[认证失效]"))
		} else {
			badges = append(badges, palette.paint(ansiRed, "[运行态不可用]"))
		}
	} else if !account.Configured {
		badges = append(badges, palette.gray("[待登录]"))
	}
	if !account.RuntimeBlocked && !account.APIKeyMode && account.QuotaStatus == "exhausted" {
		badges = append(badges, palette.paint(ansiRed, "[额度已耗尽]"))
	}
	if account.Configured && !account.APIKeyMode && len(account.Throttle) > 0 {
		if tty && len(account.Throttle) > 1 {
			badges = append(badges, palette.paint(ansiYellow, account.Throttle[rotation%len(account.Throttle)]))
		} else {
			for _, badge := range account.Throttle {
				badges = append(badges, palette.paint(ansiYellow, badge))
			}
		}
	}
	badgeText := ""
	if len(badges) > 0 {
		badgeText = "  " + strings.Join(badges, " ")
	}

	identity := ""
	if account.Configured && len(account.IdentityVariants) > 0 {
		if tty {
			identity = account.IdentityVariants[rotation%len(account.IdentityVariants)]
		} else {
			identity = strings.Join(account.IdentityVariants, " / ")
		}
	}
	identityText := ""
	if identity != "" {
		identityText = palette.magenta("(" + identity + ")")
	}

	line := prefix + planPrefix + "Account ID: " + palette.cyan(strconv.FormatInt(account.Account.CLIAccountID, 10)) + badgeText + " " + identityText + " " + lsUsageLabel(account, tty, rotation, palette)
	if account.DuplicateOf > 0 {
		line += palette.paint(ansiRed, fmt.Sprintf(" [⚠️ Duplicate of ID %d]", account.DuplicateOf))
	}
	return strings.TrimRight(line, " ")
}

func lsUsageLabel(account *lsAccount, tty bool, rotation int, palette terminalPalette) string {
	if account.APIKeyMode {
		if strings.EqualFold(account.Account.Provider, "opencode") && account.BaseURL == "" {
			return palette.gray("[Remaining: Unknown]")
		}
		if account.BaseURL != "" {
			return palette.gray("[Base URL: " + account.BaseURL + "]")
		}
		return palette.gray("[Remaining: API Key mode]")
	}
	if !account.Configured {
		return palette.gray("[Remaining: Unconfigured (login required)]")
	}
	if account.RuntimeBlocked {
		status := account.Runtime.normalized()
		if status == "auth_invalid" || status == "rate_limited" {
			return ""
		}
		return palette.paint(ansiRed, "[Runtime: "+lsRuntimeText(account.Runtime)+"]")
	}
	if tty && len(account.UsageVariants) > 0 {
		return palette.cyan("[Remaining: " + account.UsageVariants[rotation%len(account.UsageVariants)] + "]")
	}
	if account.UsageLabel != "" {
		return palette.cyan("[Remaining: " + account.UsageLabel + "]")
	}
	if len(account.UsageVariants) > 0 {
		return palette.cyan("[Remaining: " + account.UsageVariants[0] + "]")
	}
	if account.RemainingPct != nil {
		return palette.cyan(fmt.Sprintf("[Remaining: %.1f%%]", *account.RemainingPct))
	}
	return palette.gray("[Remaining: Unknown]")
}

func lsRuntimeText(status lsRuntimeStatus) string {
	switch status.normalized() {
	case "auth_invalid":
		return "auth expired"
	case "rate_limited":
		return "rate limited"
	case "overloaded":
		return "overloaded"
	case "transient_network":
		return "network cooling down"
	case "service_unavailable":
		return "service unavailable"
	case "upstream_error":
		return "upstream error"
	case "cooling_down":
		return "cooling down"
	default:
		if status.normalized() == "" {
			return "runtime unavailable"
		}
		return status.normalized()
	}
}

func lsRotationFor(account *lsAccount, start time.Time, now time.Time) int {
	if account.rotationSlot < 0 || account.rotatingCount < 1 {
		return 0
	}
	step := int(now.Sub(start) / lsRotationStep)
	if step <= account.rotationSlot {
		return 0
	}
	return 1 + (step-1-account.rotationSlot)/account.rotatingCount
}

func stripLSAnsi(value string) string {
	return lsSGRPattern.ReplaceAllString(value, "")
}
