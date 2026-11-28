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
	// ErrModelSelectionUnsupported 表示给不支持回合级模型的通道指定了 model/effort。
	ErrModelSelectionUnsupported = errors.New("peer_model_selection_unsupported")
	// ErrModelSelectionRequiresModel 表示只给了推理强度而没有模型。
	ErrModelSelectionRequiresModel = errors.New("peer_model_selection_requires_model")
	recordIDPattern                = regexp.MustCompile(`^pm-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
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
	if rec.State == "delivered" || rec.DeliveredAt > 0 {
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
	return s.createScheduledMessageLocked(input)
}

func (s *DispatchStore) createScheduledMessageLocked(input CreateMessageInput) (*Record, error) {
	id := NormalizeID(input.ID)
	if id == "" {
		id = NewMessageID()
	}
	if !recordIDPattern.MatchString(id) || !validSender(input.From) || !validParty(input.To) || (input.AutoDeliverUntil != nil && *input.AutoDeliverUntil < 0) || input.ExpiresAt < 0 || input.Priority < PriorityLow || input.Priority > PriorityHigh {
		return nil, ErrInvalidRecord
	}
	// 回合级模型设置只在支持它的通道上有意义；服务层兜底，避免绕过 CLI 写入无效记录。
	if err := validateTurnSelection(input); err != nil {
		return nil, err
	}
	if _, _, err := s.findExactLocked(id); !errors.Is(err, ErrMessageNotFound) {
		if err == nil {
			err = ErrAmbiguousMessage
		}
		return nil, err
	}
	// There is no mailbox: "none" (inbox-only) is no longer a valid policy.
	switch input.ReplyPolicy {
	case "", "required", "optional":
	default:
		return nil, ErrInvalidRecord
	}
	rec := Record{
		V: RecordVersion, ID: id, Priority: input.Priority, From: normalizeRecordParty(input.From), To: normalizeRecordParty(input.To),
		ReplyTo: NormalizeID(input.ReplyTo), Body: input.Body, Model: input.Model, ReasoningEffort: input.ReasoningEffort,
		CreatedAt: s.now().UnixMilli(), State: "pending", Attempts: []AttemptRecord{},
		NoEnvelope: input.NoEnvelope, FromMode: input.FromMode, Subject: input.Subject, Summary: input.Summary, Purpose: input.Purpose, Action: input.Action, ReplyPolicy: input.ReplyPolicy,
		ExpiresAt: input.ExpiresAt, Supersedes: NormalizeID(input.Supersedes),
	}
	if input.AutoDeliverUntil != nil {
		rec.AutoDeliverUntil = *input.AutoDeliverUntil
		rec.autoDeliverUntilSet = true
	}
	var previous *Record
	var previousDir string
	var err error
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

// CheckDelivery is reloaded immediately before the first transport write, not
// merely before activity probing. Claim fencing remains exact.
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

// refreshScheduling retires queued messages that can no longer be delivered.
// Without a mailbox there is no user-facing place to hold them forever, so a
// message past its auto-delivery deadline (or the hard queue age) is archived
// as failed instead of being retained as manual mail.
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
			if err != nil {
				return
			}
			before := *rec
			gate, err := s.readTargetGate(rec.To)
			if err != nil {
				return
			}
			at := s.now().UnixMilli()
			projectNotificationAt(rec, gate, at)
			switch {
			case rec.CanceledAt > 0 || rec.NotificationState == "canceled":
				writeErr = s.retirePendingLocked(rec, "canceled")
			case rec.NotificationState == "expired":
				writeErr = s.retirePendingLocked(rec, "expired")
			case maxAge > 0 && at-rec.CreatedAt >= maxAge.Milliseconds():
				writeErr = s.retirePendingLocked(rec, "expired")
			case !reflect.DeepEqual(before, *rec):
				writeErr = s.writeRecord("pending", *rec)
			}
			if writeErr == nil && !reflect.DeepEqual(before, *rec) {
				changed++
			}
		}()
		if writeErr != nil {
			return changed, writeErr
		}
	}
	return changed, nil
}

// retirePendingLocked moves a queued message to the terminal archive bucket.
// The caller must hold lockRecords.
func (s *DispatchStore) retirePendingLocked(rec *Record, reason string) error {
	if _, err := os.Lstat(s.fileIn("archive", rec.ID)); err == nil {
		return ErrAmbiguousMessage
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	detail := strings.TrimSpace(rec.WaitingReason)
	if detail == "" {
		detail = "auto_horizon_elapsed"
	}
	rec.State, rec.Error, rec.NotificationState = "failed", reason, reason
	rec.WaitingReason, rec.NextAttemptAt = detail, 0
	if reason == "canceled" {
		rec.WaitingReason = "canceled"
		if rec.CanceledAt == 0 {
			rec.CanceledAt = s.now().UnixMilli()
		}
	}
	if err := s.writeRecord("pending", *rec); err != nil {
		return err
	}
	return os.Rename(s.fileIn("pending", rec.ID), s.fileIn("archive", rec.ID))
}
