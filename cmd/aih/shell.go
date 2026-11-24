package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/shellsetup"
)

const shellHelp = `用法：
  aih shell status  [--json]
  aih shell plan    [选项]
  aih shell apply   [选项] [--dry-run] [--all]
  aih shell remove  [选项] [--all]
  aih shell snippet [选项]
  aih shell doctor  [--json]
  aih shell typo    [list|forget <打错的命令>] [--json]

作用：
  TAB 补全    aih <TAB> 列命令；aih co<TAB> → codex；aih codex <TAB> 列该 CLI 的动作与账号；
              并给出你自己用过的那几条命令（来自 shell 的活历史）
  拼写纠正    命令打错时（如 ahi）列出最接近的候选，确认后才运行；e = 放到命令行自己编辑
  自学习      你确认过的纠正会被记住，下次同一个错法排第一

支持的 shell：zsh / bash / fish / PowerShell（PS 5.1 与 7.x）/ sh
  sh：/bin/sh 是 bash/zsh 时自动复用原生补全；dash/ash 没有编程补全接口，提供 aih_complete 手动查询

选项：
  --shell <zsh|bash|fish|powershell>  目标 shell（默认按「父进程 → PSModulePath → $SHELL」判断）
  --rc-file <路径>       写到指定文件而不是默认 rc
  --all                  对每个「已安装或已有 rc」的 shell 都执行一次
  --completion           开启 TAB 补全（恢复之前关闭的功能）
  --typo                 开启纠错建议
  --wrapper              开启 aih 包装函数
  --no-completion        不装 TAB 补全
  --no-typo              不装命令打错的纠正建议
  --no-wrapper           不给 aih 加同名 shell 函数（少了 aih 自身错字的纠正入口）
  --dry-run              apply 时只打印将要写入的内容
  --json                 以 JSON 输出

装完要生效：新开终端，或 source 对应 rc（fish：exec fish）。移除：aih shell remove。`

type shellOptions struct {
	positional []string
	shell      string
	shellSet   bool
	rcFile     string
	rcFileSet  bool
	all        bool
	completion *bool
	typo       *bool
	wrapper    *bool
	dryRun     bool
	json       bool
	list       bool
	forget     string
	help       bool
	parseError string
}

func boolPointer(value bool) *bool { return &value }

func parseShellArgs(arguments []string) shellOptions {
	options := shellOptions{}
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		next := func() string {
			if index+1 >= len(arguments) || strings.HasPrefix(arguments[index+1], "-") {
				if options.parseError == "" {
					options.parseError = "missing_value:" + argument
				}
				return ""
			}
			index++
			return arguments[index]
		}
		switch {
		case argument == "--shell":
			options.shell = strings.ToLower(strings.TrimSpace(next()))
			options.shellSet = true
		case strings.HasPrefix(argument, "--shell="):
			options.shell = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(argument, "--shell=")))
			options.shellSet = true
		case argument == "--rc-file":
			options.rcFile = next()
			options.rcFileSet = true
		case strings.HasPrefix(argument, "--rc-file="):
			options.rcFile = strings.TrimPrefix(argument, "--rc-file=")
			options.rcFileSet = true
		case argument == "--all":
			options.all = true
		case argument == "--completion":
			options.completion = boolPointer(true)
		case argument == "--typo":
			options.typo = boolPointer(true)
		case argument == "--wrapper":
			options.wrapper = boolPointer(true)
		case argument == "--no-completion":
			options.completion = boolPointer(false)
		case argument == "--no-typo":
			options.typo = boolPointer(false)
		case argument == "--no-wrapper":
			options.wrapper = boolPointer(false)
		case argument == "--dry-run":
			options.dryRun = true
		case argument == "--json":
			options.json = true
		case argument == "--list":
			options.list = true
		case argument == "--forget":
			options.forget = next()
		case argument == "-h" || argument == "--help":
			options.help = true
		case strings.HasPrefix(argument, "-"):
			if options.parseError == "" {
				options.parseError = "unknown_option:" + argument
			}
		default:
			options.positional = append(options.positional, argument)
		}
	}
	if options.all && options.rcFileSet && options.parseError == "" {
		options.parseError = "rc_file_requires_single_shell"
	}
	if options.shellSet && options.shell == "" && options.parseError == "" {
		options.parseError = "missing_value:--shell"
	}
	if options.rcFileSet && options.rcFile == "" && options.parseError == "" {
		options.parseError = "missing_value:--rc-file"
	}
	if len(options.positional) > 0 && options.positional[0] == "typo" {
		action := ""
		if len(options.positional) > 1 {
			action = options.positional[1]
		}
		if action == "forget" {
			if options.forget == "" && len(options.positional) > 2 {
				options.forget = options.positional[2]
			}
			if options.forget == "" && options.parseError == "" {
				options.parseError = "missing_value:forget"
			}
			if len(options.positional) > 3 && options.parseError == "" {
				options.parseError = "unexpected_arguments"
			}
		} else if action != "" && action != "list" {
			if options.parseError == "" {
				options.parseError = "unknown_typo_action:" + action
			}
		} else if len(options.positional) > 2 && options.parseError == "" {
			options.parseError = "unexpected_arguments"
		}
	} else if len(options.positional) > 1 && options.parseError == "" {
		options.parseError = "unexpected_arguments"
	}
	return options
}

func resolveShellAihBinPath(runtime commandRuntime) string {
	if value, found := runtime.lookupEnv("AIH_EXECUTABLE"); found && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	executable, err := os.Executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return "aih"
	}
	if resolved, linkErr := filepath.EvalSymlinks(executable); linkErr == nil {
		executable = resolved
	}
	return executable
}

func shellService(runtime commandRuntime) (*shellsetup.Service, func(string) string) {
	env := func(name string) string {
		value, _ := runtime.lookupEnv(name)
		return value
	}
	home := shellsetup.ResolveHostHomeDir(env, runtime.userHomeDir)
	return shellsetup.NewService(home, env), env
}

func shellOverrides(options shellOptions, binPath string) shellsetup.SnippetOverrides {
	return shellsetup.SnippetOverrides{
		AihBinPath: binPath,
		Completion: options.completion,
		Typo:       options.typo,
		Wrapper:    options.wrapper,
	}
}

func writeShellJSON(runtime commandRuntime, value any) error {
	encoder := json.NewEncoder(runtime.stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", " ")
	return encoder.Encode(value)
}

func runShell(arguments []string, runtime commandRuntime) error {
	options := parseShellArgs(arguments)
	if options.parseError != "" && !options.help {
		if options.json {
			encoded, _ := json.Marshal(struct {
				OK     bool   `json:"ok"`
				Error  string `json:"error"`
				Detail string `json:"detail"`
			}{false, "invalid_shell_arguments", options.parseError})
			_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		} else {
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] 参数无效：%s\n", options.parseError)
		}
		return cliExitCode{code: 2}
	}
	action := ""
	if len(options.positional) > 0 {
		action = options.positional[0]
	}
	if options.help || action == "" {
		_, _ = fmt.Fprintln(runtime.stdout, shellHelp)
		if options.help {
			return nil
		}
		return cliExitCode{code: 1}
	}
	if action == "typo" {
		return runShellTypo(options, runtime)
	}
	validActions := map[string]bool{"status": true, "plan": true, "apply": true, "remove": true, "snippet": true, "doctor": true}
	if !validActions[action] {
		_, _ = fmt.Fprintf(runtime.stdout, "\x1b[33m[aih] 未识别的动作 '%s'，以下是可用用法：\x1b[0m\n", action)
		_, _ = fmt.Fprintln(runtime.stdout, shellHelp)
		return cliExitCode{code: 1}
	}

	service, env := shellService(runtime)
	binPath := resolveShellAihBinPath(runtime)
	overrides := shellOverrides(options, binPath)
	shellOption := ""
	if options.shellSet {
		shellOption = options.shell
	}
	rcOverride := ""
	if options.rcFileSet {
		rcOverride = options.rcFile
	}

	switch action {
	case "status":
		status := service.Status(shellOption, rcOverride, overrides)
		all := service.StatusAll(overrides, rcOverride)
		if options.json {
			payload := struct {
				shellsetup.Status
				Shells []shellsetup.DescribeJSON `json:"shells"`
			}{Status: status, Shells: make([]shellsetup.DescribeJSON, 0, len(all))}
			for _, entry := range all {
				payload.Shells = append(payload.Shells, entry.JSON())
			}
			_ = writeShellJSON(runtime, payload)
		} else {
			printShellStatus(runtime, status, all)
		}
		if !status.OK {
			return cliExitCode{code: 1}
		}
		return nil

	case "doctor":
		report := service.Doctor(shellOption, rcOverride, overrides)
		if options.json {
			_ = writeShellJSON(runtime, report)
		} else {
			_, _ = fmt.Fprintln(runtime.stdout, "\x1b[36mAIH Shell Doctor\x1b[0m")
			for _, check := range report.Checks {
				mark := "\x1b[32m✔\x1b[0m"
				if !check.OK {
					mark = "\x1b[31m✘\x1b[0m"
				}
				detail := ""
				if check.Detail != "" {
					detail = "  \x1b[90m" + check.Detail + "\x1b[0m"
				}
				_, _ = fmt.Fprintf(runtime.stdout, "  %s %s%s\n", mark, check.Name, detail)
			}
			if report.OK {
				_, _ = fmt.Fprintln(runtime.stdout, "\x1b[32m全部通过。\x1b[0m")
			} else {
				_, _ = fmt.Fprintln(runtime.stdout, "\x1b[33m有未通过的检查项，见上。\x1b[0m")
			}
		}
		if !report.OK {
			return cliExitCode{code: 1}
		}
		return nil

	case "snippet":
		result := service.Snippet(shellOption, rcOverride, overrides)
		if !result.OK {
			_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] 未识别的 shell（支持：%s）\x1b[0m\n", strings.Join(shellsetup.SupportedShells(), " / "))
			return cliExitCode{code: 1}
		}
		_, _ = fmt.Fprintln(runtime.stdout, strings.TrimRight(result.Content, "\n"))
		return nil

	case "plan", "apply":
		if action == "plan" || options.dryRun {
			plan := service.Plan(shellOption, rcOverride, overrides)
			if options.json {
				_ = writeShellJSON(runtime, plan)
			} else {
				printShellPlan(runtime, plan)
				if action == "apply" {
					_, _ = fmt.Fprintln(runtime.stdout, "\n\x1b[90m（dry-run：没有写入任何文件）\x1b[0m")
				}
			}
			if !plan.OK {
				return cliExitCode{code: 1}
			}
			return nil
		}
		return runShellApply(service, options, shellOption, rcOverride, overrides, env, runtime)

	case "remove":
		if options.all {
			results := make([]shellsetup.RemoveResult, 0, len(shellsetup.SupportedShells()))
			ok := true
			for _, shell := range shellsetup.SupportedShells() {
				result := service.Remove(shell, "")
				if !result.OK {
					ok = false
				}
				results = append(results, result)
			}
			if options.json {
				_ = writeShellJSON(runtime, map[string]any{"ok": ok, "results": results})
			} else {
				for _, result := range results {
					if !result.OK {
						detail := result.Detail
						if detail == "" {
							detail = result.Error
						}
						_, _ = fmt.Fprintf(runtime.stderr, "[aih] %s 移除失败：%s\n", result.Shell, detail)
					}
					if result.Removed {
						_, _ = fmt.Fprintf(runtime.stdout, "\x1b[32m[aih] %s 已移除\x1b[0m %s\n", result.Shell, result.RcFile)
					}
				}
			}
			if !ok {
				return cliExitCode{code: 1}
			}
			return nil
		}
		result := service.Remove(shellOption, rcOverride)
		if options.json {
			_ = writeShellJSON(runtime, result)
		} else if !result.OK {
			detail := result.Detail
			if detail == "" {
				detail = result.Error
			}
			_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] 移除失败：%s\x1b[0m\n", detail)
		} else if result.Removed {
			_, _ = fmt.Fprintf(runtime.stdout, "\x1b[32m[aih] 已移除\x1b[0m %s\n", result.RcFile)
			if result.SnippetFileRemoved {
				_, _ = fmt.Fprintf(runtime.stdout, "\x1b[90m片段文件已删除：%s\x1b[0m\n", result.SnippetFile)
			}
		} else {
			_, _ = fmt.Fprintln(runtime.stdout, "\x1b[90m没有找到 aih 写入的片段，无需移除。\x1b[0m")
		}
		if !result.OK {
			return cliExitCode{code: 1}
		}
		return nil
	}
	return nil
}

func runShellApply(service *shellsetup.Service, options shellOptions, shellOption, rcOverride string, overrides shellsetup.SnippetOverrides, env func(string) string, runtime commandRuntime) error {
	targets := []string{}
	if options.all {
		targets = append(targets, shellsetup.SupportedShells()...)
	} else if options.shellSet && options.shell != "" {
		// 显式 --shell 即使不受支持也要进入结果数组：Node 会返回
		// {shell, ok:false, error:"unsupported_shell"} 而不是静默跳过。
		targets = append(targets, options.shell)
	} else {
		shell := shellsetup.DetectShell(shellOption, env)
		if shell != "" {
			targets = append(targets, shell)
		}
	}
	if len(targets) == 0 {
		_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] 未识别的 shell（支持：%s）。用 --shell 显式指定。\x1b[0m\n", strings.Join(shellsetup.SupportedShells(), " / "))
		return cliExitCode{code: 1}
	}
	failed := false
	reports := make([]json.RawMessage, 0, len(targets))
	results := make([]shellsetup.ApplyResult, 0, len(targets))
	skipped := make([]bool, 0, len(targets))
	for _, shell := range targets {
		if options.all {
			info := service.DescribeShell(shell, overrides)
			if !info.ShellAvailable && !info.RcExists {
				report, _ := json.Marshal(struct {
					Shell   string `json:"shell"`
					OK      bool   `json:"ok"`
					Skipped bool   `json:"skipped"`
					Reason  string `json:"reason"`
				}{shell, true, true, "shell_not_installed"})
				reports = append(reports, report)
				results = append(results, shellsetup.ApplyResult{})
				skipped = append(skipped, true)
				continue
			}
		}
		snippetOptions := shellsetup.ResolveSnippetOptions(shellsetup.SnippetOverrides{}, overrides)
		snippet, _ := shellsetup.Snippet(shell, snippetOptions)
		syntax := shellsetup.CheckShellSyntax(shell, snippet, shellsetup.ResolveShellBinary(shell, env))
		if !syntax.OK {
			failed = true
			report, _ := json.Marshal(struct {
				Shell  string `json:"shell"`
				OK     bool   `json:"ok"`
				Error  string `json:"error"`
				Detail string `json:"detail"`
			}{shell, false, "snippet_syntax_invalid", syntax.Detail})
			reports = append(reports, report)
			results = append(results, shellsetup.ApplyResult{Error: "snippet_syntax_invalid", Detail: syntax.Detail})
			skipped = append(skipped, false)
			continue
		}
		result := service.Apply(shell, rcOverride, overrides, false)
		if result.Shell == "" {
			result.Shell = shell
		}
		if !result.OK {
			failed = true
		}
		encoded, _ := json.Marshal(result)
		reports = append(reports, encoded)
		results = append(results, result)
		skipped = append(skipped, false)
	}
	if options.json {
		_ = writeShellJSON(runtime, struct {
			OK      bool              `json:"ok"`
			Results []json.RawMessage `json:"results"`
		}{!failed, reports})
	} else {
		for index, shell := range targets {
			result := results[index]
			if skipped[index] {
				_, _ = fmt.Fprintf(runtime.stdout, "\x1b[90m[aih] %s：跳过（本机没装这个 shell）\x1b[0m\n", shell)
				continue
			}
			if !result.OK {
				detail := result.Detail
				_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] %s 写入失败：%s", shell, result.Error)
				if detail != "" {
					_, _ = fmt.Fprintf(runtime.stderr, "\n%s", detail)
				}
				_, _ = fmt.Fprintln(runtime.stderr, "\x1b[0m")
				continue
			}
			if !result.Changed {
				_, _ = fmt.Fprintf(runtime.stdout, "\x1b[32m[aih] %s\x1b[0m 已是最新，无需改动。\n", shell)
				continue
			}
			created := ""
			if result.RcCreated {
				created = " \x1b[90m(新建)\x1b[0m"
			}
			_, _ = fmt.Fprintf(runtime.stdout, "\x1b[32m[aih] %s 已写入\x1b[0m %s%s\n", shell, result.RcFile, created)
			if result.SnippetFile != "" {
				_, _ = fmt.Fprintf(runtime.stdout, "\x1b[90m片段：%s\x1b[0m\n", result.SnippetFile)
			}
			if result.BackupPath != "" {
				_, _ = fmt.Fprintf(runtime.stdout, "\x1b[90m备份：%s\x1b[0m\n", result.BackupPath)
			}
			_, _ = fmt.Fprintf(runtime.stdout, "\x1b[90m生效：新开终端，或执行 %s\x1b[0m\n", result.ReloadHint)
		}
	}
	if failed {
		return cliExitCode{code: 1}
	}
	return nil
}

func runShellTypo(options shellOptions, runtime commandRuntime) error {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	store := shellsetup.NewCorrectionsStore(aiHomeDir)
	if options.forget != "" {
		removed := store.Forget(options.forget)
		if options.json {
			_ = writeShellJSON(runtime, map[string]any{"ok": true, "forgotten": options.forget, "removed": removed})
		} else if removed {
			_, _ = fmt.Fprintf(runtime.stdout, "已遗忘纠正：%s\n", options.forget)
		} else {
			_, _ = fmt.Fprintf(runtime.stdout, "没有 %s 的纠正记录\n", options.forget)
		}
		return nil
	}
	entries := store.List()
	if options.json {
		_ = writeShellJSON(runtime, map[string]any{"ok": true, "file": store.FilePath, "corrections": entries})
		return nil
	}
	if len(entries) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "\x1b[90m还没有学习到任何纠正。命令打错时选择候选运行，就会记下来。\x1b[0m")
		return nil
	}
	_, _ = fmt.Fprintf(runtime.stdout, "\x1b[36m已学习的纠正\x1b[0m \x1b[90m(%s)\x1b[0m\n", store.FilePath)
	for _, entry := range entries {
		_, _ = fmt.Fprintf(runtime.stdout, "  %s  →  %s\n", entry.Typo, entry.Command)
	}
	_, _ = fmt.Fprintln(runtime.stdout, "\x1b[90m遗忘一条：aih shell typo --forget <打错的命令>\x1b[0m")
	return nil
}

func printShellStatus(runtime commandRuntime, status shellsetup.Status, all []shellsetup.Describe) {
	_, _ = fmt.Fprintln(runtime.stdout, "\x1b[36mAIH Shell\x1b[0m - 终端集成")
	if !status.OK {
		_, _ = fmt.Fprintf(runtime.stdout, "  当前 shell     \x1b[33m未识别（支持：%s）\x1b[0m\n", strings.Join(shellsetup.SupportedShells(), " / "))
		_, _ = fmt.Fprintln(runtime.stdout, "  \x1b[90m显式指定：aih shell apply --shell zsh\x1b[0m")
	} else {
		_, _ = fmt.Fprintf(runtime.stdout, "  当前 shell     %s\n", status.Shell)
		_, _ = fmt.Fprintf(runtime.stdout, "  aih 路径       %s\n", status.AihBinPath)
		_, _ = fmt.Fprintf(runtime.stdout, "  功能           TAB 补全 %s / 拼写纠正 %s / aih 包装函数 %s\n",
			onOff(status.Features.Completion), onOff(status.Features.Typo), onOff(status.Features.Wrapper))
	}
	if len(all) > 0 {
		_, _ = fmt.Fprintln(runtime.stdout)
		_, _ = fmt.Fprintln(runtime.stdout, "\x1b[90m各 shell 状态：\x1b[0m")
		for _, entry := range all {
			current := ""
			if entry.Shell == status.Shell {
				current = "\x1b[36m← 当前\x1b[0m"
			}
			state := "\x1b[90m未装（rc 不存在）\x1b[0m"
			if entry.Installed {
				if entry.UpToDate {
					state = "\x1b[32m已装\x1b[0m"
				} else {
					state = "\x1b[33m已装（内容与当前参数不一致，可重新 apply）\x1b[0m"
				}
			} else if entry.RcExists {
				state = "\x1b[90m未装\x1b[0m"
			}
			_, _ = fmt.Fprintf(runtime.stdout, "  %-11s %s %s %s\n", entry.Shell, state, entry.RcFile, current)
		}
	}
}

func onOff(value bool) string {
	if value {
		return "开"
	}
	return "关"
}

func printShellPlan(runtime commandRuntime, plan shellsetup.Plan) {
	if !plan.OK {
		reason := plan.Reason
		if reason == "" {
			reason = "unsupported_shell"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 无法生成方案：%s\n", reason)
		return
	}
	_, _ = fmt.Fprintf(runtime.stdout, "\x1b[36m[aih] 将要写入\x1b[0m %s（只替换 `# >>> aih:shell >>>` 标记之间的内容）\n", plan.RcFile)
	if plan.Installed {
		_, _ = fmt.Fprintln(runtime.stdout, "\x1b[90m（该文件里已有一个 aih:shell 块，会被整体替换）\x1b[0m")
	}
	if plan.SnippetFile != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "\x1b[90m片段文件：%s（TAB 补全与拼写纠正都在这里，rc 里只留一行 source）\x1b[0m\n", plan.SnippetFile)
	}
	_, _ = fmt.Fprintln(runtime.stdout)
	_, _ = fmt.Fprintln(runtime.stdout, strings.TrimRight(plan.Content, "\n"))
}
