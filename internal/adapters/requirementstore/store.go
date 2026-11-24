// Package requirementstore 把需求、工作区与会话时间线持久化在唯一的 aih.db。
package requirementstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/application/requirements"
)

const schema = `
CREATE TABLE IF NOT EXISTS requirement_workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_paths TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    account_ref TEXT NOT NULL DEFAULT '',
    max_parallel INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    workspace_id TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'plan',
    parallel INTEGER NOT NULL DEFAULT 0,
    steps_json TEXT NOT NULL DEFAULT '[]',
    refined_at_ms INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    progress_note TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    peer_message_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    loop_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER NOT NULL DEFAULT 0,
    completed_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requirements_status_position ON requirements(status, priority, position);
CREATE INDEX IF NOT EXISTS requirements_workspace ON requirements(workspace_id);
CREATE TABLE IF NOT EXISTS requirement_events (
    id TEXT PRIMARY KEY,
    requirement_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requirement_events_requirement ON requirement_events(requirement_id, at_ms DESC);
CREATE TABLE IF NOT EXISTS requirement_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
`

// Store 是 requirements.Store 的 SQLite 实现。
type Store struct {
	db *sql.DB
}

// Open 打开 aih.db 并确保需求表存在。
func Open(ctx context.Context, aiHomeDir string) (*Store, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, errors.New("requirement_store_home_required")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("创建 AIH 数据目录失败: %w", err)
	}
	path := filepath.Join(root, "aih.db")
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开需求数据库失败: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	if _, err := db.ExecContext(ctx, schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("初始化需求表失败: %w", err)
	}
	return &Store{db: db}, nil
}

// Close 关闭数据库连接。
func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	return store.db.Close()
}

// ListWorkspaces 返回全部工作区。
func (store *Store) ListWorkspaces(ctx context.Context) ([]requirements.Workspace, error) {
	rows, err := store.db.QueryContext(ctx, `
		SELECT id, name, project_paths, provider, model, account_ref, max_parallel, created_at_ms, updated_at_ms
		FROM requirement_workspaces ORDER BY created_at_ms ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []requirements.Workspace{}
	for rows.Next() {
		var workspace requirements.Workspace
		var paths string
		if err := rows.Scan(&workspace.ID, &workspace.Name, &paths, &workspace.Provider, &workspace.Model, &workspace.AccountRef, &workspace.MaxParallel, &workspace.CreatedAt, &workspace.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(paths), &workspace.ProjectPaths)
		if workspace.ProjectPaths == nil {
			workspace.ProjectPaths = []string{}
		}
		out = append(out, workspace)
	}
	return out, rows.Err()
}

// GetWorkspace 按 ID 读取工作区。
func (store *Store) GetWorkspace(ctx context.Context, id string) (requirements.Workspace, error) {
	var workspace requirements.Workspace
	var paths string
	err := store.db.QueryRowContext(ctx, `
		SELECT id, name, project_paths, provider, model, account_ref, max_parallel, created_at_ms, updated_at_ms
		FROM requirement_workspaces WHERE id = ? LIMIT 1`, strings.TrimSpace(id)).
		Scan(&workspace.ID, &workspace.Name, &paths, &workspace.Provider, &workspace.Model, &workspace.AccountRef, &workspace.MaxParallel, &workspace.CreatedAt, &workspace.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return requirements.Workspace{}, fmt.Errorf("%w: 工作区不存在", requirements.ErrNotFound)
	}
	if err != nil {
		return requirements.Workspace{}, err
	}
	_ = json.Unmarshal([]byte(paths), &workspace.ProjectPaths)
	if workspace.ProjectPaths == nil {
		workspace.ProjectPaths = []string{}
	}
	return workspace, nil
}

// SaveWorkspace 插入或更新工作区。
func (store *Store) SaveWorkspace(ctx context.Context, workspace requirements.Workspace) error {
	paths, err := json.Marshal(workspace.ProjectPaths)
	if err != nil {
		return err
	}
	_, err = store.db.ExecContext(ctx, `
		INSERT INTO requirement_workspaces (id, name, project_paths, provider, model, account_ref, max_parallel, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name, project_paths=excluded.project_paths, provider=excluded.provider,
			model=excluded.model, account_ref=excluded.account_ref, max_parallel=excluded.max_parallel,
			updated_at_ms=excluded.updated_at_ms`,
		workspace.ID, workspace.Name, string(paths), workspace.Provider, workspace.Model, workspace.AccountRef, workspace.MaxParallel, workspace.CreatedAt, workspace.UpdatedAt)
	return err
}

// DeleteWorkspace 删除工作区。
func (store *Store) DeleteWorkspace(ctx context.Context, id string) error {
	_, err := store.db.ExecContext(ctx, `DELETE FROM requirement_workspaces WHERE id = ?`, strings.TrimSpace(id))
	return err
}

// ListRequirements 返回全部需求。
func (store *Store) ListRequirements(ctx context.Context) ([]requirements.Requirement, error) {
	rows, err := store.db.QueryContext(ctx, requirementSelect+` ORDER BY priority ASC, position ASC, created_at_ms ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []requirements.Requirement{}
	for rows.Next() {
		requirement, err := scanRequirement(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, requirement)
	}
	return out, rows.Err()
}

const requirementSelect = `
	SELECT id, title, description, status, priority, position, workspace_id, mode, parallel,
	       steps_json, refined_at_ms, progress, progress_note, session_id, peer_message_id, turn_id,
	       loop_count, last_error, source, created_at_ms, updated_at_ms, started_at_ms, completed_at_ms
	FROM requirements`

type scanner interface {
	Scan(dest ...any) error
}

func scanRequirement(row scanner) (requirements.Requirement, error) {
	var requirement requirements.Requirement
	var steps string
	var parallel int
	err := row.Scan(&requirement.ID, &requirement.Title, &requirement.Description, &requirement.Status,
		&requirement.Priority, &requirement.Position, &requirement.WorkspaceID, &requirement.Mode, &parallel,
		&steps, &requirement.RefinedAt, &requirement.Progress, &requirement.ProgressNote, &requirement.SessionID,
		&requirement.PeerMessageID, &requirement.TurnID, &requirement.LoopCount, &requirement.LastError,
		&requirement.Source, &requirement.CreatedAt, &requirement.UpdatedAt, &requirement.StartedAt, &requirement.CompletedAt)
	if err != nil {
		return requirements.Requirement{}, err
	}
	requirement.Parallel = parallel != 0
	if err := json.Unmarshal([]byte(steps), &requirement.Steps); err != nil || requirement.Steps == nil {
		requirement.Steps = []requirements.Step{}
	}
	return requirement, nil
}

// GetRequirement 按 ID 读取需求。
func (store *Store) GetRequirement(ctx context.Context, id string) (requirements.Requirement, error) {
	row := store.db.QueryRowContext(ctx, requirementSelect+` WHERE id = ? LIMIT 1`, strings.TrimSpace(id))
	requirement, err := scanRequirement(row)
	if errors.Is(err, sql.ErrNoRows) {
		return requirements.Requirement{}, fmt.Errorf("%w: 需求不存在", requirements.ErrNotFound)
	}
	return requirement, err
}

// SaveRequirement 插入或更新需求。
func (store *Store) SaveRequirement(ctx context.Context, requirement requirements.Requirement) error {
	steps, err := json.Marshal(requirement.Steps)
	if err != nil {
		return err
	}
	parallel := 0
	if requirement.Parallel {
		parallel = 1
	}
	_, err = store.db.ExecContext(ctx, `
		INSERT INTO requirements (
			id, title, description, status, priority, position, workspace_id, mode, parallel,
			steps_json, refined_at_ms, progress, progress_note, session_id, peer_message_id, turn_id,
			loop_count, last_error, source, created_at_ms, updated_at_ms, started_at_ms, completed_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title, description=excluded.description, status=excluded.status,
			priority=excluded.priority, position=excluded.position, workspace_id=excluded.workspace_id,
			mode=excluded.mode, parallel=excluded.parallel, steps_json=excluded.steps_json,
			refined_at_ms=excluded.refined_at_ms, progress=excluded.progress, progress_note=excluded.progress_note,
			session_id=excluded.session_id, peer_message_id=excluded.peer_message_id, turn_id=excluded.turn_id,
			loop_count=excluded.loop_count, last_error=excluded.last_error, source=excluded.source,
			updated_at_ms=excluded.updated_at_ms, started_at_ms=excluded.started_at_ms, completed_at_ms=excluded.completed_at_ms`,
		requirement.ID, requirement.Title, requirement.Description, requirement.Status, requirement.Priority,
		requirement.Position, requirement.WorkspaceID, requirement.Mode, parallel, string(steps),
		requirement.RefinedAt, requirement.Progress, requirement.ProgressNote, requirement.SessionID,
		requirement.PeerMessageID, requirement.TurnID, requirement.LoopCount, requirement.LastError,
		requirement.Source, requirement.CreatedAt, requirement.UpdatedAt, requirement.StartedAt, requirement.CompletedAt)
	return err
}

// AttachWorkSession 绑定执行会话并只在 queued 时推进到 running。
// CASE 表达式保证 Start 期间已经到达的 blocked/review 事件不会被覆盖。
func (store *Store) AttachWorkSession(ctx context.Context, id, sessionID, peerMessageID string, at int64) (requirements.Requirement, error) {
	_, err := store.db.ExecContext(ctx, `
		UPDATE requirements SET
			session_id = ?,
			peer_message_id = ?,
			status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
			progress = CASE WHEN status = 'queued' AND progress < 10 THEN 10 ELSE progress END,
			progress_note = CASE WHEN status = 'queued' THEN 'AI 已开始执行' ELSE progress_note END,
			started_at_ms = CASE WHEN started_at_ms = 0 THEN ? ELSE started_at_ms END,
			updated_at_ms = ?
		WHERE id = ?`, strings.TrimSpace(sessionID), strings.TrimSpace(peerMessageID), at, at, strings.TrimSpace(id))
	if err != nil {
		return requirements.Requirement{}, err
	}
	return store.GetRequirement(ctx, id)
}

// DeleteRequirement 删除需求。
func (store *Store) DeleteRequirement(ctx context.Context, id string) error {
	_, err := store.db.ExecContext(ctx, `DELETE FROM requirements WHERE id = ?`, strings.TrimSpace(id))
	return err
}

// AppendEvent 追加需求时间线。
func (store *Store) AppendEvent(ctx context.Context, event requirements.Event) error {
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO requirement_events (id, requirement_id, kind, message, at_ms) VALUES (?, ?, ?, ?, ?)`,
		event.ID, event.RequirementID, event.Kind, event.Message, event.At)
	return err
}

// ListEvents 读取需求时间线。
func (store *Store) ListEvents(ctx context.Context, requirementID string, limit int) ([]requirements.Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT id, requirement_id, kind, message, at_ms FROM requirement_events
		WHERE requirement_id = ? ORDER BY at_ms DESC LIMIT ?`, strings.TrimSpace(requirementID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []requirements.Event{}
	for rows.Next() {
		var event requirements.Event
		if err := rows.Scan(&event.ID, &event.RequirementID, &event.Kind, &event.Message, &event.At); err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	return out, rows.Err()
}

// GetSchedulerSettings 读取调度器设置；缺省时返回默认的 agy / gemini-4-neon-xhigh。
func (store *Store) GetSchedulerSettings(ctx context.Context) (requirements.SchedulerSettings, error) {
	var raw string
	err := store.db.QueryRowContext(ctx, `SELECT value FROM requirement_settings WHERE key = 'scheduler' LIMIT 1`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return requirements.DefaultSchedulerSettings(), nil
	}
	if err != nil {
		return requirements.SchedulerSettings{}, err
	}
	var settings requirements.SchedulerSettings
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		return requirements.DefaultSchedulerSettings(), nil
	}
	return settings.Normalized(), nil
}

// SaveSchedulerSettings 保存调度器设置。
func (store *Store) SaveSchedulerSettings(ctx context.Context, settings requirements.SchedulerSettings) error {
	raw, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = store.db.ExecContext(ctx, `
		INSERT INTO requirement_settings (key, value, updated_at_ms) VALUES ('scheduler', ?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at_ms=excluded.updated_at_ms`,
		string(raw), time.Now().UnixMilli())
	return err
}
