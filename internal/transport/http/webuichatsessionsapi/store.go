package webuichatsessionsapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	defaultTitle      = "新对话"
	defaultProvider   = "claude"
	canonicalMaxLimit = 500
)

var errChatSessionBusy = errors.New("chat_session_busy")

type canonicalPolicy struct {
	Archived        bool   `json:"archived"`
	LegacySessionID string `json:"legacySessionId"`
	Title           string `json:"title"`
	Model           string `json:"model"`
}

type canonicalBinding struct {
	NativeSessionID string `json:"nativeSessionId"`
}

type canonicalSummary struct {
	ID               string `json:"id"`
	RuntimeSessionID string `json:"runtimeSessionId"`
	ProjectPath      string `json:"projectPath"`
	Provider         string `json:"provider"`
	AccountRef       string `json:"accountRef"`
	Title            string `json:"title"`
	UpdatedAt        int64  `json:"updatedAt"`
	Model            string `json:"model"`
	Status           string `json:"status"`
}

type sessionRecord struct {
	updatedAt int64
	payload   any
}

type legacyChatSession struct {
	ID         string            `json:"id"`
	Title      string            `json:"title"`
	Provider   string            `json:"provider"`
	Model      string            `json:"model"`
	AccountRef string            `json:"accountRef"`
	CreatedAt  int64             `json:"createdAt"`
	UpdatedAt  int64             `json:"updatedAt"`
	Messages   []json.RawMessage `json:"messages"`
}

func (handler *Handler) chatDirs() []string {
	dirs := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	add := func(dir string) {
		trimmed := strings.TrimSpace(dir)
		if trimmed == "" {
			return
		}
		clean := filepath.Clean(trimmed)
		if _, ok := seen[clean]; ok {
			return
		}
		seen[clean] = struct{}{}
		dirs = append(dirs, clean)
	}
	if handler.aiHomeDir != "" {
		add(filepath.Join(handler.aiHomeDir, "chat-sessions"))
	}
	if handler.hostHomeDir != "" {
		add(filepath.Join(handler.hostHomeDir, ".ai_home", "chat-sessions"))
	}
	return dirs
}

func (handler *Handler) primaryChatDir() string {
	dirs := handler.chatDirs()
	if len(dirs) == 0 {
		return ""
	}
	return dirs[0]
}

func isSafeSessionID(sessionID string) bool {
	trimmed := strings.TrimSpace(sessionID)
	if trimmed == "" || strings.ContainsAny(trimmed, "/\\\x00") || strings.Contains(trimmed, "..") {
		return false
	}
	return filepath.Base(trimmed) == trimmed
}

func (handler *Handler) listMergedSessions(ctx context.Context) ([]any, error) {
	canonicalRecords, migratedIDs, err := handler.readCanonicalSummaries(ctx)
	if err != nil {
		return nil, err
	}

	legacyRecords := handler.readLegacySessions(migratedIDs)
	combined := make([]sessionRecord, 0, len(canonicalRecords)+len(legacyRecords))
	combined = append(combined, canonicalRecords...)
	combined = append(combined, legacyRecords...)

	sort.SliceStable(combined, func(left, right int) bool {
		return combined[left].updatedAt > combined[right].updatedAt
	})

	result := make([]any, 0, len(combined))
	for _, rec := range combined {
		result = append(result, rec.payload)
	}
	return result, nil
}

func (handler *Handler) readCanonicalSummaries(ctx context.Context) ([]sessionRecord, map[string]struct{}, error) {
	migrated := make(map[string]struct{})
	if handler.aiHomeDir == "" {
		return nil, migrated, nil
	}
	dbPath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return nil, migrated, nil
	}
	if _, statErr := os.Stat(dbPath); errors.Is(statErr, os.ErrNotExist) {
		return nil, migrated, nil
	}
	db, err := appstate.OpenReadOnly(ctx, dbPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, migrated, nil
		}
		return nil, nil, err
	}
	defer func() { _ = db.Close() }()

	if !sqliteTableExists(ctx, db, "chat_runtime_sessions") {
		return nil, migrated, nil
	}

	rows, err := db.QueryContext(ctx, `
		SELECT session_id, provider, execution_account_ref, project_path, state,
		       runtime_binding_json, policy_json, updated_at
		FROM chat_runtime_sessions
		WHERE project_path = ''
		ORDER BY updated_at DESC, session_id ASC
		LIMIT ?
	`, canonicalMaxLimit)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()

	records := make([]sessionRecord, 0)
	for rows.Next() {
		var (
			sessionID   string
			provider    string
			accountRef  string
			projectPath string
			state       string
			bindingJSON string
			policyJSON  string
			updatedAt   int64
		)
		if err := rows.Scan(&sessionID, &provider, &accountRef, &projectPath, &state, &bindingJSON, &policyJSON, &updatedAt); err != nil {
			return nil, nil, err
		}
		var binding canonicalBinding
		_ = json.Unmarshal([]byte(bindingJSON), &binding)
		var policy canonicalPolicy
		_ = json.Unmarshal([]byte(policyJSON), &policy)

		legacyID := strings.TrimSpace(policy.LegacySessionID)
		if legacyID != "" {
			migrated[legacyID] = struct{}{}
		}
		if policy.Archived {
			continue
		}
		if strings.TrimSpace(binding.NativeSessionID) == "" && legacyID == "" && policy.Title == defaultTitle {
			continue
		}
		title := policy.Title
		if title == "" {
			title = defaultTitle
		}
		records = append(records, sessionRecord{
			updatedAt: updatedAt,
			payload: canonicalSummary{
				ID:               sessionID,
				RuntimeSessionID: sessionID,
				ProjectPath:      projectPath,
				Provider:         provider,
				AccountRef:       accountRef,
				Title:            title,
				UpdatedAt:        updatedAt,
				Model:            policy.Model,
				Status:           state,
			},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return records, migrated, nil
}

func (handler *Handler) readLegacySessions(migrated map[string]struct{}) []sessionRecord {
	seenIDs := make(map[string]struct{})
	records := make([]sessionRecord, 0)
	for _, dir := range handler.chatDirs() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				continue
			}
			var decoded map[string]any
			if err := json.Unmarshal(raw, &decoded); err != nil {
				continue
			}
			id, _ := decoded["id"].(string)
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if _, ok := migrated[id]; ok {
				continue
			}
			if _, ok := seenIDs[id]; ok {
				continue
			}
			seenIDs[id] = struct{}{}
			records = append(records, sessionRecord{
				updatedAt: extractUpdatedAt(decoded["updatedAt"]),
				payload:   decoded,
			})
		}
	}
	return records
}

func extractUpdatedAt(raw any) int64 {
	switch value := raw.(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	default:
		return 0
	}
}

func (handler *Handler) readSingleLegacySession(sessionID string) (json.RawMessage, bool) {
	for _, dir := range handler.chatDirs() {
		raw, err := os.ReadFile(filepath.Join(dir, sessionID+".json"))
		if err != nil {
			continue
		}
		if !json.Valid(raw) {
			continue
		}
		return json.RawMessage(raw), true
	}
	return nil, false
}

func (handler *Handler) createLegacySession(req createSessionRequest) (*legacyChatSession, error) {
	dir := handler.primaryChatDir()
	if dir == "" {
		return nil, errors.New("chat-sessions 根目录不可用")
	}
	now := handler.nowMillis()
	sessionID := strings.TrimSpace(req.ID)
	if sessionID == "" {
		sessionID = fmt.Sprintf("chat-%d-%s", now, randomHex3())
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = defaultTitle
	}
	provider := strings.TrimSpace(req.Provider)
	if provider == "" {
		provider = defaultProvider
	}
	createdAt := req.CreatedAt
	if createdAt <= 0 {
		createdAt = now
	}
	messages := req.Messages
	if messages == nil {
		messages = make([]json.RawMessage, 0)
	}
	session := &legacyChatSession{
		ID:         sessionID,
		Title:      title,
		Provider:   provider,
		Model:      strings.TrimSpace(req.Model),
		AccountRef: strings.TrimSpace(req.AccountRef),
		CreatedAt:  createdAt,
		UpdatedAt:  now,
		Messages:   messages,
	}
	encoded, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	target := filepath.Join(dir, sessionID+".json")
	if err := writeFileAtomic(target, encoded); err != nil {
		return nil, err
	}
	return session, nil
}

func (handler *Handler) deleteSession(ctx context.Context, sessionID string) (bool, error) {
	deletedCanonical, err := handler.deleteCanonicalSession(ctx, sessionID)
	if err != nil {
		return false, err
	}
	if deletedCanonical {
		return true, nil
	}
	return handler.deleteLegacyFiles(sessionID), nil
}

func (handler *Handler) deleteCanonicalSession(ctx context.Context, sessionID string) (bool, error) {
	if handler.aiHomeDir == "" {
		return false, nil
	}
	dbPath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return false, nil
	}
	if _, statErr := os.Stat(dbPath); errors.Is(statErr, os.ErrNotExist) {
		return false, nil
	}

	db, err := appstate.OpenWritable(ctx, dbPath)
	if err != nil {
		return false, err
	}
	defer func() { _ = db.Close() }()

	if !sqliteTableExists(ctx, db, "chat_runtime_sessions") {
		return false, nil
	}
	// 必须在事务外开启外键级联，保证 DELETE chat_runtime_sessions 级联删除所有子表行。
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		return false, err
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	var (
		projectPath string
		state       string
		policyJSON  string
	)
	err = tx.QueryRowContext(ctx,
		`SELECT project_path, state, policy_json FROM chat_runtime_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&projectPath, &state, &policyJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// 与 Node 契约一致：工作区/项目会话不在本路由删除范围内，回退 legacy 检查。
	if strings.TrimSpace(projectPath) != "" {
		return false, nil
	}
	if state != "idle" && state != "closed" {
		return false, errChatSessionBusy
	}

	attachmentPaths := make([]string, 0)
	if sqliteTableExistsTx(ctx, tx, "chat_runtime_attachments") {
		rows, err := tx.QueryContext(ctx,
			`SELECT file_path FROM chat_runtime_attachments WHERE session_id = ?`,
			sessionID,
		)
		if err != nil {
			return false, err
		}
		for rows.Next() {
			var filePath string
			if err := rows.Scan(&filePath); err != nil {
				_ = rows.Close()
				return false, err
			}
			if trimmed := strings.TrimSpace(filePath); trimmed != "" {
				attachmentPaths = append(attachmentPaths, trimmed)
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return false, err
		}
		_ = rows.Close()
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM chat_runtime_sessions WHERE session_id = ?`, sessionID); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}

	cleanupAttachmentsBestEffort(attachmentPaths)
	var policy canonicalPolicy
	if err := json.Unmarshal([]byte(policyJSON), &policy); err == nil {
		legacyID := strings.TrimSpace(policy.LegacySessionID)
		if legacyID != "" && isSafeSessionID(legacyID) {
			handler.deleteLegacyFiles(legacyID)
		}
	}
	return true, nil
}

func (handler *Handler) deleteLegacyFiles(sessionID string) bool {
	if !isSafeSessionID(sessionID) {
		return false
	}
	deletedAny := false
	for _, dir := range handler.chatDirs() {
		target := filepath.Join(dir, sessionID+".json")
		if _, err := os.Stat(target); err == nil {
			if rmErr := os.Remove(target); rmErr == nil {
				deletedAny = true
			}
		}
	}
	return deletedAny
}

func cleanupAttachmentsBestEffort(paths []string) {
	seen := make(map[string]struct{}, len(paths))
	for _, raw := range paths {
		if raw == "" {
			continue
		}
		if _, ok := seen[raw]; ok {
			continue
		}
		seen[raw] = struct{}{}
		_ = os.RemoveAll(raw + ".frames")
		_ = os.Remove(raw)
	}
}

func sqliteTableExists(ctx context.Context, db *sql.DB, name string) bool {
	var count int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
	).Scan(&count); err != nil {
		return false
	}
	return count > 0
}

func sqliteTableExistsTx(ctx context.Context, tx *sql.Tx, name string) bool {
	var count int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
	).Scan(&count); err != nil {
		return false
	}
	return count > 0
}

func writeFileAtomic(target string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}
	if _, err := temp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := temp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	if err := os.Rename(tempName, target); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	return nil
}

func randomHex3() string {
	var buf [3]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%06x", time.Now().UnixNano()&0xffffff)
	}
	return hex.EncodeToString(buf[:])
}
