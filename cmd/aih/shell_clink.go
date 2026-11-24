package main

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/clinksetup"
)

func isClinkShell(shell string) bool {
	switch strings.ToLower(strings.TrimSpace(shell)) {
	case "cmd", "clink":
		return true
	}
	return false
}

func runClinkShell(action string, options shellOptions, runtime commandRuntime) error {
	env := func(name string) string {
		value, _ := runtime.lookupEnv(name)
		return value
	}
	aihBin := resolveShellAihBinPath(runtime)
	switch action {
	case "status":
		status := clinksetup.GetStatus(aihBin, env)
		if options.json {
			return writeShellJSON(runtime, status)
		}
		if !status.Available {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] Clink 未安装。cmd 原生不支持参数补全，安装 Clink 后重试：https://chrisant996.github.io/clink/")
			return cliExitCode{code: 1}
		}
		state := "已安装"
		if !status.Installed {
			state = "未安装"
		} else if status.UpToDate {
			state = "已安装 / 已是最新"
		} else {
			state = "已安装 / 需要更新"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "Clink 补全\n  Clink    %s (%s)\n  脚本     %s\n  状态     %s\n", status.Version, status.Exe, status.ScriptPath, state)
		return nil

	case "snippet":
		_, _ = fmt.Fprint(runtime.stdout, clinksetup.LuaScript(aihBin))
		return nil

	case "plan":
		status := clinksetup.GetStatus(aihBin, env)
		if options.json {
			return writeShellJSON(runtime, status)
		}
		if !status.Available {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] 未找到 Clink；请先安装 Clink。")
			return cliExitCode{code: 1}
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] Clink %s\n将写入：%s\n", status.Version, status.ScriptPath)
		if options.dryRun {
			_, _ = fmt.Fprintln(runtime.stdout, "\n"+clinksetup.LuaScript(aihBin))
			_, _ = fmt.Fprintln(runtime.stdout, "\n[aih]（dry-run：没有写入任何文件）")
		}
		return nil

	case "apply":
		if options.dryRun {
			status := clinksetup.GetStatus(aihBin, env)
			if !status.Available {
				_, _ = fmt.Fprintln(runtime.stdout, "[aih] 未找到 Clink；请先安装 Clink。")
				return cliExitCode{code: 1}
			}
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] 将写入：%s\n", status.ScriptPath)
			_, _ = fmt.Fprintln(runtime.stdout, "\n[aih]（dry-run：没有写入任何文件）")
			return nil
		}
		path, changed, info, err := clinksetup.Apply(aihBin, env)
		if err != nil {
			if err == clinksetup.ErrNotAvailable {
				_, _ = fmt.Fprintln(runtime.stderr, "[aih] 未找到 Clink。cmd 原生不支持参数补全；请先安装 Clink：https://chrisant996.github.io/clink/")
				return cliExitCode{code: 1}
			}
			return err
		}
		if options.json {
			return writeShellJSON(runtime, map[string]any{
				"ok": true, "shell": "cmd", "changed": changed, "path": path,
				"clinkVersion": info.Version, "clinkExe": info.Exe,
			})
		}
		if !changed {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] Clink 补全已是最新：%s\n", path)
		} else {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] Clink 补全已写入：%s\n", path)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "Clink：%s (%s)\n生效：新开一个由 Clink 启动的 cmd 窗口\n", info.Version, info.Exe)
		return nil

	case "remove":
		path, removed, err := clinksetup.Remove(env)
		if err != nil {
			return err
		}
		if options.json {
			return writeShellJSON(runtime, map[string]any{"ok": true, "removed": removed, "path": path})
		}
		if removed {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已移除 Clink 补全：%s\n", path)
		} else {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] Clink 补全本来就不存在：%s\n", path)
		}
		return nil

	case "doctor":
		status := clinksetup.GetStatus(aihBin, env)
		checks := []map[string]any{
			{"name": "Clink 已安装", "ok": status.Available, "detail": status.Exe},
			{"name": "aih 路径可用", "ok": clinksetup.ExecutableAvailable(aihBin), "detail": aihBin},
			{"name": "补全脚本已安装", "ok": status.Installed, "detail": status.ScriptPath},
			{"name": "补全脚本最新", "ok": status.UpToDate, "detail": status.Reason},
		}
		ok := true
		for _, check := range checks {
			if value, _ := check["ok"].(bool); !value {
				ok = false
			}
		}
		if options.json {
			return writeShellJSON(runtime, map[string]any{"ok": ok, "shell": "cmd", "checks": checks})
		}
		_, _ = fmt.Fprintln(runtime.stdout, "AIH Clink Doctor")
		for _, check := range checks {
			value, _ := check["ok"].(bool)
			mark := "✔"
			if !value {
				mark = "✘"
			}
			detail, _ := check["detail"].(string)
			_, _ = fmt.Fprintf(runtime.stdout, "  %s %s  %s\n", mark, check["name"], detail)
		}
		if ok {
			_, _ = fmt.Fprintln(runtime.stdout, "全部通过。")
			return nil
		}
		_, _ = fmt.Fprintln(runtime.stdout, "有未通过的检查项，见上。")
		return cliExitCode{code: 1}
	}
	return cliExitCode{code: 1}
}
