package peer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"
	"time"
)

var (
	ErrMessageNotFound  = errors.New("peer_message_not_found")
	ErrIdentityMismatch = errors.New("peer_identity_mismatch")
	ErrMessageInflight  = errors.New("peer_message_inflight")
	ErrMessageSettled   = errors.New("peer_message_already_delivered")
	ErrAmbiguousMessage = errors.New("peer_message_ambiguous")
	recordIDPattern     = regexp.MustCompile(`^pm-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

type LifecycleInput struct {
	ID               string      `json:"id"`
	From             RecordParty `json:"from"`
	To               RecordParty `json:"to"`
	AutoDeliverUntil *int64      `json:"autoDeliverUntil,omitempty"`
	ExpiresAt        *int64      `json:"expiresAt,omitempty"`
	ResetAttempts    bool        `json:"resetAttempts,omitempty"`
}

type policyError struct{ reason string }

func (e *policyError) Error() string { return e.reason }

func validSender(p RecordParty) bool {
	p = normalizeRecordParty(p)
	return p.SessionID != "" || p.Address != "" || p.Name != "" ||
		(p.Delivery != nil && p.Delivery.SessionName != "")
}

func validParty(p RecordParty) bool {
	return strings.TrimSpace(p.Channel) != "" && validSender(p)
}

func sameSender(a, b RecordParty) bool {
	return reflect.DeepEqual(normalizeRecordParty(a), normalizeRecordParty(b))
}

// Exact filenames only: prefixes, traversal and duplicate states are never
// guessed. This must be called under lockRecords for a mutation.
func (s *DispatchStore) findExactLocked(id string) (*Record, string, error) {
	if !recordIDPattern.MatchString(id) {
		return nil, "", ErrInvalidRecord
	}
	var found *Record
	var dir string
	for _, candidate := range []string{"pending", "inflight", "archive"} {
		rec, err := s.readStoredRecord(candidate, id)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, "", err
		}
		if rec.ID != id {
			return nil, "", ErrIdentityMismatch
		}
		if found != nil {
			return nil, "", ErrAmbiguousMessage
		}
		if err := applyReadReceipt(s.root, rec); err != nil {
			return nil, "", err
		}
		found, dir = rec, candidate
	}
	if found == nil {
		return nil, "", ErrMessageNotFound
	}
	return found, dir, nil
}

func checkLifecycleIdentity(rec *Record, input LifecycleInput) error {
	if !validSender(input.From) || !validParty(input.To) || !sameSender(rec.From, input.From) || TargetKey(rec.To) != TargetKey(input.To) {
		return ErrIdentityMismatch
	}
	if rec.State == "delivered" || rec.State == "read" || rec.ReadAt > 0 || rec.DeliveredAt > 0 {
		return ErrMessageSettled
	}
	return nil
}

func (s *DispatchStore) createScheduledMessage(input CreateMessageInput) (*Record, error) {
	unlock, err := s.lockRecords()
	if err != nil {
		return nil, err
	}
	defer unlock()
	id := NormalizeID(input.ID)
	if id == "" {
		id = NewMessageID()
	}
	if !recordIDPattern.MatchString(id) || !validSender(input.From) || !validParty(input.To) || (input.AutoDeliverUntil != nil && *input.AutoDeliverUntil < 0) || input.ExpiresAt < 0 {
		return nil, ErrInvalidRecord
	}
	if _, _, err := s.findExactLocked(id); !errors.Is(err, ErrMessageNotFound) {
		if err == nil {
			err = ErrAmbiguousMessage
		}
		return nil, err
	}
	switch input.ReplyPolicy {
	case "", "required", "optional", "none":
	default:
		return nil, ErrInvalidRecord
	}
	rec := Record{
		V: RecordVersion, ID: id, From: normalizeRecordParty(input.From), To: normalizeRecordParty(input.To),
		ReplyTo: NormalizeID(input.ReplyTo), Body: input.Body, CreatedAt: s.now().UnixMilli(), State: "pending", Attempts: []AttemptRecord{},
		Subject: input.Subject, Summary: input.Summary, Purpose: input.Purpose, Action: input.Action, ReplyPolicy: input.ReplyPolicy,
		ExpiresAt: input.ExpiresAt, Supersedes: NormalizeID(input.Supersedes),
	}
	if input.AutoDeliverUntil != nil {
		rec.AutoDeliverUntil = *input.AutoDeliverUntil
		rec.autoDeliverUntilSet = true
	}
	var previous *Record
	var previousDir string
	if rec.Supersedes != "" {
		previous, previousDir, err = s.findExactLocked(rec.Supersedes)
		if err != nil {
			return nil, err
		}
		if previousDir == "inflight" {
			return nil, ErrMessageInflight
		}
		if err := checkLifecycleIdentity(previous, LifecycleInput{From: rec.From, To: rec.To}); err != nil {
			return nil, err
		}
	}
	gate, err := s.readTargetGate(rec.To)
	if err != nil {
		return nil, err
	}
	projectNotificationAt(&rec, gate, s.now().UnixMilli())
	if err := s.writeRecord("pending", rec); err != nil {
		return nil, err
	}
	if previous != nil {
		previous.SupersededBy = rec.ID
		if err := s.cancelLocked(previous, previousDir); err != nil {
			return &rec, fmt.Errorf("peer_supersede_incomplete: durable replacement intent retained: %w", err)
		}
		rec.SupersedesAppliedAt = s.now().UnixMilli()
		if err := s.writeRecord("pending", rec); err != nil {
			return &rec, err
		}
	}
	return &rec, nil
}

// Invalidate an inflight generation before exposing its retained pending file.
// A worker holding the old token can no longer authorize or settle it.
func (s *DispatchStore) retainLocked(rec *Record, dir string) error {
	if dir != "pending" {
		if _, err := os.Lstat(s.fileIn("pending", rec.ID)); !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return err
			}
			return ErrAmbiguousMessage
		}
	}
	if rec.Claim != nil {
		rec.Claim = &ClaimLease{Token: NewMessageID(), Generation: rec.Claim.Generation + 1, ClaimedAt: s.now().UnixMilli()}
	}
	if err := s.writeRecord(dir, *rec); err != nil {
		return err
	}
	if dir != "pending" {
		return os.Rename(s.fileIn(dir, rec.ID), s.fileIn("pending", rec.ID))
	}
	return nil
}

func (s *DispatchStore) cancelLocked(rec *Record, dir string) error {
	rec.CanceledAt = s.now().UnixMilli()
	rec.NotificationState, rec.WaitingReason, rec.NextAttemptAt = "canceled", "canceled", 0
	rec.State = "pending"
	// Preserve the reservation until normal expiry: a concurrent transport
	// already past its first write must not be followed by an immediate burst.
	return s.retainLocked(rec, dir)
}

func (s *DispatchStore) CancelMessage(input LifecycleInput) (*Record, error) {
	unlock, err := s.lockRecords()
	if err != nil {
		return nil, err
	}
	defer unlock()
	rec, dir, err := s.findExactLocked(strings.TrimSpace(input.ID))
	if err != nil {
		return nil, err
	}
	if err := checkLifecycleIdentity(rec, input); err != nil {
		return nil, err
	}
	if dir == "inflight" {
		return nil, ErrMessageInflight
	}
	if rec.CanceledAt > 0 {
		return rec, nil
	}
	if err := s.cancelLocked(rec, dir); err != nil {
		return nil, err
	}
	return rec, nil
}

func (s *DispatchStore) ResumeMessage(input LifecycleInput) (*Record, error) {
	unlock, err := s.lockRecords()
	if err != nil {
		return nil, err
	}
	defer unlock()
	rec, dir, err := s.findExactLocked(strings.TrimSpace(input.ID))
	if err != nil {
		return nil, err
	}
	if err := checkLifecycleIdentity(rec, input); err != nil {
		return nil, err
	}
	if dir == "inflight" {
		return nil, ErrMessageInflight
	}
	at := s.now().UnixMilli()
	until := at + DefaultAutoHorizon.Milliseconds()
	if input.AutoDeliverUntil != nil {
		until = *input.AutoDeliverUntil
	}
	if rec.ExpiresAt > 0 && rec.ExpiresAt <= at && input.ExpiresAt == nil {
		return nil, &policyError{reason: "expired"}
	}
	if until <= at || until > at+DefaultAutoHorizon.Milliseconds() {
		return nil, ErrInvalidRecord
	}
	if input.ExpiresAt != nil {
		if *input.ExpiresAt < 0 {
			return nil, ErrInvalidRecord
		}
		rec.ExpiresAt = *input.ExpiresAt
	}
	if rec.ExpiresAt > 0 && rec.ExpiresAt <= at {
		return nil, &policyError{reason: "expired"}
	}
	gate, err := s.readTargetGate(rec.To)
	if err != nil {
		return nil, err
	}
	if input.ResetAttempts {
		// Never erase historical attempts; an explicit reset establishes a new
		// authorized budget baseline, shared through the target gate.
		gate.FailureCount = 0
		rec.FailureResetAt = at
	}
	rec.State, rec.Error, rec.CanceledAt = "pending", "", 0
	rec.AutoDeliverUntil, rec.NotificationState, rec.WaitingReason = until, "ready", ""
	rec.autoDeliverUntilSet = true
	// Do not bypass successful cooldown, real-error backoff or a live writer.
	if gate.NextProbeAt <= at {
		rec.NextAttemptAt = 0
	} else {
		rec.NextAttemptAt = gate.NextProbeAt
	}
	projectNotificationAt(rec, gate, at)
	if err := s.retainLocked(rec, dir); err != nil {
		return nil, err
	}
	if err := s.writeTargetGate(gate); err != nil {
		return nil, err
	}
	return rec, nil
}

// CheckDelivery is reloaded immediately before the first transport write, not
// merely before activity probing. Cancellation/recovery fencing remains exact.
func (s *DispatchStore) CheckDelivery(ctx context.Context, claimed Record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	unlock, err := s.lockRecords()
	if err != nil {
		return err
	}
	defer unlock()
	rec, err := s.ownedRecord(&claimed)
	if err != nil {
		return err
	}
	if err := applyReadReceipt(s.root, rec); err != nil {
		return &policyError{reason: "read_receipt_unavailable"}
	}
	if rec.State == "read" {
		return &policyError{reason: "already_read"}
	}
	gate, err := s.readTargetGate(rec.To)
	if err != nil {
		return &policyError{reason: "target_probe_unavailable"}
	}
	if gate.LastMessageID != rec.ID || gate.LastReason != "target_inflight" {
		return &policyError{reason: "target_inflight"}
	}
	// The caller owns this reservation, not a cooldown escape for other sends.
	gate.NextProbeAt = 0
	projectNotificationAt(rec, gate, s.now().UnixMilli())
	if rec.NotificationState != "ready" {
		reason := rec.WaitingReason
		if reason == "" {
			reason = rec.NotificationState
		}
		return &policyError{reason: reason}
	}
	return nil
}

func (s *DispatchStore) refreshScheduling(maxAge time.Duration) (int, error) {
	pending, err := s.ListPending()
	if err != nil {
		return 0, err
	}
	changed := 0
	for _, item := range pending {
		unlock, err := s.lockRecords()
		if err != nil {
			return changed, err
		}
		var writeErr error
		func() {
			defer unlock()
			rec, err := s.readStoredRecord("pending", item.ID)
			if err != nil || applyReadReceipt(s.root, rec) != nil {
				return
			}
			before := *rec
			gate, err := s.readTargetGate(rec.To)
			if err != nil {
				return
			}
			at := s.now().UnixMilli()
			projectNotificationAt(rec, gate, at)
			if maxAge > 0 && at-rec.CreatedAt >= maxAge.Milliseconds() && rec.NotificationState == "ready" {
				rec.NotificationState, rec.WaitingReason, rec.NextAttemptAt = "manual", "stale_retained", 0
			}
			if !reflect.DeepEqual(before, *rec) {
				writeErr = s.writeRecord("pending", *rec)
				if writeErr == nil {
					changed++
				}
			}
		}()
		if writeErr != nil {
			return changed, writeErr
		}
	}
	return changed, nil
}
