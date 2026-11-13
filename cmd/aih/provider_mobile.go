package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// codexDesktopHookStatePath 是 Codex App 账号绑定的唯一真值文件。
func codexDesktopHookStatePath(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), "run", "codex", "desktop-hook-state.json")
}

// readCodexDesktopAccountRef 读取当前绑定；缺失/损坏返回空串。
func readCodexDesktopAccountRef(aiHomeDir string) string {
	raw, err := os.ReadFile(codexDesktopHookStatePath(aiHomeDir))
	if err != nil {
		return ""
	}
	var state struct {
		DesktopAccountRef string "json:\"desktopAccountRef\""
	}
	if json.Unmarshal(raw, &state) != nil {
		return ""
	}
	return strings.TrimSpace(state.DesktopAccountRef)
}

// runProviderMobile 实现 aih codex set-mobile <id> / unset-mobile。
// 状态由 Go Server 写入 desktop-hook-state.json；桌面端重启仍由 Node 启动器负责，
// 因此这里明确提示「重启 Codex App 后生效」。
func runProviderMobile(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	verb := arguments[0]
	if providerID != "codex" {
		return fmt.Errorf(
			"%w: %s is only supported for codex. Usage: aih codex %s",
			errInvalidCommand, verb, verb,
		)
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	switch verb {
	case "set-mobile":
		if len(arguments) != 2 {
			return fmt.Errorf("%w: Invalid ID. Usage: aih codex set-mobile <id>", errInvalidCommand)
		}
		id, parseErr := strconv.ParseInt(strings.TrimSpace(arguments[1]), 10, 64)
		if parseErr != nil || id <= 0 {
			return fmt.Errorf("%w: Invalid ID. Usage: aih codex set-mobile <id>", errInvalidCommand)
		}
		view, viewErr := resolveProviderAccountView(ctx, "codex", arguments[1], runtime)
		if viewErr != nil {
			return viewErr
		}
		result, bindErr := client.SetMobile(ctx, "codex", view.AccountRef.String())
		if bindErr != nil {
			return fmt.Errorf("设置 Codex App 账号失败: %w", bindErr)
		}
		_, _ = fmt.Fprintf(
			runtime.stdout,
			"[Success] Set Codex Account ID %d as Codex App account.\\n",
			id,
		)
		if result.Changed {
			_, _ = fmt.Fprintln(runtime.stdout, "重启 Codex App 后生效。")
		}
		return nil
	case "unset-mobile":
		if len(arguments) != 1 {
			return fmt.Errorf("%w: Invalid arg. Usage: aih codex unset-mobile", errInvalidCommand)
		}
		current := readCodexDesktopAccountRef(aiHomeDir)
		if current == "" {
			_, _ = fmt.Fprintln(runtime.stdout, "[Success] Cleared Codex App account.")
			return nil
		}
		if _, bindErr := client.ClearMobile(ctx, "codex", current); bindErr != nil {
			return fmt.Errorf("清除 Codex App 账号失败: %w", bindErr)
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[Success] Cleared Codex App account.")
		return nil
	default:
		return fmt.Errorf("%w: 未知 mobile 动作 %s", errInvalidCommand, verb)
	}
}
