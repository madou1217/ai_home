package peer

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Records is the CLI mailbox view: oldest first, untruncated. Inspection never
// creates read receipts; WebUI latest-N semantics are deliberately separate.
func (s *DispatchStore) Records() ([]Record, error) {
	if s == nil || s.root == "" {
		return nil, ErrStoreUnavailable
	}
	out := []Record{}
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
			rec, err := s.readRecord(dir, strings.TrimSuffix(entry.Name(), ".json"))
			if err != nil {
				return nil, err
			}
			out = append(out, *rec)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt == out[j].CreatedAt {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out, nil
}

// Find resolves only a unique ID/prefix. It is read-only, including for senders.
func (s *DispatchStore) Find(id string) (*Record, error) {
	id = NormalizeID(id)
	if id == "" {
		return nil, ErrInvalidRecord
	}
	records, err := s.Records()
	if err != nil {
		return nil, err
	}
	var found *Record
	for i := range records {
		rec := &records[i]
		if rec.ID == id {
			return rec, nil
		}
		if strings.HasPrefix(rec.ID, id) || strings.HasPrefix(strings.TrimPrefix(rec.ID, MessagePrefix), id) {
			if found != nil {
				return nil, ErrAmbiguousMessage
			}
			found = rec
		}
	}
	if found == nil {
		return nil, ErrMessageNotFound
	}
	return found, nil
}

// Acknowledge accepts an identity derived by the host, never a user-supplied
// --from label. Session IDs win; names alone are not recipient authority.
func (s *DispatchStore) Acknowledge(id string, recipient RecordParty) (*Record, error) {
	unlock, err := s.lockRecords()
	if err != nil {
		return nil, err
	}
	defer unlock()
	rec, dir, err := s.findExactLocked(NormalizeID(id))
	if err != nil {
		return nil, err
	}
	if !SameRecipient(rec.To, recipient) {
		return nil, ErrIdentityMismatch
	}
	if err := s.ensureReadReceipt(rec); err != nil {
		return nil, err
	}
	if dir == "inflight" { // do not steal the live worker's claim
		if err := applyReadReceipt(s.root, rec); err != nil {
			return nil, err
		}
		return rec, nil
	}
	if err := s.archiveReadLocked(dir, rec); err != nil {
		return nil, err
	}
	return rec, nil
}

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
