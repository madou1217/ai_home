package main

import (
	"go/ast"
	"go/token"
)

// localConstants returns only top-level, single-assignment temporaries whose
// syntax can be statically resolved. Any write, address escape, closure binding
// or shadowing conservatively excludes that name from route discovery.
func localConstants(file *sourceFile, fn *ast.FuncDecl) map[string]ast.Expr {
	candidates := make(map[string]ast.Expr)
	writes := make(map[string]int)
	escaped := make(map[string]bool)
	for _, statement := range fn.Body.List {
		assignment, ok := statement.(*ast.AssignStmt)
		if !ok || assignment.Tok != token.DEFINE || len(assignment.Lhs) != 1 || len(assignment.Rhs) != 1 {
			continue
		}
		name, ok := assignment.Lhs[0].(*ast.Ident)
		if ok && name.Name != "_" {
			candidates[name.Name] = assignment.Rhs[0]
		}
	}
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.AssignStmt:
			for _, target := range value.Lhs {
				if name, ok := target.(*ast.Ident); ok {
					writes[name.Name]++
				}
			}
		case *ast.IncDecStmt:
			if name, ok := value.X.(*ast.Ident); ok {
				writes[name.Name]++
			}
		case *ast.ValueSpec:
			for _, name := range value.Names {
				writes[name.Name]++
			}
		case *ast.RangeStmt:
			for _, target := range []ast.Expr{value.Key, value.Value} {
				if name, ok := target.(*ast.Ident); ok {
					writes[name.Name]++
				}
			}
		case *ast.UnaryExpr:
			if value.Op == token.AND {
				if name, ok := value.X.(*ast.Ident); ok {
					escaped[name.Name] = true
				}
			}
		case *ast.FuncLit:
			for _, fields := range []*ast.FieldList{value.Type.Params, value.Type.Results} {
				if fields == nil {
					continue
				}
				for _, field := range fields.List {
					for _, name := range field.Names {
						writes[name.Name]++
					}
				}
			}
		}
		return true
	})
	for name := range candidates {
		if writes[name] != 1 || escaped[name] {
			delete(candidates, name)
		}
	}
	// A local named like an import must not be evaluated as a package selector.
	for name := range file.imports {
		if writes[name] > 0 || escaped[name] {
			delete(candidates, name)
		}
	}
	return candidates
}
