package distributiondata

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
)

func quote(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

func attach(ctx context.Context, db *sql.DB, path, schema string) error {
	u := sqlitefile.URL(path)
	q := u.Query()
	q.Set("mode", "ro")
	u.RawQuery = q.Encode()
	_, err := db.ExecContext(ctx, "ATTACH DATABASE ? AS "+quote(schema), u.String())
	return err
}

func tables(ctx context.Context, db *sql.DB, schema string) ([]string, error) {
	rows, err := db.QueryContext(ctx, "SELECT name FROM "+quote(schema)+".sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func exists(ctx context.Context, db *sql.DB, schema, table string) (bool, error) {
	var found bool
	err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM "+quote(schema)+".sqlite_schema WHERE type='table' AND name=?)", table).Scan(&found)
	return found, err
}

func columns(ctx context.Context, db *sql.DB, schema, table string) ([]string, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA "+quote(schema)+".table_xinfo("+quote(table)+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var cid, notNull, pk, hidden int
		var name, kind string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &pk, &hidden); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("distributiondata: table_missing: %s.%s", schema, table)
	}
	return names, nil
}

func selectTable(schema, table string, names []string) string {
	projection := make([]string, len(names))
	for i, name := range names {
		projection[i] = quote(name) + " COLLATE BINARY AS " + quote(name)
	}
	return "SELECT " + strings.Join(projection, ",") + " FROM " + quote(schema) + "." + quote(table)
}

// Comparing grouped multiplicities makes EXCEPT sensitive to duplicate rows,
// too. Count-only/set-only checks would miss redistribution of keyless rows.
func equalQueries(ctx context.Context, db *sql.DB, expected, actual string, names []string) error {
	group := func(query string) string {
		values := make([]string, len(names))
		for i, name := range names {
			values[i] = "typeof(" + quote(name) + ")," + quote(name) + " COLLATE BINARY"
		}
		groupFields := strings.Join(values, ",")
		return "SELECT " + groupFields + ",count(*) FROM (" + query + ") GROUP BY " + groupFields
	}
	left, right := group(expected), group(actual)
	for _, pair := range [][2]string{{left, right}, {right, left}} {
		var different bool
		if err := db.QueryRowContext(ctx, "SELECT EXISTS("+pair[0]+" EXCEPT "+pair[1]+")").Scan(&different); err != nil {
			return err
		}
		if different {
			return errors.New("distributiondata: content_verification_failed (bidirectional EXCEPT)")
		}
	}
	return nil
}

func compareTable(ctx context.Context, db *sql.DB, sourceSchema, source, targetSchema, target string) (TableCheck, error) {
	check := TableCheck{Source: sourceSchema + "." + source, Target: targetSchema + "." + target, Check: "bidirectional_except_with_multiplicity"}
	names, err := columns(ctx, db, sourceSchema, source)
	if err != nil {
		return check, err
	}
	targetNames, err := columns(ctx, db, targetSchema, target)
	if err != nil {
		return check, err
	}
	present := make(map[string]bool, len(targetNames))
	for _, name := range targetNames {
		present[name] = true
	}
	for _, name := range names {
		if !present[name] {
			return check, fmt.Errorf("distributiondata: source column lost: %s.%s", check.Source, name)
		}
	}
	if err := equalQueries(ctx, db, selectTable(sourceSchema, source, names), selectTable(targetSchema, target, names), names); err != nil {
		return check, fmt.Errorf("%s: %w", check.Source, err)
	}
	err = db.QueryRowContext(ctx, "SELECT count(*) FROM "+quote(sourceSchema)+"."+quote(source)).Scan(&check.Rows)
	return check, err
}

func compareUnion(ctx context.Context, db *sql.DB, source, target string, hasBefore bool) (TableCheck, error) {
	check := TableCheck{Source: "legacy_before." + source, Target: "main." + target, Check: "conflict_free_union_bidirectional_except"}
	names, err := columns(ctx, db, "legacy_before", source)
	if err != nil {
		return check, err
	}
	expected := selectTable("legacy_before", source, names)
	if hasBefore {
		found, err := exists(ctx, db, "before", target)
		if err != nil {
			return check, err
		}
		if found {
			var count int64
			if err := db.QueryRowContext(ctx, "SELECT count(*) FROM before."+quote(target)).Scan(&count); err != nil {
				return check, err
			}
			// dbunify rejects nonempty keyless targets; with a primary key,
			// UNION exactly models its insert-only, identical-overlap policy.
			if count > 0 {
				expected += " UNION " + selectTable("before", target, names)
			}
		}
	}
	if err := equalQueries(ctx, db, expected, selectTable("main", target, names), names); err != nil {
		return check, fmt.Errorf("%s -> %s: %w", check.Source, check.Target, err)
	}
	err = db.QueryRowContext(ctx, "SELECT count(*) FROM main."+quote(target)).Scan(&check.Rows)
	return check, err
}
