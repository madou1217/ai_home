package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

func runLSList(ctx context.Context, runtime commandRuntime, options lsOptions) error {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	palette := paletteFor(runtime.stdout)
	load := func() (*lsData, error) {
		return loadLSData(ctx, runtime, options)
	}
	if isInteractiveLS(runtime) {
		// 首帧只读 Go 账号库；Node 凭据镜像与完整额度在后台补算后刷新。
		basic, basicErr := loadLSDataMode(ctx, runtime, options, false)
		if basicErr == nil && basic != nil {
			if handled, animErr := runLSAnimated(ctx, runtime, basic, load, aiHomeDir, palette); handled {
				return animErr
			}
		}
	}
	data, err := load()
	if err != nil {
		return err
	}
	writeLSStatic(runtime.stdout, data, palette)
	return nil
}

func isInteractiveLS(runtime commandRuntime) bool {
	stdin, ok := runtime.stdin.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(stdin.Fd())) && terminalWriterIsTTY(runtime.stdout)
}

func writeLSStatic(output io.Writer, data *lsData, palette terminalPalette) {
	now := time.Now()
	rows := buildLSRows(data, "", palette, false, now, now)
	for _, row := range rows {
		_, _ = fmt.Fprintln(output, row.render("  - "))
	}
	_, _ = fmt.Fprintln(output)
}

func writeLSHelp(output io.Writer, palette terminalPalette, target string) {
	if strings.TrimSpace(target) == "" {
		target = "aih ls"
	}
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, palette.cyan("AI Home List Mode Help"))
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, palette.yellow("Usage:"))
	_, _ = fmt.Fprintf(output, "  %s\n", target)
	_, _ = fmt.Fprintf(output, "  %s <id>\n", target)
	_, _ = fmt.Fprintln(output, "  aih ls --scope <provider...>")
	_, _ = fmt.Fprintln(output, "  aih <name|glob> ls [id]")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, palette.yellow("Behavior:"))
	_, _ = fmt.Fprintln(output, "  - TTY 下接管屏幕，每 100ms 重绘；每 1s 重建状态与额度。")
	_, _ = fmt.Fprintln(output, "  - 首帧只读账号索引；凭据/额度/运行态在后台补算。")
	_, _ = fmt.Fprintln(output, "  - / 筛选：输入即窄化，Enter 保留，Esc 清空；q/Esc 退出，Ctrl+C 退出。")
	_, _ = fmt.Fprintln(output, "  - 限流/额度/身份/套餐徽章按时间轮换，同一时刻只换一行。")
	_, _ = fmt.Fprintln(output, "  - 非 TTY（管道/重定向）输出完整快照。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, palette.yellow("Examples:"))
	_, _ = fmt.Fprintln(output, "  aih ls")
	_, _ = fmt.Fprintln(output, "  aih codex ls")
	_, _ = fmt.Fprintln(output, "  aih codex ls 41")
	_, _ = fmt.Fprintln(output, "  aih ls --scope codebuddy workbuddy")
	_, _ = fmt.Fprintln(output, "  aih buddy ls")
	_, _ = fmt.Fprintln(output, "  aih '*buddy*' ls")
}
