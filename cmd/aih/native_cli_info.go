package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func isNativeVersionArgs(args []string) bool {
	if len(args) != 1 {
		return false
	}
	switch args[0] {
	case "--version", "-v", "-V", "version":
		return true
	default:
		return false
	}
}

// writeNativeCLIVersion reads the installed package's existing version metadata;
// it never starts Node or creates a second runtime version registry.
func writeNativeCLIVersion(output io.Writer) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	root := filepath.Dir(executable)
	for range 4 {
		file, err := os.Open(filepath.Join(root, "package.json"))
		if err == nil {
			var pkg struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			}
			err = json.NewDecoder(io.LimitReader(file, 1<<20)).Decode(&pkg)
			_ = file.Close()
			if err != nil {
				return fmt.Errorf("读取 AIH 版本元信息失败: %w", err)
			}
			if pkg.Name == "proxy.meadeo.com" || pkg.Name == "ai-home" {
				if version := strings.TrimSpace(pkg.Version); version != "" {
					_, err = fmt.Fprintln(output, version)
					return err
				}
				return errors.New("AIH 安装包缺少版本元信息")
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("读取 AIH 版本元信息失败: %w", err)
		}
		parent := filepath.Dir(root)
		if parent == root {
			break
		}
		root = parent
	}
	return errors.New("找不到 AIH 安装包版本元信息")
}

// nativeUsageHelpRequested does not interpret filter values as CLI options.
func nativeUsageHelpRequested(args []string) bool {
	for index := 0; index < len(args); index++ {
		argument := strings.TrimSpace(args[index])
		if argument == "--help" || argument == "-h" || (index == 0 && argument == "help") {
			return true
		}
		switch argument {
		case "--from", "--to", "--provider", "--source", "--model", "--session-id", "--limit", "-n":
			index++
		}
	}
	return false
}

func writeNativeUsageHelp(output io.Writer) {
	_, _ = fmt.Fprintln(output, `aih usage — Go 原生模型用量查询

用法:
  aih usage [stats|models|sessions|session-detail] [选项]
  aih usage scan [选项]
  aih usage recalculate-costs [选项]
  aih summary [选项]

选项:
  --from <日期或时间>  --to <日期或时间>
  --provider <provider>  --model <model>  --session-id <id>
  --limit <数量>  --no-scan  --json
  --dry-run  --reindex-codex-forks

查询由 Go Server 处理；scan 与 recalculate-costs 在本机 Go 执行。
--dry-run 与 --reindex-codex-forks 用于本机扫描操作。`)
}
