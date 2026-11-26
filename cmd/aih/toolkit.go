package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
)

func runToolkit(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 0 || arguments[0] == "-h" || arguments[0] == "--help" {
		writeToolkitUsage(runtime)
		return nil
	}
	switch arguments[0] {
	case "cleanup-residue":
		return runToolkitCleanupResidue(ctx, arguments[1:], runtime)
	default:
		return fmt.Errorf("%w: 未知 toolkit 子命令 %q（用法: aih toolkit cleanup-residue [--provider <id>]）", errInvalidCommand, arguments[0])
	}
}

func runToolkitCleanupResidue(ctx context.Context, arguments []string, runtime commandRuntime) error {
	var provider string
	var asJSON bool
	for i := 0; i < len(arguments); i++ {
		arg := arguments[i]
		switch {
		case arg == "-h" || arg == "--help":
			writeToolkitUsage(runtime)
			return nil
		case arg == "--json":
			asJSON = true
		case arg == "--provider":
			if i+1 >= len(arguments) {
				return fmt.Errorf("%w: --provider 需要参数值", errInvalidCommand)
			}
			i++
			provider = strings.TrimSpace(arguments[i])
		case strings.HasPrefix(arg, "--provider="):
			provider = strings.TrimSpace(strings.TrimPrefix(arg, "--provider="))
		default:
			return fmt.Errorf("%w: cleanup-residue 不支持参数 %q", errInvalidCommand, arg)
		}
	}

	hostHome := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHome == "" {
		if h, err := runtime.userHomeDir(); err == nil {
			hostHome = h
		}
	}
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		if key, value, ok := strings.Cut(entry, "="); ok {
			env[key] = value
		}
	}

	res := apps.CleanupShortcutResidue(ctx, provider, apps.Options{
		HostHomeDir: hostHome,
		Env:         env,
	})
	if asJSON {
		enc := json.NewEncoder(runtime.stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(res)
		if !res.OK {
			return fmt.Errorf("%s", nonEmptyToolkitError(res))
		}
		return nil
	}
	if !res.OK {
		return fmt.Errorf("%s", nonEmptyToolkitError(res))
	}
	if len(res.Removed) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] 未发现需要清理的残留快捷方式。")
	} else {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已清理 %d 个残留快捷方式:\n", len(res.Removed))
		for _, p := range res.Removed {
			_, _ = fmt.Fprintf(runtime.stdout, "  - %s\n", p)
		}
	}
	if len(res.KeptBroken) > 0 {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 保留 %d 个无关断链（未删除）:\n", len(res.KeptBroken))
		for _, p := range res.KeptBroken {
			_, _ = fmt.Fprintf(runtime.stdout, "  - %s\n", p)
		}
	}
	for _, w := range res.Warnings {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] warning: %s\n", w)
	}
	return nil
}

func nonEmptyToolkitError(res apps.ShortcutCleanupResult) string {
	if strings.TrimSpace(res.Message) != "" {
		return res.Message
	}
	if strings.TrimSpace(res.Error) != "" {
		return res.Error
	}
	return "shortcut_cleanup_failed"
}

func writeToolkitUsage(runtime commandRuntime) {
	_, _ = fmt.Fprint(runtime.stdout, `用法: aih toolkit cleanup-residue [--provider <id>] [--json]

清理 Windows 开始菜单/桌面中已卸载应用的残留 .lnk 快捷方式（仅匹配受管应用，保留无关断链）。
  --provider <id>  仅清理指定 provider（如 agy）；省略时对所有已知 provider 执行
  --json           以 JSON 输出结果
`)
}
