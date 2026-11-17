package aihserver

import (
	"context"
	"database/sql"

	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
)

type atomicUsageLedgerWriter interface {
	AppendUsageRecordWithProjection(context.Context, usageledger.Record, func(context.Context, *sql.Tx, int64) error) error
}

// projectedUsageLedger binds the existing account fact writer to the existing
// management read projection without giving either adapter ownership of another
// connection or lifecycle. A projection failure rolls back the new fact too.
type projectedUsageLedger struct {
	facts      atomicUsageLedgerWriter
	projection *managementops.UsageStore
}

func (ledger *projectedUsageLedger) AppendUsageRecord(ctx context.Context, record usageledger.Record) error {
	if ledger == nil || ledger.facts == nil || ledger.projection == nil {
		return usageledger.ErrInvalidRecord
	}
	project, err := ledger.projection.PrepareGoLedgerProjection(ctx, record)
	if err != nil {
		return err
	}
	if err := ledger.facts.AppendUsageRecordWithProjection(ctx, record, project); err != nil {
		return err
	}
	ledger.projection.InvalidateStatsCache()
	return nil
}

func (*projectedUsageLedger) UsageProjectionMode() string { return "go-ledger-v1" }
