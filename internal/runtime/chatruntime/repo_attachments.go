package chatruntime

import (
	"context"
	"database/sql"
	"net/http"
)

// AttachmentInput 描述待记录到数据库的附件文件元信息。
type AttachmentInput struct {
	FilePath string
	Name     string
	MimeType string
}

// AttachmentRepository 管理 chat_runtime_attachments 元数据持久化与克隆。
type AttachmentRepository struct {
	db        *Database
	sessions  *SessionRepository
	idFactory func(string) string
}

func newAttachmentRepository(db *Database, sessions *SessionRepository, idFactory func(string) string) *AttachmentRepository {
	return &AttachmentRepository{db: db, sessions: sessions, idFactory: idFactory}
}

func (r *AttachmentRepository) CreateMany(ctx context.Context, sessionID string, inputs []AttachmentInput) ([]Attachment, error) {
	if len(inputs) == 0 {
		return nil, ErrInvalid("chat_attachments_required")
	}
	normalized := make([]Attachment, 0, len(inputs))
	now := r.db.clock()
	for _, in := range inputs {
		filePath, err := RequiredText(in.FilePath, "chat_attachment_path_required")
		if err != nil {
			return nil, err
		}
		name, err := RequiredText(in.Name, "chat_attachment_name_required")
		if err != nil {
			return nil, err
		}
		mimeType, err := RequiredText(in.MimeType, "chat_attachment_mime_required")
		if err != nil {
			return nil, err
		}
		normalized = append(normalized, Attachment{
			AttachmentID: r.idFactory("attachment"),
			SessionID:    sessionID,
			Name:         name,
			MimeType:     mimeType,
			CreatedAt:    now,
			FilePath:     filePath,
		})
	}

	err := r.db.withTx(ctx, func(tx *sql.Tx) error {
		session, err := r.sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		for i := range normalized {
			normalized[i].SessionID = session.SessionID
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO chat_runtime_attachments (
					attachment_id, session_id, file_path, name, mime_type, created_at
				) VALUES (?, ?, ?, ?, ?, ?)
			`, normalized[i].AttachmentID, session.SessionID, normalized[i].FilePath, normalized[i].Name, normalized[i].MimeType, normalized[i].CreatedAt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return normalized, nil
}

func (r *AttachmentRepository) ResolvePaths(ctx context.Context, sessionID string, attachmentIDs []string) ([]string, error) {
	var paths []string
	err := r.db.withRead(ctx, func(db *sql.DB) error {
		var exists string
		if err := db.QueryRowContext(ctx, `SELECT session_id FROM chat_runtime_sessions WHERE session_id = ?`, sessionID).Scan(&exists); err != nil {
			if err == sql.ErrNoRows {
				return NewError("chat_session_not_found", http.StatusNotFound, nil)
			}
			return err
		}
		return resolveAttachmentPathsQuerier(ctx, db, sessionID, attachmentIDs, &paths)
	})
	return paths, err
}

func (r *AttachmentRepository) cloneInTx(ctx context.Context, tx *sql.Tx, sourceID, childID string, attachmentIDs []string) ([]string, error) {
	if len(attachmentIDs) == 0 {
		return []string{}, nil
	}
	seen := make(map[string]struct{}, len(attachmentIDs))
	cloned := make([]string, 0, len(attachmentIDs))
	now := r.db.clock()
	for _, rawID := range attachmentIDs {
		id, err := RequiredText(rawID, "chat_attachment_id_invalid")
		if err != nil {
			return nil, err
		}
		if _, dup := seen[id]; dup {
			return nil, ErrInvalid("chat_attachment_ids_duplicate")
		}
		seen[id] = struct{}{}
		var filePath, name, mimeType string
		if err := tx.QueryRowContext(ctx, `
			SELECT file_path, name, mime_type FROM chat_runtime_attachments WHERE session_id = ? AND attachment_id = ?
		`, sourceID, id).Scan(&filePath, &name, &mimeType); err != nil {
			if err == sql.ErrNoRows {
				return nil, NewError("chat_attachment_not_found", http.StatusNotFound, map[string]any{"attachmentId": id})
			}
			return nil, err
		}
		childAttachmentID := r.idFactory("attachment")
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO chat_runtime_attachments (attachment_id, session_id, file_path, name, mime_type, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`, childAttachmentID, childID, filePath, name, mimeType, now); err != nil {
			return nil, err
		}
		cloned = append(cloned, childAttachmentID)
	}
	return cloned, nil
}

func resolveAttachmentPathsQuerier(ctx context.Context, q rowQuerier, sessionID string, ids []string, out *[]string) error {
	if ids == nil {
		*out = []string{}
		return nil
	}
	seen := make(map[string]struct{}, len(ids))
	paths := make([]string, 0, len(ids))
	for _, rawID := range ids {
		id, err := RequiredText(rawID, "chat_attachment_id_invalid")
		if err != nil {
			return err
		}
		if _, dup := seen[id]; dup {
			return ErrInvalid("chat_attachment_ids_duplicate")
		}
		seen[id] = struct{}{}
		var filePath string
		if err := q.QueryRowContext(ctx, `
			SELECT file_path FROM chat_runtime_attachments WHERE attachment_id = ? AND session_id = ?
		`, id, sessionID).Scan(&filePath); err != nil {
			if err == sql.ErrNoRows {
				return NewError("chat_attachment_not_found", http.StatusNotFound, map[string]any{"attachmentId": id})
			}
			return err
		}
		paths = append(paths, filePath)
	}
	*out = paths
	return nil
}
