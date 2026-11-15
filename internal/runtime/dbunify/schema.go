package dbunify

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

type object struct{ kind, name, table, ddl string }
type column struct {
	name, kind   string
	notNull, pk  int
	defaultValue sql.NullString
}

func quote(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }

func objects(ctx context.Context, c *sql.Conn, schema string) ([]object, error) {
	rows, err := c.QueryContext(ctx, `SELECT type,name,tbl_name,sql FROM `+schema+`.sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []object
	for rows.Next() {
		var o object
		if err := rows.Scan(&o.kind, &o.name, &o.table, &o.ddl); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func columns(ctx context.Context, c *sql.Conn, schema, table string) ([]column, error) {
	rows, err := c.QueryContext(ctx, `PRAGMA `+schema+`.table_info(`+quote(table)+`)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []column
	for rows.Next() {
		var v column
		var cid int
		if err := rows.Scan(&cid, &v.name, &v.kind, &v.notNull, &v.defaultValue, &v.pk); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Rewrite identifiers, never SQL literals. DDL is trusted local SQLite schema,
// but quoted identifiers and strings must not be changed by substring replace.
func rewriteDDL(text string, names map[string]string) string {
	var out strings.Builder
	for i := 0; i < len(text); {
		start := i
		ch := text[i]
		if ch == '\'' {
			i++
			for i < len(text) {
				if text[i] == '\'' {
					i++
					if i < len(text) && text[i] == '\'' {
						i++
						continue
					}
					break
				}
				i++
			}
			out.WriteString(text[start:i])
			continue
		}
		if ch == '"' || ch == '`' || ch == '[' {
			end := ch
			if ch == '[' {
				end = ']'
			}
			i++
			var token strings.Builder
			for i < len(text) {
				if text[i] == end {
					i++
					if i < len(text) && text[i] == end {
						token.WriteByte(end)
						i++
						continue
					}
					break
				}
				token.WriteByte(text[i])
				i++
			}
			if next, ok := names[token.String()]; ok && next != token.String() {
				out.WriteString(quote(next))
			} else {
				out.WriteString(text[start:i])
			}
			continue
		}
		if unicode.IsLetter(rune(ch)) || ch == '_' {
			i++
			for i < len(text) && (unicode.IsLetter(rune(text[i])) || unicode.IsDigit(rune(text[i])) || text[i] == '_') {
				i++
			}
			token := text[start:i]
			if next, ok := names[token]; ok && next != token {
				out.WriteString(quote(next))
			} else {
				out.WriteString(token)
			}
			continue
		}
		out.WriteByte(ch)
		i++
	}
	return out.String()
}

// Existing Go and Node indexes can differ in formatting. Compare SQL tokens,
// retaining literal/quoted contents and token boundaries; do not strip spaces
// from values or accept different expressions, predicates or index ordering.
func sameDDL(left, right string) bool {
	if left == right {
		return true
	}
	// Newline placement changes the meaning of line comments. Conservatively
	// require exact text whenever a comment marker occurs, even inside a value.
	for _, marker := range []string{"--", "/*"} {
		if strings.Contains(left, marker) || strings.Contains(right, marker) {
			return false
		}
	}
	tokens := func(text string) []string {
		var out []string
		for i := 0; i < len(text); {
			if unicode.IsSpace(rune(text[i])) {
				i++
				continue
			}
			start := i
			ch := text[i]
			i++
			if ch == '\'' || ch == '"' || ch == '`' || ch == '[' {
				end := ch
				if ch == '[' {
					end = ']'
				}
				for i < len(text) {
					if text[i] == end {
						i++
						if i < len(text) && text[i] == end {
							i++
							continue
						}
						break
					}
					i++
				}
			} else if unicode.IsLetter(rune(ch)) || unicode.IsDigit(rune(ch)) || ch == '_' {
				for i < len(text) && (unicode.IsLetter(rune(text[i])) || unicode.IsDigit(rune(text[i])) || text[i] == '_') {
					i++
				}
			}
			out = append(out, text[start:i])
		}
		return out
	}
	a, b := tokens(left), tokens(right)
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func mappedNames(source []object) map[string]string {
	names := map[string]string{}
	for _, o := range source {
		if o.kind == "table" {
			names[o.name] = businessdb.CompatibilityTable(o.name)
		} else if businessdb.CompatibilityTable(o.table) != o.table {
			names[o.name] = "compat_" + o.name
		}
	}
	return names
}

func copyTable(ctx context.Context, c *sql.Conn, o object, names map[string]string) (TableResult, error) {
	target := names[o.name]
	result := TableResult{Source: o.name, Target: target}
	sourceCols, err := columns(ctx, c, "legacy", o.name)
	if err != nil {
		return result, err
	}
	destCols, err := columns(ctx, c, "main", target)
	if err != nil {
		return result, err
	}
	if len(destCols) == 0 {
		if _, err = c.ExecContext(ctx, rewriteDDL(o.ddl, names)); err != nil {
			return result, fmt.Errorf("create %s: %w", target, err)
		}
	} else {
		if len(destCols) != len(sourceCols) {
			return result, fmt.Errorf("schema_conflict: %s", target)
		}
		for i, col := range sourceCols {
			if col != destCols[i] {
				return result, fmt.Errorf("schema_conflict: %s.%s", target, col.name)
			}
		}
	}
	var fields, keys, equality []string
	for _, col := range sourceCols {
		fields = append(fields, quote(col.name))
		equality = append(equality, "s."+quote(col.name)+" IS t."+quote(col.name))
		if col.pk > 0 {
			keys = append(keys, "s."+quote(col.name)+" IS t."+quote(col.name))
		}
	}
	src := "legacy." + quote(o.name)
	dst := "main." + quote(target)
	if err = c.QueryRowContext(ctx, "SELECT count(*) FROM "+src).Scan(&result.SourceRows); err != nil {
		return result, err
	}
	if err = c.QueryRowContext(ctx, "SELECT count(*) FROM "+dst).Scan(&result.ExistingRows); err != nil {
		return result, err
	}
	predicate := ""
	if result.ExistingRows > 0 {
		if len(keys) == 0 {
			return result, fmt.Errorf("keyless_table_conflict: %s", target)
		}
		var conflict bool
		err = c.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM `+src+` s JOIN `+dst+` t ON `+strings.Join(keys, " AND ")+` WHERE NOT (`+strings.Join(equality, " AND ")+`))`).Scan(&conflict)
		if err != nil {
			return result, err
		}
		if conflict {
			return result, fmt.Errorf("row_conflict: %s (same key, different content; nothing overwritten)", target)
		}
		predicate = " WHERE NOT EXISTS(SELECT 1 FROM " + dst + " t WHERE " + strings.Join(keys, " AND ") + ")"
	}
	query := "INSERT INTO " + dst + " (" + strings.Join(fields, ",") + ") SELECT " + strings.Join(fields, ",") + " FROM " + src + " s" + predicate
	inserted, err := c.ExecContext(ctx, query)
	if err != nil {
		return result, fmt.Errorf("copy %s: %w", target, err)
	}
	result.InsertedRows, err = inserted.RowsAffected()
	if err != nil {
		return result, err
	}
	if err = c.QueryRowContext(ctx, "SELECT count(*) FROM "+dst).Scan(&result.FinalRows); err != nil {
		return result, err
	}
	var missing bool
	err = c.QueryRowContext(ctx, "SELECT EXISTS(SELECT "+strings.Join(fields, ",")+" FROM "+src+" EXCEPT SELECT "+strings.Join(fields, ",")+" FROM "+dst+")").Scan(&missing)
	if err != nil {
		return result, err
	}
	if missing || result.FinalRows != result.ExistingRows+result.InsertedRows {
		return result, fmt.Errorf("copy_verification_failed: %s", target)
	}
	return result, nil
}
