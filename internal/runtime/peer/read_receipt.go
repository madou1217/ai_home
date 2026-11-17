package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Read receipts are monotonic acknowledgements, independent of a delivery
// worker's inflight snapshot. A retry must not overwrite a concurrent read.
type readReceipt struct {
	V      int    `json:"v"`
	ID     string `json:"id"`
	ReadAt int64  `json:"readAt"`
}

func readReceiptAt(root, id string) (int64, error) {
	file := filepath.Join(root, "receipts", id+".json")
	info, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err == nil && !info.Mode().IsRegular() {
		err = errors.New("receipt is not a regular file")
	}
	var raw []byte
	if err == nil {
		raw, err = os.ReadFile(file)
	}
	if err == nil {
		var receipt readReceipt
		err = json.Unmarshal(raw, &receipt)
		if err == nil {
			if receipt.V == 1 && receipt.ID == id && receipt.ReadAt > 0 && receipt.ReadAt <= 9007199254740991 {
				return receipt.ReadAt, nil
			}
			err = errors.New("expected v=1, matching id and positive readAt")
		}
	}
	return 0, fmt.Errorf("peer_read_receipt_invalid: id=%s path=%s: %w", id, file, err)
}

func applyReadReceipt(root string, rec *Record) error {
	// Validate the sidecar even for legacy readAt>0: corruption must be visible,
	// never silently treated as an absent acknowledgement.
	at, err := readReceiptAt(root, rec.ID)
	if err != nil {
		return err
	}
	rec.ReceiptError = ""
	if rec.ReadAt <= 0 {
		rec.ReadAt = at
	}
	if rec.ReadAt > 0 || rec.State == "read" {
		rec.State = "read"
		rec.NextAttemptAt = 0
		rec.Error = ""
	}
	return nil
}

// Receipt failures are projections only. Preserve the body, target and attempt
// log on disk, keep the message in lists, and fail closed when claiming it.
func projectReadReceipt(root string, rec *Record) {
	if err := applyReadReceipt(root, rec); err != nil {
		rec.ReceiptError = err.Error()
		if rec.Error == "" {
			rec.Error = rec.ReceiptError
		} else {
			rec.Error += "; " + rec.ReceiptError
		}
	}
}

// Called under lockRecords; all writers of ACKs and message state use the same
// lock, so an ACK cannot land between a settle's merge and final rename.
func (s *DispatchStore) ensureReadReceipt(rec *Record) error {
	if err := ensurePrivateDir(filepath.Join(s.root, "receipts")); err != nil {
		return err
	}
	at, err := readReceiptAt(s.root, rec.ID)
	if err != nil {
		return err
	}
	if at > 0 {
		return nil
	}
	if rec.ReadAt <= 0 {
		rec.ReadAt = s.now().UnixMilli()
	}
	raw, err := json.Marshal(readReceipt{V: 1, ID: rec.ID, ReadAt: rec.ReadAt})
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(s.root, "receipts", rec.ID+".json"), append(raw, '\n'))
}

// archiveReadLocked only operates on the current record under lockRecords.
// A live inflight owner is never rewritten by reconciliation.
func (s *DispatchStore) archiveReadLocked(dir string, rec *Record) error {
	if err := s.ensureReadReceipt(rec); err != nil {
		return err
	}
	if err := applyReadReceipt(s.root, rec); err != nil {
		return err
	}
	if err := s.writeRecord(dir, *rec); err != nil {
		return err
	}
	if dir == "archive" {
		return nil
	}
	return os.Rename(s.fileIn(dir, rec.ID), s.fileIn("archive", rec.ID))
}

// ReconcileRead repairs legacy readAt/ACKs, including failed/expired records.
// Per-message receipt damage is visible in lists and cannot stop healthy peers.
func (s *DispatchStore) ReconcileRead() (int, error) {
	if s == nil || s.root == "" {
		return 0, ErrStoreUnavailable
	}
	count := 0
	for _, dir := range []string{"pending", "archive"} {
		entries, err := os.ReadDir(filepath.Join(s.root, dir))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return count, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			id := strings.TrimSuffix(entry.Name(), ".json")
			// Avoid acquiring a writer lock for every healthy unread record.
			preview, err := s.readRecord(dir, id)
			if err != nil || preview.ReceiptError != "" || preview.State != "read" {
				continue
			}
			unlock, err := s.lockRecords()
			if err != nil {
				return count, err
			}
			rec, err := s.readStoredRecord(dir, id)
			if err == nil {
				previous := *rec
				err = applyReadReceipt(s.root, rec)
				if err == nil && rec.State == "read" {
					// Always ensure legacy ACK persistence, but avoid rewriting a
					// settled archive on every background tick.
					err = s.ensureReadReceipt(rec)
					if err == nil && (dir == "pending" || previous.State != "read" ||
						previous.ReadAt != rec.ReadAt || previous.NextAttemptAt != 0 || previous.Error != "") {
						if s.archiveReadLocked(dir, rec) == nil {
							count++
						}
					}
				}
			}
			unlock()
		}
	}
	return count, nil
}
