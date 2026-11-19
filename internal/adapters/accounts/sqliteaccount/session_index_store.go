package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/sessionindex"
)

var _ sessionindex.Store = (*Store)(nil)

var errInvalidSessionIndexScope = errors.New("session_index_scope_invalid")

// LoadSessionIndex 读取某个 provider/account 最近一次物化快照。
//
// 没有 state 行表示从未扫描过；有 state 行但没有任何 session 行是合法的空列表。
func (store *Store) LoadSessionIndex(
	ctx context.Context,
	provider string,
	accountRef string,
) (sessionindex.Snapshot, bool, error) {
	var snapshot sessionindex.Snapshot
	if store == nil || store.db == nil ||
		strings.TrimSpace(provider) == "" || strings.TrimSpace(accountRef) == "" {
		return snapshot, false, errInvalidSessionIndexScope
	}
	var scannedAtMS int64
	var truncated int
	err := store.db.QueryRowContext(ctx, `
		SELECT scanned_at_ms, truncated
		FROM session_index_state
		WHERE provider = ? AND account_ref = ?`,
		provider, accountRef,
	).Scan(&scannedAtMS, &truncated)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshot, false, nil
	}
	if err != nil {
		return snapshot, false, fmt.Errorf("读取会话索引状态失败: %w", err)
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT project_id, project_name, project_path,
		       session_id, title, updated_at_ms, project_dir_name
		FROM session_index
		WHERE provider = ? AND account_ref = ?
		ORDER BY updated_at_ms DESC, project_id, session_id`,
		provider, accountRef,
	)
	if err != nil {
		return snapshot, false, fmt.Errorf("读取会话索引失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	byID := make(map[string]*sessionindex.Project)
	order := make([]string, 0)
	for rows.Next() {
		var (
			projectID   string
			projectName string
			projectPath string
			sessionID   string
			title       string
			updatedAtMS int64
			projectDir  string
		)
		if err := rows.Scan(
			&projectID, &projectName, &projectPath,
			&sessionID, &title, &updatedAtMS, &projectDir,
		); err != nil {
			return snapshot, false, fmt.Errorf("读取会话索引行失败: %w", err)
		}
		project, ok := byID[projectID]
		if !ok {
			project = &sessionindex.Project{
				ID:       projectID,
				Name:     projectName,
				Path:     projectPath,
				Provider: provider,
			}
			byID[projectID] = project
			order = append(order, projectID)
		}
		project.Sessions = append(project.Sessions, sessionindex.Session{
			ID:             sessionID,
			Title:          title,
			UpdatedAtMS:    updatedAtMS,
			Provider:       provider,
			ProjectDirName: projectDir,
		})
	}
	if err := rows.Err(); err != nil {
		return snapshot, false, fmt.Errorf("遍历会话索引失败: %w", err)
	}
	projects := make([]sessionindex.Project, 0, len(order))
	for _, id := range order {
		projects = append(projects, *byID[id])
	}
	snapshot = sessionindex.Snapshot{
		Projects:    projects,
		ScannedAtMS: scannedAtMS,
		Truncated:   truncated == 1,
	}
	return snapshot, true, nil
}

// ReplaceSessionIndex 在一个事务里替换某 provider/account 的完整快照。
func (store *Store) ReplaceSessionIndex(
	ctx context.Context,
	provider string,
	accountRef string,
	snapshot sessionindex.Snapshot,
) error {
	if store == nil || store.db == nil ||
		strings.TrimSpace(provider) == "" || strings.TrimSpace(accountRef) == "" ||
		snapshot.ScannedAtMS < 0 {
		return errInvalidSessionIndexScope
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始会话索引事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM session_index
		WHERE provider = ? AND account_ref = ?`, provider, accountRef); err != nil {
		return fmt.Errorf("清理会话索引失败: %w", err)
	}
	statement, err := tx.PrepareContext(ctx, `
		INSERT INTO session_index (
			provider, account_ref, project_id, project_name, project_path,
			session_id, title, updated_at_ms, project_dir_name, scanned_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("准备写入会话索引失败: %w", err)
	}
	defer func() { _ = statement.Close() }()
	for _, project := range snapshot.Projects {
		for _, session := range project.Sessions {
			if strings.TrimSpace(session.ID) == "" {
				continue
			}
			if _, err := statement.ExecContext(
				ctx,
				provider, accountRef, project.ID, project.Name, project.Path,
				session.ID, session.Title, session.UpdatedAtMS,
				session.ProjectDirName, snapshot.ScannedAtMS,
			); err != nil {
				return fmt.Errorf("写入会话索引失败: %w", err)
			}
		}
	}
	truncated := 0
	if snapshot.Truncated {
		truncated = 1
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO session_index_state (
			provider, account_ref, scanned_at_ms, truncated
		) VALUES (?, ?, ?, ?)
		ON CONFLICT (provider, account_ref) DO UPDATE SET
			scanned_at_ms = excluded.scanned_at_ms,
			truncated = excluded.truncated`,
		provider, accountRef, snapshot.ScannedAtMS, truncated,
	); err != nil {
		return fmt.Errorf("写入会话索引状态失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交会话索引事务失败: %w", err)
	}
	return nil
}
