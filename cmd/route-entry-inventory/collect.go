package main

import (
	"bytes"
	"go/ast"
	"go/format"
	"path/filepath"
	"sort"
	"strings"
)

type source struct {
	File       string `json:"file"`
	Line       int    `json:"line"`
	Function   string `json:"function"`
	Expression string `json:"expression"`
}

type entry struct {
	Method       string `json:"method"`
	Path         string `json:"path"`
	Pattern      string `json:"pattern"`
	Evidence     string `json:"evidence"`
	RuntimeState string `json:"runtime_state"`
	Source       source `json:"source"`
}

type unresolved struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
	Source source `json:"source"`
}

type report struct {
	Version       int            `json:"schema_version"`
	Mode          string         `json:"mode"`
	Counts        map[string]int `json:"counts"`
	CoverageNotes []string       `json:"coverage_notes"`
	Entries       []entry        `json:"entries"`
	Unresolved    []unresolved   `json:"unresolved"`
}

func collect(root string) (report, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return report{}, err
	}
	src, err := loadSources(absolute)
	if err != nil {
		return report{}, err
	}
	out := report{
		Version: 1, Mode: "read_only_go_ast_registration_inventory",
		Counts: make(map[string]int), Entries: []entry{}, Unresolved: []unresolved{},
		CoverageNotes: []string{
			"Source registrations are candidates, not proof a constructor is reachable/enabled or a request succeeds.",
			"Method * means the mount does not constrain methods; inspect the handler for accepted verbs and WS/SSE upgrades.",
			"Generated /v0/webui aliases follow the current mountPublicManagementAliases rule, excluding internal and explicit opt-outs; reserved/shadowed candidates still need runtime reconciliation.",
			"Dynamic loops, runtime routing and handler-internal endpoints remain unresolved; no migration or acceptance percentage is derived.",
		},
	}
	for _, file := range src.files {
		if file.pkg != "internal/host/aihserver" {
			continue
		}
		for _, decl := range file.file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(node ast.Node) bool {
				switch value := node.(type) {
				case *ast.CallExpr:
					method, ok := value.Fun.(*ast.SelectorExpr)
					if !ok || (method.Sel.Name != "Handle" && method.Sel.Name != "HandleFunc") || len(value.Args) < 2 {
						break
					}
					receiver, ok := method.X.(*ast.Ident)
					if !ok || receiver.Name != "mux" {
						break
					}
					src.add(&out, file, fn.Name.Name, value.Args[0], "mux_registration", false)
				case *ast.CompositeLit:
					var pattern ast.Expr
					handlerFound, skipAlias := false, false
					for _, element := range value.Elts {
						keyValue, ok := element.(*ast.KeyValueExpr)
						if !ok {
							continue
						}
						key, ok := keyValue.Key.(*ast.Ident)
						if !ok {
							continue
						}
						switch key.Name {
						case "Pattern":
							pattern = keyValue.Value
						case "Handler":
							handlerFound = true
						case "SkipPublicAlias":
							literal, known := keyValue.Value.(*ast.Ident)
							skipAlias = !known || literal.Name != "false"
						}
					}
					if pattern != nil && handlerFound {
						src.add(&out, file, fn.Name.Name, pattern, "webui_constructor", !skipAlias)
					}
				}
				return true
			})
		}
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if a.Pattern != b.Pattern {
			return a.Pattern < b.Pattern
		}
		if a.Source.File != b.Source.File {
			return a.Source.File < b.Source.File
		}
		return a.Source.Line < b.Source.Line
	})
	for _, item := range out.Entries {
		out.Counts[item.Evidence]++
	}
	out.Counts["unresolved"] = len(out.Unresolved)
	return out, nil
}

func (src *sources) add(out *report, file *sourceFile, fn string, expr ast.Expr, evidence string, publicAlias bool) {
	var printed bytes.Buffer
	_ = format.Node(&printed, src.positions, expr)
	origin := source{file.path, src.positions.Position(expr.Pos()).Line, fn, printed.String()}
	pattern, ok := src.resolve(file, expr, make(map[string]bool))
	if !ok {
		out.Unresolved = append(out.Unresolved, unresolved{evidence, "non_constant_registration_expression", origin})
		return
	}
	method, routePath := "*", strings.TrimSpace(pattern)
	if space := strings.IndexByte(routePath, ' '); space >= 0 {
		method, routePath = routePath[:space], strings.TrimSpace(routePath[space+1:])
	}
	if !strings.HasPrefix(routePath, "/") {
		out.Unresolved = append(out.Unresolved, unresolved{evidence, "host_qualified_or_invalid_pattern", origin})
		return
	}
	out.Entries = append(out.Entries, entry{method, routePath, pattern, evidence, "not_verified", origin})
	const management = "/v1/management/webui"
	if publicAlias && strings.HasPrefix(routePath, management) && !strings.Contains(routePath, "/internal/") {
		alias := "/v0/webui" + strings.TrimPrefix(routePath, management)
		aliasPattern := alias
		if method != "*" {
			aliasPattern = method + " " + alias
		}
		out.Entries = append(out.Entries, entry{method, alias, aliasPattern, "derived_public_alias_candidate", "not_verified", origin})
	}
}
