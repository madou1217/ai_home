package peer

import (
	"os"
	"path/filepath"
	"strings"
)

// Supersedes is the durable replacement intent. AppliedAt is written only after
// the exact old record is canceled, so a crash between the two atomic JSON
// writes is recoverable before the Go dispatcher can claim either message.
func (s *DispatchStore) ReconcileSupersedes() (int, error) {
	unlock, err := s.lockRecords()
	if err != nil {
		return 0, err
	}
	defer unlock()
	return s.reconcileSupersedesLocked()
}

func (s *DispatchStore) reconcileSupersedesLocked() (int, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "pending"))
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		rec, err := s.readStoredRecord("pending", strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil || rec.Supersedes == "" || rec.SupersedesAppliedAt > 0 {
			continue
		}
		if rec.NotificationState == "manual" && strings.HasPrefix(rec.WaitingReason, "supersedes_") {
			continue
		}
		if err := applyReadReceipt(s.root, rec); err != nil {
			continue
		}
		if rec.State == "read" || rec.DeliveredAt > 0 {
			continue
		}
		previous, dir, err := s.findExactLocked(rec.Supersedes)
		if err == nil && dir == "inflight" {
			continue
		} // cannot unsend; sibling claim fencing still applies
		reason := ""
		switch {
		case err != nil:
			// A damaged old receipt/record blocks only this replacement intent;
			// healthy targets must retain the existing per-message isolation.
			reason = "supersedes_unavailable"
			if rec.Error == "" {
				rec.Error = err.Error()
			}
		case previous.ID == rec.ID:
			reason = "supersedes_identity_mismatch"
		case checkLifecycleIdentity(previous, LifecycleInput{From: rec.From, To: rec.To}) != nil:
			reason = "supersedes_identity_or_history_conflict"
		}
		if reason != "" {
			if rec.NotificationState != "manual" || rec.WaitingReason != reason {
				rec.NotificationState, rec.WaitingReason, rec.NextAttemptAt = "manual", reason, 0
				if err := s.writeRecord("pending", *rec); err != nil {
					return count, err
				}
			}
			continue
		}
		if previous.CanceledAt <= 0 {
			previous.SupersededBy = rec.ID
			if err := s.cancelLocked(previous, dir); err != nil {
				return count, err
			}
		}
		rec.SupersedesAppliedAt = s.now().UnixMilli()
		if err := s.writeRecord("pending", *rec); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
