// Package manual 渲染 `aih man` 的离线命令手册页。
//
// 页面不是手写 HTML 资产：结构由 render.go 的编译期模板生成，样式/交互来自
// assets 下的 CSS/JS，命令数据由补全命令树导出；构建脚本与 aih install 会把
// 生成结果放到发布包和安装目录。
package manual

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/completion"
)

// Write 渲染并写入指定文件（目录 0700、文件 0644）。
func Write(entries []completion.DocEntry, notes map[string]string, meta Meta, path string) error {
	page, err := Render(entries, notes, meta)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, page, 0o644)
}

// Open 用系统默认浏览器打开本地页面。
func Open(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("manual_path_required")
	}
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", path)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	default:
		command = exec.Command("xdg-open", path)
	}
	return command.Start()
}
