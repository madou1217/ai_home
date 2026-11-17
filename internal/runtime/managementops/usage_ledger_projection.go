package managementops

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"

	"github.com/madou1217/ai_home/core/usageledger"
)

// PrepareGoLedgerProjection resolves pricing before the fact writer opens its
// transaction. The returned projection only accesses that transaction: no
// second connection, durable queue, historical replay or background writer.
func (s *UsageStore) PrepareGoLedgerProjection(
	ctx context.Context,
	record usageledger.Record,
) (func(context.Context, *sql.Tx, int64) error, error) {
	if s == nil || s.db == nil || ctx == nil || !record.IsValid() {
		return nil, usageledger.ErrInvalidRecord
	}
	usage := record.Usage()
	if usage.TotalTokens() > math.MaxInt64 {
		return nil, errors.New("usage_ledger_projection_count_overflow")
	}
	pricing, err := s.loadPricingSnapshot(ctx, nil)
	if err != nil {
		return nil, err
	}
	// Match the old Go-feed/Anthropic projection: cache and reasoning are
	// subsets in the canonical fact, but disjoint columns in model_usage_records.
	item, err := normalizeUsageRecordInput(UsageRecordInput{
		EventKey: "go-ledger:v1:pending",
		Provider: record.Provider(), AccountRef: record.AccountRef().String(),
		SessionID: record.SessionID(), SourceKind: "server_go_gateway", Model: record.Model(),
		InputTokens:              int64(usage.InputTokens() - usage.CachedInputTokens() - usage.CacheWriteInputTokens()),
		OutputTokens:             int64(usage.OutputTokens() - usage.ReasoningTokens()),
		CacheReadInputTokens:     int64(usage.CachedInputTokens()),
		CacheCreationInputTokens: int64(usage.CacheWriteInputTokens()),
		ReasoningOutputTokens:    int64(usage.ReasoningTokens()),
		TotalTokens:              int64(usage.TotalTokens()), TimestampMS: record.OccurredAt().UnixMilli(),
	}, s.attribution, pricing)
	if err != nil || item == nil {
		if err == nil {
			err = usageledger.ErrInvalidRecord
		}
		return nil, err
	}
	return func(ctx context.Context, tx *sql.Tx, ledgerID int64) error {
		if ctx == nil || tx == nil || ledgerID <= 0 {
			return usageledger.ErrInvalidRecord
		}
		projected := *item
		projected.EventKey = fmt.Sprintf("go-ledger:v1:%d", ledgerID)
		// A ledger identifier is not a request/log identifier. Leave RequestID
		// empty rather than fabricating an HTTP correlation that does not exist.
		var matches int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_ledger
			WHERE usage_id = ? AND source_key = ? AND account_ref = ? AND provider_id = ?
			AND model_id = ? AND session_id = ? AND occurred_at_ms = ?
			AND input_tokens = ? AND output_tokens = ? AND cached_input_tokens = ?
			AND cache_write_input_tokens = ? AND reasoning_tokens = ? AND total_tokens = ?`,
			ledgerID, projected.EventKey, record.AccountRef().String(), record.Provider(),
			record.Model(), record.SessionID(), record.OccurredAt().UnixMilli(),
			usage.InputTokens(), usage.OutputTokens(), usage.CachedInputTokens(),
			usage.CacheWriteInputTokens(), usage.ReasoningTokens(), usage.TotalTokens()).Scan(&matches); err != nil {
			return err
		}
		if matches != 1 {
			return errors.New("usage_ledger_projection_fact_mismatch")
		}
		written, err := insertNormalizedUsageTx(ctx, tx, []*normalizedUsageRecord{&projected}, s.now().UnixMilli())
		if err != nil || written == 1 {
			return err
		}
		// INSERT OR IGNORE is not proof of idempotence. A colliding identity
		// must represent this exact projection, never silently swallow new data.
		var current normalizedUsageRecord
		if err := tx.QueryRowContext(ctx, `SELECT event_key, provider, account_ref, session_id,
			request_id, source_kind, model, input_tokens, output_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, reasoning_output_tokens, total_tokens, cost_usd,
			timestamp_ms, project, cwd, git_branch FROM model_usage_records WHERE event_key = ?`, projected.EventKey).Scan(
			&current.EventKey, &current.Provider, &current.AccountRef, &current.SessionID,
			&current.RequestID, &current.SourceKind, &current.Model, &current.InputTokens,
			&current.OutputTokens, &current.CacheReadInputTokens, &current.CacheCreationInputTokens,
			&current.ReasoningOutputTokens, &current.TotalTokens, &current.CostUSD,
			&current.TimestampMS, &current.Project, &current.CWD, &current.GitBranch); err != nil {
			return err
		}
		if current != projected {
			return errors.New("usage_ledger_projection_identity_conflict")
		}
		return nil
	}, nil
}
