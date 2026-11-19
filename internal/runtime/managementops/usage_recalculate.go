package managementops

import (
	"context"
	"errors"
	"math"

	"github.com/madou1217/ai_home/internal/adapters/usagepricing"
)

// RecalculateCostsResult summarizes an explicit pricing-driven cost rebuild.
type RecalculateCostsResult struct {
	Scanned      int `json:"scanned"`
	Recalculated int `json:"recalculated"`
	Batches      int `json:"batches"`
}

// RecalculateCosts recomputes model_usage_records.cost_usd with the currently
// active pricing table. It never deletes rows and skips models without pricing.
func (s *UsageStore) RecalculateCosts(ctx context.Context) (RecalculateCostsResult, error) {
	result := RecalculateCostsResult{}
	if s == nil || s.db == nil {
		return result, errors.New("model_usage_store_unavailable")
	}
	pricing, err := s.loadPricingSnapshot(ctx, nil)
	if err != nil {
		return result, err
	}
	if pricing.catalog == nil {
		return result, errors.New("pricing_catalog_unavailable")
	}
	query := "SELECT id, provider, model, account_ref, " +
		"input_tokens, output_tokens, " +
		"cache_read_input_tokens, cache_creation_input_tokens, " +
		"reasoning_output_tokens, cost_usd " +
		"FROM model_usage_records"
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		if isSQLiteMissingTable(err) {
			return result, nil
		}
		return result, err
	}
	defer rows.Close()
	type update struct {
		id   int64
		cost float64
	}
	batch := make([]update, 0, 500)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		result.Batches++
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		statement, err := tx.PrepareContext(ctx, "UPDATE model_usage_records SET cost_usd = ? WHERE id = ?")
		if err != nil {
			_ = tx.Rollback()
			return err
		}
		for _, item := range batch {
			if _, err := statement.ExecContext(ctx, item.cost, item.id); err != nil {
				_ = statement.Close()
				_ = tx.Rollback()
				return err
			}
		}
		_ = statement.Close()
		if err := tx.Commit(); err != nil {
			return err
		}
		batch = batch[:0]
		return nil
	}
	for rows.Next() {
		var (
			id                                    int64
			provider, model, accountRef           string
			input, output, cacheRead, cacheCreate int64
			reasoning                             int64
			oldCost                               float64
		)
		if err := rows.Scan(&id, &provider, &model, &accountRef, &input, &output, &cacheRead, &cacheCreate, &reasoning, &oldCost); err != nil {
			return result, err
		}
		result.Scanned++
		record := pricing.resolve(s.attribution, model, provider, accountRef)
		if record == nil {
			continue
		}
		cost := usagepricing.CalculateCostUSD(usagepricing.Usage{
			InputTokens: input, OutputTokens: output,
			CacheReadInputTokens: cacheRead, CacheCreationInputTokens: cacheCreate,
			ReasoningOutputTokens: reasoning,
		}, record)
		if math.Abs(cost-oldCost) <= 1e-12 {
			continue
		}
		batch = append(batch, update{id: id, cost: cost})
		result.Recalculated++
		if len(batch) >= 500 {
			if err := flush(); err != nil {
				return result, err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	if err := flush(); err != nil {
		return result, err
	}
	return result, nil
}
