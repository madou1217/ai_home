// Command aih-manpage 在构建期生成离线命令手册。
//
// 页面内容来自补全命令树；产物直接写到发布目录，安装时再由 aih install
// 复制到 <AIH_HOME>/man/aih.html。它不是手写 HTML 资产。
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/completion"
	"github.com/madou1217/ai_home/internal/runtime/manual"
)

func main() {
	out := flag.String("out", filepath.Join("dist", "man", "index.html"), "输出文件")
	model := flag.String("model", "agy/gemini-4-neon-xhigh", "页脚展示的生成模型")
	server := flag.String("server", "aws", "页脚展示的生成服务")
	version := flag.String("version", "", "发布版本")
	flag.Parse()

	entries := completion.DocumentationEntries()
	notes := completion.DocumentationGroupNotes()
	meta := manual.Meta{
		Model:       *model,
		Server:      *server,
		Version:     *version,
		GeneratedAt: time.Now().Format("2006-01-02 15:04"),
	}
	if err := manual.Write(entries, notes, meta, *out); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "aih-manpage:", err)
		os.Exit(1)
	}
	_, _ = fmt.Fprintf(os.Stdout, "aih-manpage: %s (%d 条)\n", *out, len(entries))
}
