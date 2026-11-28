package peer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// A content-key index keeps the records lock bounded independently of archive
// history. It contains only an exact message ID; originals stay in the queue.
func (s *DispatchStore) CreateMessageDeduplicated(input CreateMessageInput, window time.Duration) (*Record, error) {
	keyInput := input
	keyInput.ID = ""
	keyInput.From = normalizeRecordParty(input.From)
	keyInput.To = normalizeRecordParty(input.To)
	raw, err := json.Marshal(keyInput)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(raw)
	unlock, err := s.lockRecords()
	if err != nil {
		return nil, err
	}
	defer unlock()
	dir := filepath.Join(s.root, "dedup")
	if err := ensurePrivateDir(dir); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, hex.EncodeToString(digest[:])+".json")
	var index struct {
		ID        string `json:"id"`
		CreatedAt int64  `json:"createdAt"`
	}
	raw, err = os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if json.Unmarshal(raw, &index) != nil || !recordIDPattern.MatchString(index.ID) {
			return nil, ErrInvalidRecord
		}
		if age := s.now().UnixMilli() - index.CreatedAt; age >= 0 && age < window.Milliseconds() {
			rec, _, err := s.findExactLocked(index.ID)
			if errors.Is(err, ErrMessageNotFound) {
				input.ID = index.ID
				return s.createScheduledMessageLocked(input)
			}
			if err != nil {
				return nil, err
			}
			if rec.CanceledAt <= 0 && rec.State != "failed" && rec.NotificationState != "expired" {
				return rec, nil
			}
		}
	}
	// Reserve the ID first. If creation fails or the process exits, the next
	// retry repairs this same reservation instead of producing duplicate mail.
	index.ID, index.CreatedAt = NewMessageID(), s.now().UnixMilli()
	raw, err = json.Marshal(index)
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(path, append(raw, '\n')); err != nil {
		return nil, err
	}
	input.ID = index.ID
	return s.createScheduledMessageLocked(input)
}
