package managementops

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
)

// streamObservationRows reads exactly the existing 18-column observation projection.
// Its arguments are deliberately limited to the int64 bounds/high-water marks used
// by the three callers. queryErr and readErr preserve their existing error domains.
// consume must only accumulate/copy the value; it must not issue SQL on conn.
func streamObservationRows(ctx context.Context, conn *sql.Conn, query string, args []int64, consume func(observationRow)) (queryErr, readErr error) {
	if err := ctx.Err(); err != nil {
		return err, nil
	}
	named := make([]driver.NamedValue, len(args))
	for i, arg := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: arg}
	}
	usedRaw := false
	rawErr := conn.Raw(func(raw any) error {
		if err := ctx.Err(); err != nil {
			queryErr = err
			return err
		}
		queryer, ok := raw.(driver.QueryerContext)
		if !ok {
			return nil
		}
		rows, err := queryer.QueryContext(ctx, query, named)
		if err == driver.ErrSkip {
			// ErrSkip means the driver has not executed/consumed the query.
			return nil
		}
		usedRaw = true
		if err != nil {
			queryErr = err
			return err
		}
		// Both the driver connection and rows stay inside this Raw callback.
		readErr = streamDriverObservationRows(ctx, rows, consume)
		return readErr
	})
	if rawErr != nil {
		if queryErr == nil && readErr == nil {
			queryErr = rawErr
		}
		return queryErr, readErr
	}
	if usedRaw {
		return queryErr, readErr
	}
	// Fallback is possible only before any row or callback was consumed.
	return streamSQLObservationRows(ctx, conn, query, args, consume)
}

func streamDriverObservationRows(ctx context.Context, rows driver.Rows, consume func(observationRow)) (resultErr error) {
	defer func() {
		if closeErr := rows.Close(); resultErr == nil {
			// database/sql surfaces a Close failure reached at EOF through Rows.Err.
			resultErr = closeErr
		}
	}()
	columns := rows.Columns()
	values := make([]driver.Value, len(columns))
	var row observationRow
	dest := observationRowDestinations(&row)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := rows.Next(values)
		if err == io.EOF {
			return ctx.Err()
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil {
			return err
		}
		if len(values) != len(dest) {
			return fmt.Errorf("sql: expected %d destination arguments in Scan, not %d", len(values), len(dest))
		}
		for i, value := range values {
			if err := assignObservationValue(dest[i], value); err != nil {
				return fmt.Errorf("sql: Scan error on column index %d, name %q: %w", i, columns[i], err)
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		consume(row)
	}
}

func streamSQLObservationRows(ctx context.Context, conn *sql.Conn, query string, args []int64, consume func(observationRow)) (queryErr, readErr error) {
	params := make([]any, len(args))
	for i, arg := range args {
		params[i] = arg
	}
	rows, err := conn.QueryContext(ctx, query, params...)
	if err != nil {
		return err, nil
	}
	defer func() { _ = rows.Close() }()
	var row observationRow
	dest := observationRowDestinations(&row)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !rows.Next() {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return nil, rows.Err()
		}
		if err := rows.Scan(dest[:]...); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		consume(row)
	}
}

func observationRowDestinations(row *observationRow) [18]any {
	return [18]any{
		&row.ID, &row.EventKey, &row.Provider, &row.AccountRef, &row.SessionID, &row.SourceKind, &row.Model,
		&row.InputTokens, &row.OutputTokens, &row.CacheReadInputTokens,
		&row.CacheCreationInputTokens, &row.ReasoningOutputTokens, &row.TotalTokens,
		&row.CostUSD, &row.TimestampMS, &row.Project, &row.CWD, &row.GitBranch,
	}
}

// assignObservationValue avoids reflection for normal SQLite storage types.
// For non-NULL exceptional types, Go 1.26's public Null*.Scan methods delegate
// to the same standard conversion as *int64/*float64/*string. In particular,
// integer text "1.0" is rejected, while a float64(1) follows the standard scan.
// NULL must be rejected explicitly: Null*.Scan would otherwise accept it.
func assignObservationValue(dest any, value driver.Value) error {
	switch d := dest.(type) {
	case *int64:
		if v, ok := value.(int64); ok {
			*d = v
			return nil
		}
		if value == nil {
			return fmt.Errorf("converting NULL to int64 is unsupported")
		}
		var converted sql.NullInt64
		if err := converted.Scan(value); err != nil {
			return err
		}
		*d = converted.Int64
	case *float64:
		if v, ok := value.(float64); ok {
			*d = v
			return nil
		}
		if value == nil {
			return fmt.Errorf("converting NULL to float64 is unsupported")
		}
		var converted sql.NullFloat64
		if err := converted.Scan(value); err != nil {
			return err
		}
		*d = converted.Float64
	case *string:
		if v, ok := value.(string); ok {
			*d = v
			return nil
		}
		if value == nil {
			return fmt.Errorf("converting NULL to string is unsupported")
		}
		var converted sql.NullString
		if err := converted.Scan(value); err != nil {
			return err
		}
		*d = converted.String
	default:
		return fmt.Errorf("unsupported observation destination %T", dest)
	}
	return nil
}
