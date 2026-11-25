// Package manual 渲染 `aih man` 的离线命令手册页。
//
// 页面模板由 AWS Server 的 agy/gemini-4-neon-xhigh 生成并作为静态资产内嵌；
// 运行时只注入命令树导出的条目，页面内容随命令面自动更新。
package manual

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/completion"
)

//go:embed page.html
var pageTemplate string

const (
	manifestPlaceholder = "__AIH_MANIFEST__"
	modelPlaceholder    = "__AIH_MODEL__"
	serverPlaceholder   = "__AIH_SERVER__"
)

// Meta 是页脚展示的生成来源。
type Meta struct {
	Model  string
	Server string
}

// Render 把条目注入内嵌模板；占位符缺失视为模板损坏，避免产出空白页。
func Render(entries []completion.DocEntry, meta Meta) ([]byte, error) {
	if !strings.Contains(pageTemplate, manifestPlaceholder) {
		return nil, errors.New("manual_template_missing_manifest")
	}
	if entries == nil {
		entries = []completion.DocEntry{}
	}
	manifest, err := json.Marshal(entries)
	if err != nil {
		return nil, fmt.Errorf("manual_manifest_encode: %w", err)
	}
	page := strings.ReplaceAll(pageTemplate, manifestPlaceholder, string(manifest))
	page = strings.ReplaceAll(page, modelPlaceholder, meta.Model)
	page = strings.ReplaceAll(page, serverPlaceholder, meta.Server)
	return []byte(page), nil
}

// Write 把渲染结果写到指定文件（0600 目录、0644 文件）。
func Write(entries []completion.DocEntry, meta Meta, path string) error {
	page, err := Render(entries, meta)
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
