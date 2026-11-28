package peer

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Find resolves only a unique ID/prefix across the queue and archive. It is a
// read-only lookup used by `aih peer reply`; it never mutates delivery state.
func (s *DispatchStore) Find(id string) (*Record, error) {
	key := NormalizeID(id)
	if key == "" {
		return nil, ErrInvalidRecord
	}
	if s == nil || s.root == "" {
		return nil, ErrStoreUnavailable
	}
	var found *Record
	for _, dir := range []string{"pending", "inflight", "archive"} {
		entries, err := os.ReadDir(filepath.Join(s.root, dir))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			rec, err := s.readStoredRecord(dir, strings.TrimSuffix(entry.Name(), ".json"))
			if err != nil {
				continue
			}
			if rec.ID == key {
				return rec, nil
			}
			if strings.HasPrefix(rec.ID, key) || strings.HasPrefix(strings.TrimPrefix(rec.ID, MessagePrefix), key) {
				if found != nil {
					return nil, ErrAmbiguousMessage
				}
				found = rec
			}
		}
	}
	if found == nil {
		return nil, ErrMessageNotFound
	}
	return found, nil
}

// RecentRecords returns up to limit records ordered newest first. It exists for
// shell completion of message IDs (`aih peer reply <TAB>`), not as a mailbox
// projection: it never claims, acknowledges or rewrites anything.
func (s *DispatchStore) RecentRecords(limit int) ([]Record, error) {
	if s == nil || s.root == "" {
		return nil, ErrStoreUnavailable
	}
	if limit <= 0 {
		return nil, nil
	}
	out := make([]Record, 0, limit)
	for _, dir := range []string{"pending", "archive"} {
		entries, err := os.ReadDir(filepath.Join(s.root, dir))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			rec, err := s.readStoredRecord(dir, strings.TrimSuffix(entry.Name(), ".json"))
			if err != nil {
				continue
			}
			out = append(out, *rec)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		return out[i].ID > out[j].ID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// SameRecipient identifies the exact receiving session. Session IDs win; names
// alone are not recipient authority.
func SameRecipient(to, self RecordParty) bool {
	if to.Provider != "" && self.Provider != "" && to.Provider != self.Provider {
		return false
	}
	if to.SessionID != "" {
		return to.SessionID == self.SessionID
	}
	if to.Delivery != nil && self.Delivery != nil && to.Delivery.SessionName != "" && self.Delivery.SessionName != "" {
		return to.Delivery.CLIName == self.Delivery.CLIName && to.Delivery.RuntimeScope == self.Delivery.RuntimeScope && to.Delivery.SessionName == self.Delivery.SessionName
	}
	return to.Channel == "native" && self.Channel == "native" && to.Address != "" && to.Address == self.Address
}
