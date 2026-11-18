package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TargetGate is shared with Node. Writers must hold the existing records lock.
// failureCount is additive v1 metadata: new sends cannot reset real failures.
type TargetGate struct {
	V               int    `json:"v"`
	TargetKey       string `json:"targetKey"`
	BusySince       int64  `json:"busySince"`
	ProbeCount      int    `json:"probeCount"`
	NextProbeAt     int64  `json:"nextProbeAt"`
	LastReason      string `json:"lastReason"`
	LastProbeAt     int64  `json:"lastProbeAt"`
	LastDeliveredAt int64  `json:"lastDeliveredAt"`
	LastMessageID   string `json:"lastMessageId"`
	FailureCount    int    `json:"failureCount"`
}

func (s *DispatchStore) readTargetGate(to RecordParty) (TargetGate, error) {
	gate := TargetGate{V: 1, TargetKey: TargetKey(to)}
	file := filepath.Join(s.root, "targets", gate.TargetKey+".json")
	info, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return gate, nil
	}
	if err == nil && !info.Mode().IsRegular() {
		err = errors.New("gate is not a regular file")
	}
	var raw []byte
	if err == nil {
		raw, err = os.ReadFile(file)
	}
	if err == nil {
		var stored TargetGate
		err = json.Unmarshal(raw, &stored)
		gate = stored
	}
	if err == nil {
		var fields map[string]json.RawMessage
		err = json.Unmarshal(raw, &fields)
		for _, key := range []string{"v", "targetKey", "busySince", "probeCount", "nextProbeAt", "lastReason", "lastProbeAt", "lastDeliveredAt", "lastMessageId"} {
			value, present := fields[key]
			if !present || string(value) == "null" {
				err = errors.New("missing required gate field: " + key)
				break
			}
		}
	}
	if err == nil && (gate.V != 1 || gate.TargetKey != TargetKey(to) || gate.ProbeCount < 0 ||
		gate.FailureCount < 0 || gate.BusySince < 0 || gate.NextProbeAt < 0 || gate.LastProbeAt < 0 || gate.LastDeliveredAt < 0 ||
		gate.BusySince > 9007199254740991 || gate.NextProbeAt > 9007199254740991 ||
		gate.LastProbeAt > 9007199254740991 || gate.LastDeliveredAt > 9007199254740991 ||
		int64(gate.ProbeCount) > 9007199254740991 || int64(gate.FailureCount) > 9007199254740991) {
		err = errors.New("invalid target gate identity/version/budget")
	}
	if err != nil {
		return gate, fmt.Errorf("peer_target_gate_invalid: %w", err)
	}
	return gate, nil
}

func (s *DispatchStore) writeTargetGate(gate TargetGate) error {
	if gate.V != 1 || len(gate.TargetKey) != 64 {
		return ErrInvalidRecord
	}
	raw, err := json.MarshalIndent(gate, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(s.root, "targets", gate.TargetKey+".json"), append(raw, '\n'))
}

func (s *DispatchStore) projectNotification(rec *Record) {
	if rec.State == "read" || rec.State == "delivered" || rec.DeliveredAt > 0 {
		projectNotificationAt(rec, TargetGate{}, s.now().UnixMilli())
		return
	}
	gate, err := s.readTargetGate(rec.To)
	if err != nil {
		projectNotificationAt(rec, TargetGate{BusySince: rec.BusySince, ProbeCount: rec.ProbeCount}, s.now().UnixMilli())
		if rec.NotificationState == "canceled" || rec.NotificationState == "expired" {
			return
		}
		rec.NotificationState, rec.WaitingReason, rec.NextAttemptAt = "manual", "target_gate_unavailable", 0
		if rec.Error == "" {
			rec.Error = err.Error()
		}
		return
	}
	projectNotificationAt(rec, gate, s.now().UnixMilli())
}

func (s *DispatchStore) targetInflightLocked(to RecordParty) (bool, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "inflight"))
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		rec, err := s.readStoredRecord("inflight", strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return false, err
		}
		if TargetKey(rec.To) == TargetKey(to) {
			return true, nil
		}
	}
	return false, nil
}

func (s *DispatchStore) settleScheduling(next *Record, state, code, messageID string, retry time.Duration, at int64) error {
	gate, err := s.readTargetGate(next.To)
	if err != nil {
		return err
	}
	gate.LastMessageID = next.ID
	gate.LastReason = strings.TrimSpace(code)
	next.State, next.Error = state, ""
	switch {
	case state == "delivered":
		next.DeliveredAt, next.NextAttemptAt, next.ChannelMessageID = at, 0, strings.TrimSpace(messageID)
		next.NotificationState, next.WaitingReason = "delivered", ""
		gate.BusySince, gate.ProbeCount, gate.FailureCount = 0, 0, 0
		gate.LastDeliveredAt, gate.NextProbeAt, gate.LastReason = at, at+TargetCooldown.Milliseconds(), "target_cooldown"
		s.appendAttempt(next, AttemptRecord{At: at, Channel: next.To.Channel, OK: true})
	case IsWaitingDeliveryError(code):
		next.State = "pending"
		if gate.BusySince == 0 {
			gate.BusySince = at
		}
		gate.ProbeCount++
		gate.NextProbeAt = at + ProbeBackoff(gate.ProbeCount).Milliseconds()
		next.NextAttemptAt = gate.NextProbeAt
		next.NotificationState, next.WaitingReason = "waiting", code
	default:
		gate.FailureCount++
		if retry < BackoffFor(gate.FailureCount) {
			retry = BackoffFor(gate.FailureCount)
		}
		gate.NextProbeAt = at + retry.Milliseconds()
		next.NextAttemptAt = gate.NextProbeAt
		next.Error = strings.TrimSpace(code)
		s.appendAttempt(next, AttemptRecord{At: at, Channel: next.To.Channel, Error: strings.TrimSpace(code)})
		next.NotificationState, next.WaitingReason = "waiting", code
	}
	if state != "delivered" {
		gate.LastProbeAt = at
	}
	projectNotificationAt(next, gate, at)
	if err := s.writeTargetGate(gate); err != nil {
		return err
	}
	return nil
}

// WakeTarget is an event integration port, not a provider event subscription.
// Only positively observed idle/composer-empty events can shorten busy probing;
// notLoaded/unknown/busy do nothing. It never clears cooldown, real-error
// backoff, budget exhaustion, semantic expiry or a manual/canceled message.
func (s *DispatchStore) WakeTarget(to RecordParty, observedState string) (bool, error) {
	return s.wakeTarget(to, observedState, 0)
}

func (s *DispatchStore) wakeTarget(to RecordParty, observedState string, eventAt int64) (bool, error) {
	if observedState != "idle" {
		return false, nil
	}
	unlock, err := s.lockRecords()
	if err != nil {
		return false, err
	}
	defer unlock()
	gate, err := s.readTargetGate(to)
	if err != nil {
		return false, err
	}
	at := s.now().UnixMilli()
	if eventAt > 0 && (eventAt <= gate.LastProbeAt || eventAt > at+5000) {
		return false, nil
	}
	switch gate.LastReason {
	case "target_busy", "chat_target_busy", "target_has_draft", "target_state_unknown", "target_input_unavailable", "target_probe_unavailable":
	default:
		return false, nil
	}
	if gate.NextProbeAt <= at || gate.FailureCount >= MaxDeliveryFailures {
		return false, nil
	}
	// busySince is observability, never a circuit breaker for future sends.
	// Only each message's own autoDeliverUntil ends its automatic delivery.
	pending, err := s.ListPending()
	if err != nil {
		return false, err
	}
	changed := false
	for _, item := range pending {
		if TargetKey(item.To) != gate.TargetKey {
			continue
		}
		rec, err := s.readStoredRecord("pending", item.ID)
		if err != nil || applyReadReceipt(s.root, rec) != nil {
			continue
		}
		projectNotificationAt(rec, gate, at)
		if rec.NotificationState == "manual" || rec.NotificationState == "canceled" || rec.NotificationState == "expired" || rec.NotificationState == "delivered" {
			continue
		}
		rec.NextAttemptAt = at
		if err := s.writeRecord("pending", *rec); err != nil {
			return false, err
		}
		changed = true
	}
	if !changed {
		return false, nil
	}
	gate.NextProbeAt, gate.LastReason = at, "target_woken"
	// Do not reset busySince/probeCount: even new sends retain target pacing.
	return true, s.writeTargetGate(gate)
}
