package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// runProviderDelete 删除一个或多个家族账号：选择器支持 1 / 1,2,3 / 1-9，
// deleteall 删除该 Provider 全部账号。删除由 Go Server 承担（含从属状态）。
func runProviderDelete(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 {
		return fmt.Errorf(
			"用法 aih %s delete <id[,id...|start-end]...> 或 aih %s deleteall",
			providerID,
			providerID,
		)
	}
	deleteAll := false
	switch strings.ToLower(strings.TrimSpace(arguments[0])) {
	case "deleteall", "delete-all":
		if len(arguments) != 1 {
			return fmt.Errorf("用法 aih %s deleteall", providerID)
		}
		deleteAll = true
	}
	var targetIDs []int64
	if !deleteAll {
		parsed, err := parseDeleteSelectors(arguments)
		if err != nil {
			return err
		}
		targetIDs = parsed
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	views, err := listProviderAccounts(ctx, client, providerID)
	if err != nil {
		return err
	}
	if deleteAll {
		deleted := make([]string, 0, len(views))
		for _, view := range views {
			if err := client.DeleteAccount(ctx, view.AccountRef); err != nil {
				return fmt.Errorf("删除账号 #%d 失败: %w", view.CLIAccountID.Int64(), err)
			}
			deleted = append(deleted, strconv.FormatInt(view.CLIAccountID.Int64(), 10))
		}
		_, _ = fmt.Fprintf(
			runtime.stdout,
			"[aih] deleted %d/%d %s account(s).\n",
			len(deleted),
			len(views),
			providerID,
		)
		writeDeletedIDs(runtime.stdout, deleted)
		return nil
	}
	byID := make(map[int64]accountcore.AccountRef, len(views))
	for _, view := range views {
		byID[view.CLIAccountID.Int64()] = view.AccountRef
	}
	deleted := make([]string, 0, len(targetIDs))
	missing := make([]string, 0)
	for _, id := range targetIDs {
		accountRef, ok := byID[id]
		if !ok {
			missing = append(missing, strconv.FormatInt(id, 10))
			continue
		}
		if err := client.DeleteAccount(ctx, accountRef); err != nil {
			return fmt.Errorf("删除账号 #%d 失败: %w", id, err)
		}
		deleted = append(deleted, strconv.FormatInt(id, 10))
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] deleted %d %s account(s).\n", len(deleted), providerID)
	writeDeletedIDs(runtime.stdout, deleted)
	if len(missing) > 0 {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] missing: %s\n", strings.Join(missing, ", "))
	}
	return nil
}

// writeDeletedIDs 与 Node 一致：列出实际删除的别名。
func writeDeletedIDs(output io.Writer, ids []string) {
	if len(ids) == 0 {
		return
	}
	_, _ = fmt.Fprintf(output, "  - %s\n", strings.Join(ids, ", "))
}

// parseDeleteSelectors 展开 1 / 1,2,3 / 1-9，保持输入顺序并去重。
func parseDeleteSelectors(arguments []string) ([]int64, error) {
	seen := make(map[int64]bool)
	ids := make([]int64, 0, len(arguments))
	for _, argument := range arguments {
		for _, token := range strings.Split(argument, ",") {
			text := strings.TrimSpace(token)
			if text == "" {
				return nil, fmt.Errorf("Invalid delete selector. Use IDs like 1,2,3 or ranges like 1-9.")
			}
			if startText, endText, found := strings.Cut(text, "-"); found {
				start, startErr := strconv.ParseInt(startText, 10, 64)
				end, endErr := strconv.ParseInt(endText, 10, 64)
				if startErr != nil || endErr != nil || start <= 0 || end < start || end-start > 1000 {
					return nil, fmt.Errorf("Invalid delete selector. Use IDs like 1,2,3 or ranges like 1-9.")
				}
				for id := start; id <= end; id++ {
					if !seen[id] {
						seen[id] = true
						ids = append(ids, id)
					}
				}
				continue
			}
			id, err := strconv.ParseInt(text, 10, 64)
			if err != nil || id <= 0 {
				return nil, fmt.Errorf("Invalid delete selector. Use IDs like 1,2,3 or ranges like 1-9.")
			}
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("No valid account IDs provided.")
	}
	return ids, nil
}
