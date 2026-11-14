package providerconfigs

import (
	"fmt"
	"strings"
)

// TOMLStatement identifies syntax spans without reserializing unrelated text.
// Start/End cover a statement line (including its trailing comment/newline).
// ValueStart/ValueEnd cover only an assignment's value. Keys are decoded TOML
// key components, not dotted strings; whitespace inside quoted keys is significant.
type TOMLStatement struct {
	Start, End           int
	ValueStart, ValueEnd int
	Table                bool
	ArrayTable           bool
	TablePath            []string
	Keys                 []string
	Value                any
}

// ScanTOMLStatements reuses the validated config parser's string/collection
// grammar. Syntax errors use a closed code, never echoing possibly secret values.
func ScanTOMLStatements(content string) ([]TOMLStatement, error) {
	body := strings.TrimPrefix(content, "\ufeff")
	offset := len(content) - len(body)
	if _, err := parseTOML(body); err != nil {
		return nil, fmt.Errorf("invalid_toml_document")
	}
	p := &tomlParser{src: body}
	var statements []TOMLStatement
	var table []string
	for {
		p.skipWSAndComments(true)
		if p.eof() {
			return statements, nil
		}
		start := strings.LastIndex(body[:p.pos], "\n") + 1
		item := TOMLStatement{Start: start + offset}
		if p.peek() == '[' {
			item.Table = true
			p.pos++
			if !p.eof() && p.peek() == '[' {
				item.ArrayTable = true
				p.pos++
			}
			keys, err := p.parseDottedKey()
			if err != nil {
				return nil, fmt.Errorf("invalid_toml_table")
			}
			p.skipWSInline()
			p.pos++ // Closing bracket(s) were verified by parseTOML.
			if item.ArrayTable {
				p.pos++
			}
			table = keys
			item.Keys = append([]string(nil), keys...)
		} else {
			keys, err := p.parseDottedKey()
			if err != nil {
				return nil, fmt.Errorf("invalid_toml_assignment")
			}
			item.Keys = keys
			item.TablePath = append([]string(nil), table...)
			p.skipWSInline()
			p.pos++ // '=' was verified by parseTOML.
			p.skipWSInline()
			item.ValueStart = p.pos + offset
			item.Value, err = p.parseValue()
			if err != nil {
				return nil, fmt.Errorf("invalid_toml_value")
			}
			item.ValueEnd = p.pos + offset
		}
		if err := p.expectLineEndOrComment(); err != nil {
			return nil, fmt.Errorf("invalid_toml_statement")
		}
		item.End = p.pos + offset
		statements = append(statements, item)
	}
}
