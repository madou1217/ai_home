// Command provider-lint 防止 Provider 配置根字面量回归。
//
// 只检查两类高信号问题：
//  1. 已知错误目录名（.codebuddycn / .workbuddycn / .qodercn）——这些名字从未存在；
//  2. qoder 配置根（.qoder / .qoder-cn）只允许出现在 Provider 合同与
//     storagepolicy 的宿主认证根声明中，其余 Go 代码必须查
//     providerroot.ConfigDir。
//
// 不扫描 _test.go，也不扫描本命令自身。
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var allowedQoderFiles = map[string]bool{
	"core/providers/builtins.go":               true,
	"internal/runtime/storagepolicy/policy.go": true,
}

func main() {
	root := flag.String("root", ".", "仓库根目录")
	flag.Parse()
	if err := run(*root); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("provider directory lint: ok")
}

func run(root string) error {
	rootAbs, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return err
	}
	problems := make([]string, 0)
	err = filepath.WalkDir(rootAbs, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "node_modules", "vendor", ".ai_home":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(rootAbs, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		if rel == "cmd/provider-lint/main.go" {
			return nil
		}
		fileSet := token.NewFileSet()
		file, parseErr := parser.ParseFile(fileSet, path, nil, 0)
		if parseErr != nil {
			return fmt.Errorf("%s: %w", rel, parseErr)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			value, unquoteErr := strconv.Unquote(literal.Value)
			if unquoteErr != nil {
				return true
			}
			line := fileSet.Position(literal.Pos()).Line
			switch value {
			case ".codebuddycn", ".workbuddycn", ".qodercn":
				problems = append(problems, fmt.Sprintf("%s:%d: 已知错误的配置根 %q", rel, line, value))
			case ".qoder", ".qoder-cn":
				if !allowedQoderFiles[rel] {
					problems = append(problems, fmt.Sprintf("%s:%d: qoder 配置根必须查 providerroot.ConfigDir，不能写 %q", rel, line, value))
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		return err
	}
	if len(problems) > 0 {
		return fmt.Errorf("provider 配置根 lint 失败:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}
