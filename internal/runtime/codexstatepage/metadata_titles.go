package codexstatepage

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
)

const maxMetadataIDs = 1024
const maxMetadataBytes = 1 << 20

// ReadTitles batches requested IDs per vendor source. It preserves the old
// first-matching-source rule, even when that row's display title is empty, but
// never invokes the legacy point lookup's rollout-path repair side effect.
func ReadTitles(ctx context.Context, home string, ids []string) (map[string]string, error) {
	if strings.TrimSpace(home) == "" || !filepath.IsAbs(home) {
		return nil, errors.New("codex_metadata_home_invalid")
	}
	if len(ids) > maxMetadataIDs {
		return nil, ErrBudget
	}
	pending := make(map[string]bool, len(ids))
	inputBytes := 0
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if len(id) > 4096 {
			return nil, ErrBudget
		}
		if !pending[id] {
			inputBytes += len(id)
			if inputBytes > maxMetadataBytes {
				return nil, ErrBudget
			}
			pending[id] = true
		}
	}
	result := make(map[string]string, len(pending))
	if len(pending) == 0 {
		return result, nil
	}
	paths, err := discover(home)
	if err != nil {
		return nil, err
	}
	bytesKept := 0
	for _, path := range paths {
		if len(pending) == 0 {
			break
		}
		db, tx, err := openVendorReadOnly(ctx, path)
		if err != nil {
			return nil, err
		}
		func() {
			defer db.Close()
			defer tx.Rollback()
			var columns map[string]bool
			columns, err = tableColumns(ctx, tx, "threads")
			if err != nil {
				return
			}
			if !columns["id"] || (!columns["title"] && !columns["first_user_message"]) {
				err = ErrSchema
				return
			}
			titleColumn, firstColumn := "NULL", "NULL"
			if columns["title"] {
				titleColumn = "title"
			}
			if columns["first_user_message"] {
				firstColumn = "first_user_message"
			}
			keys := make([]string, 0, len(pending))
			for id := range pending {
				keys = append(keys, id)
			}
			for start := 0; start < len(keys); start += 128 {
				end := min(start+128, len(keys))
				args := make([]any, end-start)
				marks := make([]string, len(args))
				for i, id := range keys[start:end] {
					args[i] = id
					marks[i] = "?"
				}
				var rows *sql.Rows
				rows, err = tx.QueryContext(ctx, "SELECT id,"+titleColumn+","+firstColumn+" FROM threads WHERE id IN ("+strings.Join(marks, ",")+")", args...)
				if err != nil {
					return
				}
				for rows.Next() {
					var id string
					var title, first sql.NullString
					if err = rows.Scan(&id, &title, &first); err != nil {
						break
					}
					if !pending[id] {
						continue
					}
					value := title.String
					if value == "" {
						value = first.String
					}
					value = strings.TrimSpace(value)
					bytesKept += len(id) + len(value)
					if bytesKept > maxMetadataBytes {
						err = ErrBudget
						break
					}
					result[id] = value
					delete(pending, id)
				}
				if err == nil {
					err = rows.Err()
				}
				rows.Close()
				if err != nil {
					return
				}
			}
		}()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
