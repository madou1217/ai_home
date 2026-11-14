package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

const modulePath = "github.com/madou1217/ai_home/"

type sourceFile struct {
	path    string
	pkg     string
	imports map[string]string
	file    *ast.File
}

type definition struct {
	value ast.Expr
	file  *sourceFile
}

type sources struct {
	positions *token.FileSet
	files     []*sourceFile
	constants map[string]definition
}

func loadSources(root string) (*sources, error) {
	src := &sources{positions: token.NewFileSet(), constants: make(map[string]definition)}
	for _, directory := range []string{"internal/host/aihserver", "internal/transport/http", "internal/contracts", "contracts"} {
		err := filepath.WalkDir(filepath.Join(root, filepath.FromSlash(directory)), func(filePath string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
				return nil
			}
			file, err := parser.ParseFile(src.positions, filePath, nil, 0)
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(root, filePath)
			if err != nil {
				return err
			}
			item := &sourceFile{path: filepath.ToSlash(relative), pkg: filepath.ToSlash(filepath.Dir(relative)), imports: make(map[string]string), file: file}
			for _, spec := range file.Imports {
				importPath, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					return err
				}
				name := path.Base(importPath)
				if spec.Name != nil {
					name = spec.Name.Name
				}
				if strings.HasPrefix(importPath, modulePath) {
					item.imports[name] = strings.TrimPrefix(importPath, modulePath)
				}
			}
			src.files = append(src.files, item)
			for _, decl := range file.Decls {
				group, ok := decl.(*ast.GenDecl)
				if !ok || group.Tok != token.CONST {
					continue
				}
				for _, spec := range group.Specs {
					value, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, name := range value.Names {
						if i < len(value.Values) {
							src.constants[item.pkg+"."+name.Name] = definition{value.Values[i], item}
						}
					}
				}
			}
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("scan %s: %w", directory, err)
		}
	}
	return src, nil
}

// resolve accepts only string constants and concatenation. Variables, calls,
// conditional registration and reflection remain explicitly unresolved.
func (src *sources) resolve(file *sourceFile, expr ast.Expr, seen map[string]bool) (string, bool) {
	switch node := expr.(type) {
	case *ast.BasicLit:
		if node.Kind != token.STRING {
			return "", false
		}
		value, err := strconv.Unquote(node.Value)
		return value, err == nil
	case *ast.ParenExpr:
		return src.resolve(file, node.X, seen)
	case *ast.BinaryExpr:
		if node.Op != token.ADD {
			return "", false
		}
		left, a := src.resolve(file, node.X, seen)
		right, b := src.resolve(file, node.Y, seen)
		return left + right, a && b
	case *ast.Ident:
		return src.resolveName(file.pkg+"."+node.Name, seen)
	case *ast.SelectorExpr:
		pkg, ok := node.X.(*ast.Ident)
		if !ok || file.imports[pkg.Name] == "" {
			return "", false
		}
		return src.resolveName(file.imports[pkg.Name]+"."+node.Sel.Name, seen)
	}
	return "", false
}

func (src *sources) resolveName(key string, seen map[string]bool) (string, bool) {
	if seen[key] {
		return "", false
	}
	decl, ok := src.constants[key]
	if !ok {
		return "", false
	}
	seen[key] = true
	value, ok := src.resolve(decl.file, decl.value, seen)
	delete(seen, key)
	return value, ok
}
