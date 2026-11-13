// Package imagestudio 实现 AI 生图工作台的会话持久化、模型目录、图片资产实体化与运行编排。
package imagestudio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// StoreVersion 对齐 Node STORE_VERSION = 2。
	StoreVersion = 2
	// MaxStudioAssetBytes 限制单张持久化图片资产最大为 20 MiB。
	MaxStudioAssetBytes = 20 * 1024 * 1024
	// DefaultSessionTitle 是新建或未命名会话的默认标题。
	DefaultSessionTitle = "未命名影像会话"
	// AssetBasePath 是前端访问资产二进制文件的公开路径前缀。
	AssetBasePath = "/v0/webui/studio/image"
)

var (
	sessionIDPattern  = regexp.MustCompile(`(?i)^img_[0-9a-f-]{36}$`)
	revisionIDPattern = regexp.MustCompile(`(?i)^rev_[0-9a-f-]{36}$`)
	assetIDPattern    = regexp.MustCompile(`(?i)^asset_[0-9a-f-]{36}$`)

	supportedAssetMIMEs = map[string]struct{}{
		"image/png":  {},
		"image/jpeg": {},
		"image/jpg":  {},
		"image/webp": {},
		"image/gif":  {},
	}
)

// Error 描述可映射为 HTTP 响应的 Image Studio 业务错误。
type Error struct {
	StatusCode int
	Code       string
	Detail     string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Detail != "" {
		return e.Detail
	}
	return e.Code
}

// NewError 构造指定 HTTP 状态码、错误码与说明的 Image Studio 错误。
func NewError(statusCode int, code string, detail string) *Error {
	if statusCode <= 0 {
		statusCode = 500
	}
	if strings.TrimSpace(code) == "" {
		code = "image_studio_error"
	}
	if strings.TrimSpace(detail) == "" {
		detail = code
	}
	return &Error{
		StatusCode: statusCode,
		Code:       code,
		Detail:     detail,
	}
}

// RevisionParameters 记录单次生成/编辑修订版本的参数快照。
type RevisionParameters struct {
	N                 int    `json:"n"`
	Size              string `json:"size"`
	Quality           string `json:"quality"`
	Background        string `json:"background"`
	OutputFormat      string `json:"outputFormat"`
	OutputCompression *int   `json:"outputCompression"`
	Moderation        string `json:"moderation"`
}

// RevisionError 描述失败修订版本的错误信息。
type RevisionError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"statusCode"`
}

// Revision 表示工作台会话内的一次出图或编辑修订。
type Revision struct {
	ID               string             `json:"id"`
	ParentRevisionID string             `json:"parentRevisionId"`
	Mode             string             `json:"mode"`
	Prompt           string             `json:"prompt"`
	Provider         string             `json:"provider"`
	Model            string             `json:"model"`
	ModelKey         string             `json:"modelKey"`
	Parameters       RevisionParameters `json:"parameters"`
	SourceAssetIDs   []string           `json:"sourceAssetIds"`
	MaskAssetID      string             `json:"maskAssetId"`
	OutputAssetIDs   []string           `json:"outputAssetIds"`
	Status           string             `json:"status"`
	CreatedAt        int64              `json:"createdAt"`
	CompletedAt      int64              `json:"completedAt"`
	AccountRef       string             `json:"accountRef"`
	Error            *RevisionError     `json:"error"`
}

// Asset 描述与工作台会话绑定的持久化图片元数据（不含大字节正文）。
type Asset struct {
	ID            string `json:"id"`
	RevisionID    string `json:"revisionId"`
	Role          string `json:"role"`
	MIME          string `json:"mimeType"`
	ByteLength    int    `json:"byteLength"`
	CreatedAt     int64  `json:"createdAt"`
	RevisedPrompt string `json:"revisedPrompt,omitempty"`
	URL           string `json:"url"`
}

// Session 是工作台会话的完整持久化视图。
type Session struct {
	Version          int        `json:"version"`
	ID               string     `json:"id"`
	Title            string     `json:"title"`
	CreatedAt        int64      `json:"createdAt"`
	UpdatedAt        int64      `json:"updatedAt"`
	ActiveRevisionID string     `json:"activeRevisionId"`
	Revisions        []Revision `json:"revisions"`
	Assets           []Asset    `json:"assets"`
}

// SessionSummary 是会话列表页使用的摘要投影。
type SessionSummary struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	CreatedAt        int64  `json:"createdAt"`
	UpdatedAt        int64  `json:"updatedAt"`
	RevisionCount    int    `json:"revisionCount"`
	AssetCount       int    `json:"assetCount"`
	ActiveRevisionID string `json:"activeRevisionId"`
	LatestStatus     string `json:"latestStatus"`
	LatestModel      string `json:"latestModel"`
	LatestProvider   string `json:"latestProvider"`
	PreviewAssetID   string `json:"previewAssetId"`
	PreviewMIMEType  string `json:"previewMimeType"`
	PreviewURL       string `json:"previewUrl"`
}

// StoredImage 描述即将写入或刚从数据库读出的二进制图片负载。
type StoredImage struct {
	MIME          string
	Bytes         []byte
	RevisedPrompt string
}

// RevisionSourceInput 描述开始一次修订时的单张参考图来源。
type RevisionSourceInput struct {
	AssetID string
	Image   *StoredImage
}

// BeginRevisionInput 描述发起一次新修订的持久化输入。
type BeginRevisionInput struct {
	Mode             string
	Provider         string
	Model            string
	ModelKey         string
	Prompt           string
	ParentRevisionID string
	Sources          []RevisionSourceInput
	MaskAssetID      string
	MaskImage        *StoredImage
	Parameters       RevisionParameters
}

// AssetURL 生成浏览器访问单张持久化图片资产的相对 URL。
func AssetURL(sessionID string, assetID string) string {
	return fmt.Sprintf(
		"%s/sessions/%s/assets/%s",
		AssetBasePath,
		url.PathEscape(sessionID),
		url.PathEscape(assetID),
	)
}

// StoreOptions 配置基于 SQLite app-state.db 的工作台仓储。
type StoreOptions struct {
	AIHomeDir    string
	DatabasePath string
	Now          func() time.Time
}

// Store 线程安全地管理 Image Studio 会话、修订记录与二进制图片资产。
type Store struct {
	dbPath string
	now    func() time.Time
	mu     sync.Mutex
}

const studioSchemaSQL = `
CREATE TABLE IF NOT EXISTS image_studio_sessions (
  session_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS image_studio_assets (
  asset_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES image_studio_sessions(session_id) ON DELETE CASCADE,
  content BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_studio_sessions_updated ON image_studio_sessions(updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_studio_assets_session ON image_studio_assets(session_id, created_at);
`

// NewStore 初始化数据库表结构并恢复服务端重启前遗留的 running 修订状态。
func NewStore(opts StoreOptions) (*Store, error) {
	dbPath := strings.TrimSpace(opts.DatabasePath)
	if dbPath == "" && strings.TrimSpace(opts.AIHomeDir) != "" {
		resolved, err := appstate.DatabasePath(strings.TrimSpace(opts.AIHomeDir))
		if err != nil {
			return nil, err
		}
		dbPath = resolved
	}
	if dbPath == "" {
		return nil, NewError(500, "image_studio_home_missing", "AIH home directory is required")
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, err
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	store := &Store{dbPath: dbPath, now: nowFn}
	if err := store.initAndRecover(context.Background()); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) nowMS() int64 {
	if s == nil || s.now == nil {
		return time.Now().UnixMilli()
	}
	return s.now().UnixMilli()
}

// withSerializedTx 在进程内互斥锁下开启 SQLite 读写或只读事务。
func (s *Store) withSerializedTx(ctx context.Context, write bool, fn func(tx *sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	db, err := appstate.OpenWritable(ctx, s.dbPath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON;"); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, studioSchemaSQL); err != nil {
		return err
	}

	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: !write})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) initAndRecover(ctx context.Context) error {
	return s.withSerializedTx(ctx, true, func(tx *sql.Tx) error {
		recoveredAt := s.nowMS()
		rows, err := tx.QueryContext(ctx, "SELECT payload_json FROM image_studio_sessions")
		if err != nil {
			return err
		}
		var payloads []string
		for rows.Next() {
			var raw string
			if scanErr := rows.Scan(&raw); scanErr == nil {
				payloads = append(payloads, raw)
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()

		for _, raw := range payloads {
			session, ok := parseSessionPayload(raw)
			if !ok || !sessionIDPattern.MatchString(session.ID) {
				continue
			}
			changed := false
			for i := range session.Revisions {
				if session.Revisions[i].Status != "running" {
					continue
				}
				session.Revisions[i].Status = "failed"
				session.Revisions[i].CompletedAt = recoveredAt
				session.Revisions[i].Error = &RevisionError{
					Code:       "image_studio_run_interrupted",
					Message:    "image Studio run was interrupted because the server restarted",
					StatusCode: 503,
				}
				changed = true
			}
			if changed {
				session.UpdatedAt = recoveredAt
				if err := updateSessionTx(ctx, tx, session); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// CreateSession 创建一条新的空 Image Studio 会话。
func (s *Store) CreateSession(ctx context.Context, title string) (Session, error) {
	var created Session
	err := s.withSerializedTx(ctx, true, func(tx *sql.Tx) error {
		nowMS := s.nowMS()
		created = Session{
			Version:          StoreVersion,
			ID:               "img_" + uuid.NewString(),
			Title:            normalizeTitle(title),
			CreatedAt:        nowMS,
			UpdatedAt:        nowMS,
			ActiveRevisionID: "",
			Revisions:        []Revision{},
			Assets:           []Asset{},
		}
		raw, err := json.Marshal(created)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(
			ctx,
			"INSERT INTO image_studio_sessions (session_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
			created.ID, string(raw), created.CreatedAt, created.UpdatedAt,
		)
		return err
	})
	return created, err
}

// ListSessions 按最近更新时间倒序返回工作台会话摘要列表。
func (s *Store) ListSessions(ctx context.Context) ([]SessionSummary, error) {
	summaries := make([]SessionSummary, 0)
	err := s.withSerializedTx(ctx, false, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(
			ctx,
			"SELECT payload_json FROM image_studio_sessions ORDER BY updated_at DESC, created_at DESC, session_id",
		)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()

		for rows.Next() {
			var raw string
			if scanErr := rows.Scan(&raw); scanErr != nil {
				continue
			}
			session, ok := parseSessionPayload(raw)
			if !ok || !sessionIDPattern.MatchString(session.ID) {
				continue
			}
			summaries = append(summaries, summarizeSession(session))
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(summaries, func(i, j int) bool {
		if summaries[j].UpdatedAt != summaries[i].UpdatedAt {
			return summaries[j].UpdatedAt < summaries[i].UpdatedAt
		}
		return summaries[j].CreatedAt < summaries[i].CreatedAt
	})
	return summaries, nil
}

// GetSession 按会话 ID 读取完整的 Image Studio 会话详情。
func (s *Store) GetSession(ctx context.Context, sessionID string) (Session, error) {
	var session Session
	err := s.withSerializedTx(ctx, false, func(tx *sql.Tx) error {
		loaded, readErr := readSessionTx(ctx, tx, sessionID)
		if readErr != nil {
			return readErr
		}
		session = loaded
		return nil
	})
	return session, err
}

// RenameSession 修改会话标题并更新 updatedAt 时间戳。
func (s *Store) RenameSession(ctx context.Context, sessionID string, title string) (Session, error) {
	var updated Session
	err := s.withSerializedTx(ctx, true, func(tx *sql.Tx) error {
		session, readErr := readSessionTx(ctx, tx, sessionID)
		if readErr != nil {
			return readErr
		}
		session.Title = normalizeTitle(title)
		session.UpdatedAt = s.nowMS()
		if err := updateSessionTx(ctx, tx, session); err != nil {
			return err
		}
		updated = session
		return nil
	})
	return updated, err
}

// DeleteSession 删除会话及其所有图片资产；若有修订正在运行中返回 409。
func (s *Store) DeleteSession(ctx context.Context, sessionID string) (Session, error) {
	var deleted Session
	err := s.withSerializedTx(ctx, true, func(tx *sql.Tx) error {
		session, readErr := readSessionTx(ctx, tx, sessionID)
		if readErr != nil {
			return readErr
		}
		for _, rev := range session.Revisions {
			if rev.Status == "running" {
				return NewError(409, "image_session_running", "image session has a running revision")
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM image_studio_assets WHERE session_id = ?", session.ID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, "DELETE FROM image_studio_sessions WHERE session_id = ?", session.ID)
		if err != nil {
			return err
		}
		affected, _ := res.RowsAffected()
		if affected < 1 {
			return NewError(404, "image_session_not_found", "image session "+session.ID+" was not found")
		}
		deleted = session
		return nil
	})
	return deleted, err
}

// BeginRevision 写入 source/mask 资产并创建状态为 running 的新修订记录。
func (s *Store) BeginRevision(ctx context.Context, sessionID string, input BeginRevisionInput) (Session, Revision, error) {
	var outSession Session
	var outRev Revision

	err := s.withSerializedTx(ctx, true, func(tx *sql.Tx) error {
		session, readErr := readSessionTx(ctx, tx, sessionID)
		if readErr != nil {
			return readErr
		}
		mode := "generation"
		if input.Mode == "edit" {
			mode = "edit"
		}
		prompt := normalizeText(input.Prompt, 12000)
		model := normalizeText(input.Model, 160)
		provider := strings.ToLower(normalizeText(input.Provider, 64))
		if prompt == "" {
			return NewError(400, "prompt_required", "prompt is required")
		}
		if model == "" {
			return NewError(400, "model_required", "model is required")
		}
		if provider == "" {
			return NewError(400, "provider_required", "provider is required")
		}

		revID := "rev_" + uuid.NewString()
		maskAssetID := normalizeText(input.MaskAssetID, 80)
		if maskAssetID != "" {
			if _, err := findAsset(session, maskAssetID); err != nil {
				return err
			}
		}
		if mode == "edit" && len(input.Sources) < 1 {
			return NewError(400, "image_required", "an image asset is required for image edits")
		}
		parentRevID := normalizeText(input.ParentRevisionID, 80)
		if parentRevID != "" {
			foundParent := false
			for _, rev := range session.Revisions {
				if rev.ID == parentRevID {
					foundParent = true
					break
				}
			}
			if !foundParent {
				return NewError(400, "invalid_parent_revision", "parent revision does not exist in this session")
			}
		}

		newAssets := make([]Asset, 0, len(input.Sources)+1)
		sourceAssetIDs := make([]string, 0, len(input.Sources))
		for _, src := range input.Sources {
			assetID := normalizeText(src.AssetID, 80)
			if assetID != "" && src.Image != nil {
				return NewError(400, "ambiguous_image_input", "each source must use either assetId or image")
			}
			if assetID != "" {
				if _, err := findAsset(session, assetID); err != nil {
					return err
				}
				sourceAssetIDs = append(sourceAssetIDs, assetID)
				continue
			}
			if src.Image != nil {
				asset, err := insertAssetTx(ctx, tx, session.ID, revID, "source", *src.Image, s.nowMS())
				if err != nil {
					return err
				}
				newAssets = append(newAssets, asset)
				sourceAssetIDs = append(sourceAssetIDs, asset.ID)
				continue
			}
			return NewError(400, "invalid_image_source", "each source must include assetId or image")
		}
		if input.MaskImage != nil {
			asset, err := insertAssetTx(ctx, tx, session.ID, revID, "mask", *input.MaskImage, s.nowMS())
			if err != nil {
				return err
			}
			newAssets = append(newAssets, asset)
			maskAssetID = asset.ID
		}

		createdAt := s.nowMS()
		modelKey := normalizeText(input.ModelKey, 240)
		if modelKey == "" {
			modelKey = provider + ":" + model
		}
		nVal := input.Parameters.N
		if nVal < 1 {
			nVal = 1
		}
		var compPtr *int
		if input.Parameters.OutputCompression != nil {
			c := *input.Parameters.OutputCompression
			if c >= 0 && c <= 100 {
				compPtr = &c
			}
		}
		rev := Revision{
			ID:               revID,
			ParentRevisionID: parentRevID,
			Mode:             mode,
			Prompt:           prompt,
			Provider:         provider,
			Model:            model,
			ModelKey:         modelKey,
			Parameters: RevisionParameters{
				N:                 nVal,
				Size:              normalizeText(input.Parameters.Size, 40),
				Quality:           normalizeText(input.Parameters.Quality, 40),
				Background:        normalizeText(input.Parameters.Background, 40),
				OutputFormat:      normalizeText(input.Parameters.OutputFormat, 40),
				OutputCompression: compPtr,
				Moderation:        normalizeText(input.Parameters.Moderation, 40),
			},
			SourceAssetIDs: sourceAssetIDs,
			MaskAssetID:    maskAssetID,
			OutputAssetIDs: []string{},
			Status:         "running",
			CreatedAt:      createdAt,
			CompletedAt:    0,
			AccountRef:     "",
			Error:          nil,
		}

		session.Revisions = append(session.Revisions, rev)
		session.Assets = append(session.Assets, newAssets...)
		session.ActiveRevisionID = revID
		session.UpdatedAt = createdAt
		if len(session.Revisions) == 1 && normalizeTitle(session.Title) == DefaultSessionTitle {
			session.Title = normalizeTitle(prompt)
		}
		hydrateSessionURLs(&session)
		if err := updateSessionTx(ctx, tx, session); err != nil {
			return err
		}
		outSession = session
		outRev = rev
		return nil
	})
	return outSession, outRev, err
}

// CompleteRevision 持久化生成的输出图片资产，并将 running 修订推进至 succeeded。
func (s *Store) CompleteRevision(
	ctx context.Context,
	sessionID string,
	revisionID string,
	accountRef string,
	images []StoredImage,
) (Session, Revision, error) {
	if len(images) < 1 {
		return Session{}, Revision{}, NewError(502, "image_output_missing", "image generation returned no persistent output")
	}
	var outSession Session
	var outRev Revision

	err := s.withSerializedTx(ctx, true, func(tx *sql.Tx) error {
		session, readErr := readSessionTx(ctx, tx, sessionID)
		if readErr != nil {
			return readErr
		}
		revIdx, err := findRevisionIndex(session, revisionID)
		if err != nil {
			return err
		}
		if session.Revisions[revIdx].Status != "running" {
			return NewError(409, "image_revision_not_running", "image revision is already settled")
		}
		outputIDs := make([]string, 0, len(images))
		writtenAssets := make([]Asset, 0, len(images))
		for _, img := range images {
			asset, insertErr := insertAssetTx(ctx, tx, session.ID, session.Revisions[revIdx].ID, "output", img, s.nowMS())
			if insertErr != nil {
				return insertErr
			}
			writtenAssets = append(writtenAssets, asset)
			outputIDs = append(outputIDs, asset.ID)
		}
		completedAt := s.nowMS()
		session.Assets = append(session.Assets, writtenAssets...)
		session.Revisions[revIdx].OutputAssetIDs = outputIDs
		session.Revisions[revIdx].Status = "succeeded"
		session.Revisions[revIdx].CompletedAt = completedAt
		session.Revisions[revIdx].AccountRef = normalizeText(accountRef, 120)
		session.Revisions[revIdx].Error = nil
		if session.ActiveRevisionID == "" {
			session.ActiveRevisionID = session.Revisions[revIdx].ID
		}
		session.UpdatedAt = completedAt
		hydrateSessionURLs(&session)
		if err := updateSessionTx(ctx, tx, session); err != nil {
			return err
		}
		outSession = session
		outRev = session.Revisions[revIdx]
		return nil
	})
	return outSession, outRev, err
}

// FailRevision 把处于 running 状态的修订标记为 failed 并记录错误详情。
func (s *Store) FailRevision(
	ctx context.Context,
	sessionID string,
	revisionID string,
	cause error,
) (Session, Revision, error) {
	var outSession Session
	var outRev Revision
	err := s.withSerializedTx(ctx, true, func(tx *sql.Tx) error {
		session, readErr := readSessionTx(ctx, tx, sessionID)
		if readErr != nil {
			return readErr
		}
		revIdx, err := findRevisionIndex(session, revisionID)
		if err != nil {
			return err
		}
		if session.Revisions[revIdx].Status != "running" {
			return NewError(409, "image_revision_not_running", "image revision is already settled")
		}
		completedAt := s.nowMS()
		errCode := "image_generation_failed"
		errMsg := "image generation failed"
		errStatus := 500
		if cause != nil {
			var studioErr *Error
			if errors.As(cause, &studioErr) {
				errCode = normalizeText(studioErr.Code, 120)
				errMsg = normalizeText(studioErr.Detail, 1000)
				if studioErr.StatusCode > 0 {
					errStatus = studioErr.StatusCode
				}
			} else {
				if msg := normalizeText(cause.Error(), 1000); msg != "" {
					errMsg = msg
				}
			}
		}
		session.Revisions[revIdx].Status = "failed"
		session.Revisions[revIdx].CompletedAt = completedAt
		session.Revisions[revIdx].Error = &RevisionError{
			Code:       errCode,
			Message:    errMsg,
			StatusCode: errStatus,
		}
		session.UpdatedAt = completedAt
		hydrateSessionURLs(&session)
		if err := updateSessionTx(ctx, tx, session); err != nil {
			return err
		}
		outSession = session
		outRev = session.Revisions[revIdx]
		return nil
	})
	return outSession, outRev, err
}

// ReadAsset 从持久化存储读取指定资产的元数据及完整字节流。
func (s *Store) ReadAsset(ctx context.Context, sessionID string, assetID string) (Asset, []byte, error) {
	var outAsset Asset
	var outBytes []byte
	err := s.withSerializedTx(ctx, false, func(tx *sql.Tx) error {
		session, readErr := readSessionTx(ctx, tx, sessionID)
		if readErr != nil {
			return readErr
		}
		asset, err := findAsset(session, assetID)
		if err != nil {
			return err
		}
		var content []byte
		var byteLen int
		row := tx.QueryRowContext(
			ctx,
			"SELECT content, byte_length FROM image_studio_assets WHERE asset_id = ? AND session_id = ?",
			asset.ID, session.ID,
		)
		if scanErr := row.Scan(&content, &byteLen); scanErr != nil {
			if errors.Is(scanErr, sql.ErrNoRows) {
				return NewError(404, "image_asset_not_found", "image asset "+asset.ID+" was not found")
			}
			return scanErr
		}
		if len(content) != byteLen || len(content) != asset.ByteLength {
			return NewError(500, "image_asset_corrupt", "image asset content length is inconsistent")
		}
		outAsset = asset
		outBytes = content
		return nil
	})
	return outAsset, outBytes, err
}

func readSessionTx(ctx context.Context, tx *sql.Tx, rawSessionID string) (Session, error) {
	id, err := assertID(rawSessionID, sessionIDPattern, "invalid_image_session_id")
	if err != nil {
		return Session{}, err
	}
	var raw string
	err = tx.QueryRowContext(ctx, "SELECT payload_json FROM image_studio_sessions WHERE session_id = ?", id).Scan(&raw)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Session{}, NewError(404, "image_session_not_found", "image session "+id+" was not found")
		}
		return Session{}, err
	}
	session, ok := parseSessionPayload(raw)
	if !ok || session.ID != id {
		return Session{}, NewError(404, "image_session_not_found", "image session "+id+" was not found")
	}
	return session, nil
}

func updateSessionTx(ctx context.Context, tx *sql.Tx, session Session) error {
	raw, err := json.Marshal(session)
	if err != nil {
		return err
	}
	res, err := tx.ExecContext(
		ctx,
		"UPDATE image_studio_sessions SET payload_json = ?, created_at = ?, updated_at = ? WHERE session_id = ?",
		string(raw), session.CreatedAt, session.UpdatedAt, session.ID,
	)
	if err != nil {
		return err
	}
	affected, _ := res.RowsAffected()
	if affected < 1 {
		return NewError(404, "image_session_not_found", "image session "+session.ID+" was not found")
	}
	return nil
}

func insertAssetTx(
	ctx context.Context,
	tx *sql.Tx,
	sessionID string,
	revisionID string,
	role string,
	img StoredImage,
	createdAt int64,
) (Asset, error) {
	mimeType := normalizeStoreMIME(img.MIME)
	if mimeType == "" {
		return Asset{}, NewError(400, "invalid_image_asset_mime", "image asset mime type is not supported")
	}
	if len(img.Bytes) < 1 {
		return Asset{}, NewError(400, "empty_image_asset", "image asset is empty")
	}
	if len(img.Bytes) > MaxStudioAssetBytes {
		return Asset{}, NewError(413, "image_asset_too_large", "image asset exceeds 20 MiB limit")
	}
	assetID := "asset_" + uuid.NewString()
	_, err := tx.ExecContext(
		ctx,
		"INSERT INTO image_studio_assets (asset_id, session_id, content, byte_length, created_at) VALUES (?, ?, ?, ?, ?)",
		assetID, sessionID, img.Bytes, len(img.Bytes), createdAt,
	)
	if err != nil {
		return Asset{}, err
	}
	return Asset{
		ID:            assetID,
		RevisionID:    revisionID,
		Role:          role,
		MIME:          mimeType,
		ByteLength:    len(img.Bytes),
		CreatedAt:     createdAt,
		RevisedPrompt: normalizeText(img.RevisedPrompt, 12000),
		URL:           AssetURL(sessionID, assetID),
	}, nil
}

func findAsset(session Session, rawAssetID string) (Asset, error) {
	id, err := assertID(rawAssetID, assetIDPattern, "invalid_image_asset_id")
	if err != nil {
		return Asset{}, err
	}
	for _, asset := range session.Assets {
		if asset.ID == id {
			return asset, nil
		}
	}
	return Asset{}, NewError(404, "image_asset_not_found", "image asset "+id+" was not found")
}

func findRevisionIndex(session Session, rawRevisionID string) (int, error) {
	id, err := assertID(rawRevisionID, revisionIDPattern, "invalid_image_revision_id")
	if err != nil {
		return -1, err
	}
	for i, rev := range session.Revisions {
		if rev.ID == id {
			return i, nil
		}
	}
	return -1, NewError(404, "image_revision_not_found", "image revision "+id+" was not found")
}

func parseSessionPayload(raw string) (Session, bool) {
	if strings.TrimSpace(raw) == "" {
		return Session{}, false
	}
	// 先兼容读取旧版可能带 sourceAssetId 的 payload_json
	var rawMap struct {
		Version          int               `json:"version"`
		ID               string            `json:"id"`
		Title            string            `json:"title"`
		CreatedAt        int64             `json:"createdAt"`
		UpdatedAt        int64             `json:"updatedAt"`
		ActiveRevisionID string            `json:"activeRevisionId"`
		Revisions        []json.RawMessage `json:"revisions"`
		Assets           []Asset           `json:"assets"`
	}
	if err := json.Unmarshal([]byte(raw), &rawMap); err != nil || strings.TrimSpace(rawMap.ID) == "" {
		return Session{}, false
	}

	revs := make([]Revision, 0, len(rawMap.Revisions))
	for _, item := range rawMap.Revisions {
		var rev Revision
		if err := json.Unmarshal(item, &rev); err != nil {
			continue
		}
		var legacy struct {
			SourceAssetID string `json:"sourceAssetId"`
		}
		if json.Unmarshal(item, &legacy) == nil && len(rev.SourceAssetIDs) == 0 && strings.TrimSpace(legacy.SourceAssetID) != "" {
			rev.SourceAssetIDs = []string{normalizeText(legacy.SourceAssetID, 80)}
		}
		if rev.SourceAssetIDs == nil {
			rev.SourceAssetIDs = []string{}
		}
		if rev.OutputAssetIDs == nil {
			rev.OutputAssetIDs = []string{}
		}
		if rev.Parameters.N < 1 {
			rev.Parameters.N = 1
		}
		revs = append(revs, rev)
	}
	assets := rawMap.Assets
	if assets == nil {
		assets = []Asset{}
	}
	out := Session{
		Version:          StoreVersion,
		ID:               normalizeText(rawMap.ID, 80),
		Title:            normalizeTitle(rawMap.Title),
		CreatedAt:        rawMap.CreatedAt,
		UpdatedAt:        rawMap.UpdatedAt,
		ActiveRevisionID: normalizeText(rawMap.ActiveRevisionID, 80),
		Revisions:        revs,
		Assets:           assets,
	}
	hydrateSessionURLs(&out)
	return out, true
}

func hydrateSessionURLs(session *Session) {
	if session == nil {
		return
	}
	if session.Revisions == nil {
		session.Revisions = []Revision{}
	}
	if session.Assets == nil {
		session.Assets = []Asset{}
	}
	for i := range session.Revisions {
		if session.Revisions[i].SourceAssetIDs == nil {
			session.Revisions[i].SourceAssetIDs = []string{}
		}
		if session.Revisions[i].OutputAssetIDs == nil {
			session.Revisions[i].OutputAssetIDs = []string{}
		}
	}
	for i := range session.Assets {
		if session.Assets[i].MIME == "" {
			session.Assets[i].MIME = "image/png"
		}
		session.Assets[i].URL = AssetURL(session.ID, session.Assets[i].ID)
	}
}

func summarizeSession(session Session) SessionSummary {
	var latestStatus, latestModel, latestProvider string
	if n := len(session.Revisions); n > 0 {
		latest := session.Revisions[n-1]
		latestStatus = normalizeText(latest.Status, 32)
		latestModel = normalizeText(latest.Model, 160)
		latestProvider = normalizeText(latest.Provider, 64)
	}
	previewAssetID := ""
	for i := len(session.Revisions) - 1; i >= 0; i-- {
		outs := session.Revisions[i].OutputAssetIDs
		for j := len(outs) - 1; j >= 0; j-- {
			if outs[j] != "" {
				previewAssetID = outs[j]
				break
			}
		}
		if previewAssetID != "" {
			break
		}
	}
	previewMIME := "image/png"
	previewURL := ""
	if previewAssetID != "" {
		previewURL = AssetURL(session.ID, previewAssetID)
		for _, a := range session.Assets {
			if a.ID == previewAssetID {
				if norm := normalizeStoreMIME(a.MIME); norm != "" {
					previewMIME = norm
				}
				break
			}
		}
	}
	return SessionSummary{
		ID:               session.ID,
		Title:            normalizeTitle(session.Title),
		CreatedAt:        session.CreatedAt,
		UpdatedAt:        session.UpdatedAt,
		RevisionCount:    len(session.Revisions),
		AssetCount:       len(session.Assets),
		ActiveRevisionID: normalizeText(session.ActiveRevisionID, 80),
		LatestStatus:     latestStatus,
		LatestModel:      latestModel,
		LatestProvider:   latestProvider,
		PreviewAssetID:   previewAssetID,
		PreviewMIMEType:  previewMIME,
		PreviewURL:       previewURL,
	}
}

func normalizeText(value string, maxRunes int) string {
	trimmed := strings.TrimSpace(value)
	if maxRunes <= 0 {
		return trimmed
	}
	runes := []rune(trimmed)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes])
	}
	return trimmed
}

func normalizeTitle(value string) string {
	title := normalizeText(value, 120)
	if title == "" {
		return DefaultSessionTitle
	}
	return title
}

func normalizeStoreMIME(value string) string {
	mimeType := strings.ToLower(normalizeText(value, 80))
	if _, ok := supportedAssetMIMEs[mimeType]; ok {
		return mimeType
	}
	return ""
}

func assertID(raw string, pattern *regexp.Regexp, code string) (string, error) {
	id := normalizeText(raw, 80)
	if !pattern.MatchString(id) {
		readable := strings.ReplaceAll(strings.TrimPrefix(code, "invalid_"), "_", " ")
		return "", NewError(400, code, "invalid "+readable)
	}
	return id, nil
}
