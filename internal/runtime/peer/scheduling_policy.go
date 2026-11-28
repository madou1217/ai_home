package peer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

const (
	ClaimReservation    = 5 * time.Second
	DefaultAutoHorizon  = 30 * time.Minute
	TargetCooldown      = 3 * time.Second
	MaxDeliveryFailures = 5
)

// TargetKey is the cross-language identity; socket paths and display names do
// not replace a delivery session's exact identity. No trailing NUL is hashed.
func TargetKey(p RecordParty) string {
	p = normalizeRecordParty(p)
	parts := []string{p.Channel, p.Provider}
	if p.Delivery != nil && p.Delivery.SessionName != "" {
		parts = append(parts, p.Delivery.CLIName, p.Delivery.RuntimeScope, p.Delivery.SessionName)
	} else {
		address := p.SessionID
		if address == "" {
			address = p.Address
		}
		if address == "" {
			address = p.Name
		}
		parts = append(parts, address)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func ProbeBackoff(count int) time.Duration {
	delays := [...]time.Duration{5, 15, 30, 60, 120, 300}
	if count < 1 {
		count = 1
	}
	if count > len(delays) {
		count = len(delays)
	}
	return delays[count-1] * time.Second
}

// Waiting is not a send attempt, including unknown/unavailable safety probes.
func IsWaitingDeliveryError(code string) bool {
	switch strings.TrimSpace(code) {
	case "target_busy", "chat_target_busy", "target_has_draft", "target_input_unavailable",
		"target_state_unknown", "target_probe_unavailable", "activity_probe_failed", "probe_error", "tmux_unavailable", "chat_runtime_unavailable", "target_inflight", "target_cooldown",
		"peer_claim_lost":
		return true
	}
	return false
}

// DeliveryFailureCount is a conservative retry-budget estimate, NOT a count
// of observed sends: truncated legacy history is unknown and can include busy
// probes. Keep this separate from retained known real failures and gate counts.
func DeliveryFailureCount(rec Record) int {
	return legacyAttemptUnknownCount(rec) + retainedDeliveryFailureCount(rec)
}

func legacyAttemptUnknownCount(rec Record) int {
	if rec.FailureResetAt > 0 {
		return 0
	}
	unknown := rec.AttemptCount - len(rec.Attempts)
	if unknown < 0 {
		return 0
	}
	return unknown
}

func retainedDeliveryFailureCount(rec Record) int {
	count := 0
	for _, attempt := range rec.Attempts {
		if !attempt.OK && !IsWaitingDeliveryError(attempt.Error) && (rec.FailureResetAt <= 0 || attempt.At > rec.FailureResetAt) {
			count++
		}
	}
	return count
}

func retryBudgetReason(rec Record, gate TargetGate) string {
	if gate.FailureCount >= MaxDeliveryFailures || retainedDeliveryFailureCount(rec) >= MaxDeliveryFailures {
		return "retry_exhausted"
	}
	if DeliveryFailureCount(rec) >= MaxDeliveryFailures {
		return "legacy_attempt_history_uncertain"
	}
	return ""
}

func autoDeadline(rec Record) int64 {
	if rec.autoDeliverUntilSet || rec.AutoDeliverUntil > 0 {
		return rec.AutoDeliverUntil
	}
	if rec.CreatedAt <= 0 {
		return 0
	}
	return rec.CreatedAt + DefaultAutoHorizon.Milliseconds()
}

// projectNotificationAt derives the queued delivery state without side effects.
func projectNotificationAt(rec *Record, gate TargetGate, at int64) {
	if !rec.autoDeliverUntilSet {
		rec.AutoDeliverUntil = autoDeadline(*rec)
		rec.autoDeliverUntilSet = true
	}
	rec.BusySince, rec.ProbeCount = gate.BusySince, gate.ProbeCount
	state, reason := "ready", ""
	budgetReason := retryBudgetReason(*rec, gate)
	switch {
	case rec.DeliveredAt > 0 || rec.State == "delivered":
		state = "delivered"
	case rec.CanceledAt > 0 || rec.NotificationState == "canceled":
		state, reason = "canceled", "canceled"
	case (rec.ExpiresAt > 0 && at >= rec.ExpiresAt) || rec.NotificationState == "expired":
		state, reason = "expired", "expired"
	case rec.AutoDeliverUntil <= 0 || at >= rec.AutoDeliverUntil:
		state, reason = "expired", "auto_horizon_elapsed"
	case budgetReason != "":
		state, reason = "expired", budgetReason
	case rec.NextAttemptAt > at || gate.NextProbeAt > at:
		state, reason = "waiting", gate.LastReason
		if reason == "" {
			reason = rec.WaitingReason
		}
		if reason == "" {
			reason = "delivery_backoff"
		}
	}
	rec.NotificationState, rec.WaitingReason = state, reason
	if state == "canceled" || state == "expired" || state == "delivered" {
		rec.NextAttemptAt = 0
	} else if gate.NextProbeAt > rec.NextAttemptAt {
		rec.NextAttemptAt = gate.NextProbeAt
	}
}

// Preserve the distinction between legacy omission and explicit zero (manual).
func (rec *Record) UnmarshalJSON(raw []byte) error {
	type plain Record
	var value plain
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	var presence struct {
		AutoDeliverUntil *int64 `json:"autoDeliverUntil"`
	}
	if err := json.Unmarshal(raw, &presence); err != nil {
		return err
	}
	*rec = Record(value)
	rec.autoDeliverUntilSet = presence.AutoDeliverUntil != nil
	return nil
}
