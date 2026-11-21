// Command provider-lint 防止 Provider 配置根字面量回归。
//
// 规则：
//  1. 三个从未存在过的错误目录名（.codebuddycn / .workbuddycn / .qodercn）
//     无条件禁止；
//  2. 其余 Provider 配置根从 Provider 合同派生（CLI.GlobalDir、
//     EffectiveNativeRoot、Storage.SessionRoots）：字面量等于某个根，或以
//     "<根>/" 开头即失败；
//  3. 只有合同声明层（core/providers/）与本命令自身可以写这些根；其它 Go
//     代码必须查 providerroot.ConfigDir / ConfigPath / NativePath。
//
// 不扫描 _test.go、注释与非 Go 文件，也不做动态拼接分析。
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
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// invalidRootNames 是历史上从 "." + providerID 拼出来的错误目录名，
// 这些目录从未在磁盘上存在过（正确值见 Provider 合同的 cli.globalDir）。
var invalidRootNames = map[string]struct{}{
	".codebuddycn": {},
	".workbuddycn": {},
	".qodercn":     {},
}

// contractDir 是 Provider 合同的声明层：配置根事实只能写在这里。
const contractDir = "core/providers/"

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
	roots, err := protectedRoots()
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
		if rel == "cmd/provider-lint/main.go" || strings.HasPrefix(rel, contractDir) {
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
			if _, invalid := invalidRootNames[value]; invalid {
				problems = append(problems, fmt.Sprintf("%s:%d: 已知错误的配置根 %q", rel, line, value))
				return true
			}
			if matched := matchedRoot(value, roots); matched != "" {
				problems = append(problems, fmt.Sprintf(
					"%s:%d: Provider 配置根 %q 必须查 providerroot（合同根 %q）", rel, line, value, matched))
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

// protectedRoots 从 Provider 合同派生所有受保护的配置/数据根。
// 长根优先，保证 ".gemini/antigravity-cli" 先于 ".gemini" 命中。
func protectedRoots() ([]string, error) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, fmt.Errorf("Provider 合同无效: %w", err)
	}
	seen := map[string]struct{}{}
	addRoot := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "\\") {
			return
		}
		segments := strings.Split(trimmed, "/")
		for _, segment := range segments {
			if segment == "" || segment == "." || segment == ".." {
				return
			}
		}
		seen[trimmed] = struct{}{}
	}
	for _, definition := range catalog.List() {
		if definition.CLI != nil {
			addRoot(definition.CLI.GlobalDir)
			if definition.CLI.InstallRoot != nil {
				addRoot(strings.Join(*definition.CLI.InstallRoot, "/"))
			}
		}
		addRoot(strings.Join(definition.EffectiveNativeRoot(), "/"))
		if definition.Storage == nil {
			continue
		}
		for _, sessionRoot := range definition.Storage.SessionRoots {
			addRoot(sessionRoot)
		}
		if definition.Storage.HostAuthRoot != nil {
			addRoot(strings.Join(*definition.Storage.HostAuthRoot, "/"))
		}
	}
	roots := make([]string, 0, len(seen))
	for root := range seen {
		roots = append(roots, root)
	}
	sort.Slice(roots, func(left, right int) bool {
		if len(roots[left]) != len(roots[right]) {
			return len(roots[left]) > len(roots[right])
		}
		return roots[left] < roots[right]
	})
	return roots, nil
}

// matchedRoot 返回 value 命中的合同根；等于根或以 "<根>/" 开头才算命中，
// 因此 ".claude.json" 不会命中 ".claude"。
func matchedRoot(value string, roots []string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	for _, root := range roots {
		if normalized == root || strings.HasPrefix(normalized, root+"/") {
			return root
		}
	}
	return ""
}
