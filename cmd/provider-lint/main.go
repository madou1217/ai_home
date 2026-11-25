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
// 只折叠由字符串字面量、括号和 + 组成的常量拼接；变量/函数结果不做数据流分析。
// 不扫描 _test.go、注释与非 Go 文件。
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
	selfTest := flag.Bool("self-test", false, "运行 lint 自身的负向自测")
	flag.Parse()
	if *selfTest {
		if err := runSelfTest(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("provider directory lint self-test: ok")
		return
	}
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
		parents := map[ast.Node]ast.Node{}
		ast.Walk(&parentVisitor{parents: parents}, file)
		ast.Inspect(file, func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.BasicLit:
				if typed.Kind != token.STRING {
					return true
				}
				value, unquoteErr := strconv.Unquote(typed.Value)
				if unquoteErr != nil {
					return true
				}
				line := fileSet.Position(typed.Pos()).Line
				if _, invalid := invalidRootNames[value]; invalid {
					problems = append(problems, fmt.Sprintf("%s:%d: 已知错误的配置根 %q", rel, line, value))
					return true
				}
				if matched := matchedRoot(value, roots); matched != "" {
					problems = append(problems, fmt.Sprintf(
						"%s:%d: Provider 配置根 %q 必须查 providerroot（合同根 %q）", rel, line, value, matched))
				}
			case *ast.BinaryExpr:
				if typed.Op != token.ADD {
					return true
				}
				if top := topAdditive(typed, parents); top != typed {
					if expr, ok := top.(ast.Expr); ok {
						if _, foldable := foldStringLiteral(expr); foldable {
							return true
						}
					}
				}
				// 先把常量字符串拼接折叠成最终值；如果表达式里已经有会被
				// BasicLit 规则单独报告的字面量，就不再重复报一次。
				value, ok := foldStringLiteral(typed)
				if !ok || containsProtectedLiteral(typed, roots) {
					return true
				}
				line := fileSet.Position(typed.Pos()).Line
				if _, invalid := invalidRootNames[value]; invalid {
					problems = append(problems, fmt.Sprintf("%s:%d: 已知错误的配置根 %q（字符串拼接）", rel, line, value))
					return true
				}
				if matched := matchedRoot(value, roots); matched != "" {
					problems = append(problems, fmt.Sprintf(
						"%s:%d: Provider 配置根 %q 必须查 providerroot（合同根 %q；字符串拼接）", rel, line, value, matched))
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

// runSelfTest 用临时 Go 文件验证 lint 本身仍能抓住已知回归：
// 字面量根、根的路径前缀、历史错误名必须失败；只带后缀的 .claude.json 不能误报。
func runSelfTest() error {
	cases := []struct {
		name       string
		source     string
		wantError  bool
		wantSubstr string
	}{
		{
			name:       "literal_root",
			source:     "package fixture\n\nvar bad = \".claude\"\n",
			wantError:  true,
			wantSubstr: "Provider 配置根 \".claude\"",
		},
		{
			name:       "literal_prefix",
			source:     "package fixture\n\nvar bad = \".claude/settings.json\"\n",
			wantError:  true,
			wantSubstr: "Provider 配置根 \".claude/settings.json\"",
		},
		{
			name:       "dynamic_concat_root",
			source:     "package fixture\n\nvar bad = \".\" + \"claude\"\n",
			wantError:  true,
			wantSubstr: "字符串拼接",
		},
		{
			name:       "dynamic_concat_prefix",
			source:     "package fixture\n\nvar bad = \".\" + \"claude\" + \"/settings.json\"\n",
			wantError:  true,
			wantSubstr: "字符串拼接",
		},
		{
			name:      "dynamic_concat_clean",
			source:    "package fixture\n\nvar ok = \".\" + \"claude\" + \".json\"\n",
			wantError: false,
		},
		{
			name:       "dynamic_concat_nested",
			source:     "package fixture\n\nvar prefix = \".\"\nvar bad = prefix + (\".\" + \"claude\")\n",
			wantError:  true,
			wantSubstr: "字符串拼接",
		},
		{
			name:       "known_invalid_root",
			source:     "package fixture\n\nvar bad = \".codebuddycn\"\n",
			wantError:  true,
			wantSubstr: "已知错误的配置根",
		},
		{
			name:      "clean_suffix",
			source:    "package fixture\n\nvar ok = \".claude.json\"\n",
			wantError: false,
		},
	}
	for _, testCase := range cases {
		dir, err := os.MkdirTemp("", "aih-provider-lint-")
		if err != nil {
			return err
		}
		writeErr := os.WriteFile(filepath.Join(dir, "fixture.go"), []byte(testCase.source), 0o600)
		if writeErr != nil {
			_ = os.RemoveAll(dir)
			return writeErr
		}
		runErr := run(dir)
		_ = os.RemoveAll(dir)
		if testCase.wantError {
			if runErr == nil {
				return fmt.Errorf("self-test %s: 期望 lint 失败，实际通过", testCase.name)
			}
			if !strings.Contains(runErr.Error(), testCase.wantSubstr) {
				return fmt.Errorf("self-test %s: 未命中 %q，实际错误: %w", testCase.name, testCase.wantSubstr, runErr)
			}
			continue
		}
		if runErr != nil {
			return fmt.Errorf("self-test %s: 期望通过，实际失败: %w", testCase.name, runErr)
		}
	}
	return nil
}

// parentVisitor 记录 AST 父节点，用于判断一个 + 表达式是否只是外层拼接的子表达式。
type parentVisitor struct {
	parents map[ast.Node]ast.Node
	stack   []ast.Node
}

func (visitor *parentVisitor) Visit(node ast.Node) ast.Visitor {
	if node == nil {
		if len(visitor.stack) > 0 {
			visitor.stack = visitor.stack[:len(visitor.stack)-1]
		}
		return visitor
	}
	if len(visitor.stack) > 0 {
		visitor.parents[node] = visitor.stack[len(visitor.stack)-1]
	}
	visitor.stack = append(visitor.stack, node)
	return visitor
}

// topAdditive 返回包住 node 的最外层 + 拼接（允许跨括号）。
func topAdditive(node ast.Node, parents map[ast.Node]ast.Node) ast.Node {
	top := node
	for parent := parents[node]; parent != nil; parent = parents[parent] {
		switch typed := parent.(type) {
		case *ast.ParenExpr:
			node = parent
		case *ast.BinaryExpr:
			if typed.Op != token.ADD {
				return top
			}
			top = typed
			node = parent
		default:
			return top
		}
	}
	return top
}

// foldStringLiteral 折叠由字符串字面量、括号和 + 组成的常量表达式。
func foldStringLiteral(expr ast.Expr) (string, bool) {
	switch typed := expr.(type) {
	case *ast.BasicLit:
		if typed.Kind != token.STRING {
			return "", false
		}
		value, err := strconv.Unquote(typed.Value)
		if err != nil {
			return "", false
		}
		return value, true
	case *ast.ParenExpr:
		return foldStringLiteral(typed.X)
	case *ast.BinaryExpr:
		if typed.Op != token.ADD {
			return "", false
		}
		left, ok := foldStringLiteral(typed.X)
		if !ok {
			return "", false
		}
		right, ok := foldStringLiteral(typed.Y)
		if !ok {
			return "", false
		}
		return left + right, true
	}
	return "", false
}

// containsProtectedLiteral 判断表达式内是否已有会被 BasicLit 规则单独报告的根，
// 避免同一个表达式在字面量和拼接两条路径上重复报错。
func containsProtectedLiteral(expr ast.Expr, roots []string) bool {
	found := false
	ast.Inspect(expr, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, err := strconv.Unquote(literal.Value)
		if err != nil {
			return true
		}
		if _, invalid := invalidRootNames[value]; invalid {
			found = true
			return false
		}
		if matchedRoot(value, roots) != "" {
			found = true
			return false
		}
		return true
	})
	return found
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
