package main

import (
	"context"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// runGlobalAccountList 实现 aih ls [id] [--scope <provider...>]：一次拉全量账号，
// 按 manifest 顺序分组输出。只做只读投影，额度来自 Server 缓存。
func runGlobalAccountList(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	filterID := int64(0)
	scopePatterns := make([]string, 0)
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		switch {
		case token == "":
			continue
		case isRootHelp(token):
			writeGlobalAccountListUsage(runtime.stdout)
			return nil
		case token == "--scope":
			for index+1 < len(arguments) {
				next := strings.TrimSpace(arguments[index+1])
				if next == "" || strings.HasPrefix(next, "-") {
					break
				}
				scopePatterns = append(scopePatterns, next)
				index++
			}
			if len(scopePatterns) == 0 {
				return fmt.Errorf("%w: --scope needs at least one provider", errInvalidCommand)
			}
		default:
			value, err := strconv.ParseInt(token, 10, 64)
			if err != nil || value <= 0 || filterID != 0 {
				writeGlobalAccountListUsage(runtime.stderr)
				return fmt.Errorf("%w: 用法 aih ls [id] [--scope <provider...>]", errInvalidCommand)
			}
			filterID = value
		}
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return err
	}
	scope := map[string]bool{}
	if len(scopePatterns) > 0 {
		matched := matchProviderScope(catalog, scopePatterns)
		if len(matched) == 0 {
			return fmt.Errorf("%w: --scope 没有匹配到 Provider：%s", errInvalidCommand, strings.Join(scopePatterns, " "))
		}
		for _, providerID := range matched {
			scope[providerID] = true
		}
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
			if filterID != 0 && account.CLIAccountID.Int64() != filterID {
				continue
			}
			if len(scope) > 0 && !scope[account.ProviderID] {
				continue
			}
			accounts = append(accounts, account)
		}
		if !result.HasMore || result.NextAfterRef == "" {
			break
		}
		afterRef = result.NextAfterRef
	}
	writeGlobalAccountList(runtime.stdout, catalog, accounts, displayNames, client, ctx)
	return nil
}

// matchProviderScope 支持精确名、通配符与子串（与 Node matchProviderSelector 同序）。
func matchProviderScope(catalog *providers.Catalog, patterns []string) []string {
	definitions := catalog.List()
	matched := make(map[string]bool)
	for _, pattern := range patterns {
		text := strings.ToLower(strings.TrimSpace(pattern))
		if text == "" {
			continue
		}
		if catalog.Contains(text) {
			matched[text] = true
			continue
		}
		for _, definition := range definitions {
			id := strings.ToLower(definition.ID)
			if strings.ContainsAny(text, "*?") {
				if ok, _ := path.Match(text, id); ok {
					matched[id] = true
				}
				continue
			}
			if strings.Contains(id, text) {
				matched[id] = true
			}
		}
	}
	ordered := make([]string, 0, len(matched))
	for _, definition := range definitions {
		if matched[definition.ID] {
			ordered = append(ordered, definition.ID)
		}
	}
	return ordered
}

// writeGlobalAccountList 按 manifest 顺序输出有账号的 Provider 分组。
func writeGlobalAccountList(
	output io.Writer,
	catalog *providers.Catalog,
	accounts []managementapi.AccountView,
	displayNames map[string]string,
	client *managementapi.Client,
	ctx context.Context,
) {
	byProvider := make(map[string][]managementapi.AccountView)
	for _, account := range accounts {
		byProvider[account.ProviderID] = append(byProvider[account.ProviderID], account)
	}
	palette := paletteFor(output)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, palette.cyan("📦 AI Home Accounts Overview"))
	if len(accounts) == 0 {
		_, _ = fmt.Fprintln(output, "  No profiles found.")
		return
	}
	providerIDs := make([]string, 0, len(byProvider))
	for providerID := range byProvider {
		providerIDs = append(providerIDs, providerID)
	}
	// manifest 顺序优先，未知 Provider（插件账号）按字母序排在后面。
	order := make(map[string]int)
	for index, definition := range catalog.List() {
		order[definition.ID] = index
	}
	sort.SliceStable(providerIDs, func(left, right int) bool {
		leftOrder, leftKnown := order[providerIDs[left]]
		rightOrder, rightKnown := order[providerIDs[right]]
		if leftKnown != rightKnown {
			return leftKnown
		}
		if leftKnown {
			return leftOrder < rightOrder
		}
		return providerIDs[left] < providerIDs[right]
	})
	for _, providerID := range providerIDs {
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintf(output, "%s\n", palette.yellow("▶ "+providerID))
		group := byProvider[providerID]
		sort.SliceStable(group, func(left, right int) bool {
			return group[left].CLIAccountID.Int64() < group[right].CLIAccountID.Int64()
		})
		for _, account := range group {
			writeAccountListRow(output, account, displayNames, client, ctx, palette)
		}
	}
}

func writeGlobalAccountListUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih ls [id] [--scope <provider...>]")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  账号与额度来自 Go Management API；--scope 支持精确名/子串/通配符。")
}
