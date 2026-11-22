// Command egress-guard 禁止在 internal/runtime/egress 之外自行构造账号级出口解析器。
//
// 规则：
//  1. 只有 internal/runtime/egress 可以调用 agyegress.NewResolver；
//  2. 只有 internal/runtime/egress 可以构造 agyegress.Options 字面量。
//
// 原因：账号解析器必须由 runtime/egress 统一接线 managed SSH。业务层自行
// 拼 agyegress.Options 时很容易漏掉 ResolveManagedSSH 等依赖，编译与单测都
// 不会报错，但 ssh 出口会在线上静默退化成直连。
//
// 不扫描 *_test.go，也不做动态调用分析。
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
)

const (
	// egressImportPath 是账号级出口解析器所在包。
	egressImportPath = "github.com/madou1217/ai_home/internal/adapters/agy/egress"
	// allowedDir 是唯一允许构造解析器的目录。
	allowedDir = "internal/runtime/egress/"
)

type finding struct {
	file  string
	line  int
	label string
}

func main() {
	root := flag.String("root", ".", "仓库根目录")
	flag.Parse()

	findings, err := run(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "egress guard:", err)
		os.Exit(1)
	}
	if len(findings) == 0 {
		fmt.Println("egress guard: ok")
		return
	}

	fmt.Fprintln(os.Stderr, "egress guard 失败：账号解析器必须由 internal/runtime/egress 统一接线 managed SSH；")
	fmt.Fprintln(os.Stderr, "业务层自行拼 agyegress.Options 会让 ssh 出口静默失效。")
	for _, item := range findings {
		fmt.Fprintf(os.Stderr, "%s:%d: 禁止构造 %s（必须由 internal/runtime/egress 统一接线）\n", item.file, item.line, item.label)
	}
	os.Exit(1)
}

func run(root string) ([]finding, error) {
	rootAbs, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return nil, err
	}

	findings := make([]finding, 0)
	err = filepath.WalkDir(rootAbs, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "node_modules", "vendor":
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
		if strings.HasPrefix(rel, allowedDir) {
			return nil
		}
		fileFindings, scanErr := scanFile(path, rel)
		if scanErr != nil {
			return scanErr
		}
		findings = append(findings, fileFindings...)
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(findings, func(left, right int) bool {
		if findings[left].file != findings[right].file {
			return findings[left].file < findings[right].file
		}
		return findings[left].line < findings[right].line
	})
	return findings, nil
}

// scanFile 解析单个 Go 文件，按行聚合命中的构造方式。
func scanFile(path, rel string) ([]finding, error) {
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, path, nil, 0)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", rel, err)
	}
	names := egressImportNames(file)
	if len(names) == 0 {
		return nil, nil
	}

	byLine := map[int]map[string]struct{}{}
	record := func(pos token.Pos, label string) {
		line := fileSet.Position(pos).Line
		if byLine[line] == nil {
			byLine[line] = map[string]struct{}{}
		}
		byLine[line][label] = struct{}{}
	}

	ast.Inspect(file, func(node ast.Node) bool {
		switch node := node.(type) {
		case *ast.CallExpr:
			if selector, ok := node.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "NewResolver" && refersToEgress(selector.X, names) {
				record(selector.Pos(), "agyegress.NewResolver")
			}
		case *ast.CompositeLit:
			if selector, ok := node.Type.(*ast.SelectorExpr); ok && selector.Sel.Name == "Options" && refersToEgress(selector.X, names) {
				record(selector.Pos(), "agyegress.Options")
			}
		}
		return true
	})

	lines := make([]int, 0, len(byLine))
	for line := range byLine {
		lines = append(lines, line)
	}
	sort.Ints(lines)

	findings := make([]finding, 0, len(lines))
	for _, line := range lines {
		labels := make([]string, 0, len(byLine[line]))
		for label := range byLine[line] {
			labels = append(labels, label)
		}
		sort.Strings(labels)
		findings = append(findings, finding{file: rel, line: line, label: strings.Join(labels, " + ")})
	}
	return findings, nil
}

// egressImportNames 返回本文件引用 egress 包时使用的局部名称（含别名）。
func egressImportNames(file *ast.File) map[string]struct{} {
	names := map[string]struct{}{}
	for _, spec := range file.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil || path != egressImportPath {
			continue
		}
		name := "egress"
		if spec.Name != nil {
			name = spec.Name.Name
		}
		if name == "_" || name == "." {
			continue
		}
		names[name] = struct{}{}
	}
	return names
}

func refersToEgress(expr ast.Expr, names map[string]struct{}) bool {
	ident, ok := expr.(*ast.Ident)
	if !ok {
		return false
	}
	_, found := names[ident.Name]
	return found
}
