package peer

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
)

func authorizeTransport(ctx context.Context, rec Record, opts DeliveryOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := probeAuthoritative(ctx, rec.To, opts); err != nil {
		return err
	}
	if opts.BeforeSend == nil && rec.Claim != nil {
		home := ResolvePeerAIHomeDir(opts.AIHomeDir, opts.HostHomeDir, opts.Getenv)
		if err := NewDispatchStore(home, StoreOptions{Now: opts.Now}).CheckDelivery(ctx, rec); err != nil {
			return err
		}
	}
	if opts.BeforeSend != nil {
		if err := opts.BeforeSend(ctx, rec); err != nil {
			return err
		}
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	projectNotificationAt(&rec, TargetGate{}, now().UnixMilli())
	switch rec.NotificationState {
	case "canceled", "expired", "manual":
		return &policyError{reason: rec.WaitingReason}
	}
	return nil
}

func blockedDelivery(err error) DeliveryResult {
	var blocked *policyError
	if errors.As(err, &blocked) {
		if blocked.reason == "already_read" {
			return DeliveryResult{OK: true}
		}
		return DeliveryResult{Error: blocked.reason}
	}
	if errors.Is(err, ErrClaimLost) {
		return DeliveryResult{Error: "peer_claim_lost"}
	}
	return DeliveryResult{Error: "target_probe_unavailable", Message: err.Error()}
}

// FlushPending probes at most one message per target per batch. Ordering by the
// persisted lastProbeAt makes fairness survive new messages and process restarts.
func FlushPending(ctx context.Context, store *DispatchStore, opts FlushOptions) (FlushSummary, error) {
	var summary FlushSummary
	if store == nil {
		return summary, ErrStoreUnavailable
	}
	if _, err := store.RecoverStaleInflight(); err != nil {
		return summary, err
	}
	if _, err := store.ReconcileSupersedes(); err != nil {
		return summary, err
	}
	if _, err := store.ReconcileRead(); err != nil {
		return summary, err
	}
	if _, err := store.ExpireStale(opts.ExpireAge); err != nil {
		return summary, err
	}
	pending, err := store.ListPending()
	if err != nil {
		return summary, err
	}
	now := opts.Now
	if now == nil {
		now = store.now
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	type candidate struct {
		rec         Record
		lastProbeAt int64
	}
	candidates := make([]candidate, 0)
	seen := make(map[string]bool)
	for _, rec := range pending {
		key := TargetKey(rec.To)
		if seen[key] || rec.NotificationState != "ready" {
			continue
		}
		gate, err := store.readTargetGate(rec.To)
		if err != nil {
			continue
		} // damaged target remains visible/manual, healthy targets continue
		seen[key] = true
		candidates = append(candidates, candidate{rec, gate.LastProbeAt})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].lastProbeAt != candidates[j].lastProbeAt {
			return candidates[i].lastProbeAt < candidates[j].lastProbeAt
		}
		if candidates[i].rec.CreatedAt != candidates[j].rec.CreatedAt {
			return candidates[i].rec.CreatedAt < candidates[j].rec.CreatedAt
		}
		return candidates[i].rec.ID < candidates[j].rec.ID
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	delivery := opts.Delivery
	if delivery.Now == nil {
		delivery.Now = now
	}
	if delivery.AIHomeDir == "" {
		delivery.AIHomeDir = store.AIHomeDir()
	}
	upstreamGuard := delivery.BeforeSend
	delivery.BeforeSend = func(ctx context.Context, rec Record) error {
		if upstreamGuard != nil {
			if err := upstreamGuard(ctx, rec); err != nil {
				return err
			}
		}
		return store.CheckDelivery(ctx, rec)
	}
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			break
		}
		claimed, ok, err := store.Claim(candidate.rec.ID)
		if err != nil {
			return summary, err
		}
		if !ok || claimed == nil {
			continue
		}
		summary.Attempted++
		res := DeliverRecord(ctx, *claimed, delivery)
		switch {
		case res.OK:
			_, err = store.SettleDeliveryResult(claimed, res)
			if err == nil {
				summary.Delivered++
			}
		case IsTerminalDeliveryError(res.Error):
			_, err = store.SettleFailed(claimed, res.Error)
			if err == nil {
				summary.Failed++
			}
		default:
			_, err = store.SettlePending(claimed, res.Error, BackoffFor(DeliveryFailureCount(*claimed)+1))
			if err == nil {
				summary.Pending++
			}
		}
		// Losing an old generation is expected after concurrent recovery/ACK;
		// all other settlement failures must be observable, not silently dropped.
		if err != nil && !errors.Is(err, ErrClaimLost) {
			return summary, err
		}
	}
	return summary, nil
}

func probeAuthoritative(ctx context.Context, to RecordParty, opts DeliveryOptions) error {
	if opts.ProbeTarget == nil || strings.TrimSpace(to.Channel) == "native" {
		return nil
	} // optional capability, not an idle observation
	state, err := opts.ProbeTarget(ctx, to)
	if err != nil {
		return &policyError{reason: "target_state_unknown"}
	}
	switch state {
	case "idle":
		return nil
	case "busy", "working", "running", "starting", "waiting_input":
		return &policyError{reason: "target_busy"}
	case "draft":
		return &policyError{reason: "target_has_draft"}
	default:
		return &policyError{reason: "target_state_unknown"}
	}
}
