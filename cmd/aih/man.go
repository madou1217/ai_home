package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/completion"
	"github.com/madou1217/ai_home/internal/runtime/manual"
)

const manUsage = `用法: aih man [aih|<命令>] [--out <file>] [--no-open] [--json]

  aih man                 生成命令手册并在默认浏览器打开
  aih man aih             同上（兼容 man aih 的习惯写法）
  aih man --out <file>    只写文件，不打开
  aih man --no-open       不打开浏览器，打印路径
  aih man --json          只输出命令条目 JSON（供脚本消费）

页面数据来自 TAB 补全使用的同一棵命令树；模板由 AWS Server 的
agy/gemini-4-neon-xhigh 生成，离线可用，不请求任何外部资源。
`

// runMan 处理 `aih man`：渲染离线命令手册并自动打开。
func runMan(arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "man" {
		return false, nil
	}
	flags := flag.NewFlagSet("man", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	out := flags.String("out", "", "输出文件路径")
	noOpen := flags.Bool("no-open", false, "不打开浏览器")
	jsonOutput := flags.Bool("json", false, "输出条目 JSON")
	model := flags.String("model", "agy/gemini-4-neon-xhigh", "页脚展示的生成模型")
	server := flags.String("server", "aws", "页脚展示的生成服务")
	if err := flags.Parse(arguments[1:]); err != nil {
		_, _ = fmt.Fprint(runtime.stdout, manUsage)
		return true, nil
	}
	for _, arg := range flags.Args() {
		if arg == "help" || arg == "--help" || arg == "-h" {
			_, _ = fmt.Fprint(runtime.stdout, manUsage)
			return true, nil
		}
	}
	entries := completion.DocumentationEntries()
	if *jsonOutput {
		encoded, err := json.MarshalIndent(entries, "", "  ")
		if err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		return true, nil
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return true, err
	}
	path := strings.TrimSpace(*out)
	if path == "" {
		path = filepath.Join(home, "man", "aih.html")
	}
	meta := manual.Meta{Model: *model, Server: *server, GeneratedAt: time.Now().Format("2006-01-02 15:04")}
	if err := manual.Write(entries, completion.DocumentationGroupNotes(), meta, path); err != nil {
		return true, fmt.Errorf("生成命令手册失败: %w", err)
	}
	if !*noOpen {
		if err := manual.Open(path); err != nil {
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] 无法自动打开浏览器（%v），请手动打开: %s\n", err, path)
		}
	}
	_, _ = fmt.Fprintf(runtime.stdout, "命令手册已生成：%s（%d 条）\n", path, len(entries))
	return true, nil
}
