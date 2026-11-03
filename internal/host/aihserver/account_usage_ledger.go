package aihserver

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
)

type usageLedgerAccountReader interface {
	GetByRef(context.Context, accountcore.AccountRef) (accountcore.Account, error)
}

type usageLedgerWriter interface {
	AppendUsageRecord(context.Context, usageledger.Record) error
}

func buildUsageLedgerRecord(
	ctx context.Context,
	accounts usageLedgerAccountReader,
	route runtimecore.ModelRoute,
	success inferencegateway.AttemptSuccess,
) (usageledger.Record, error) {
	if ctx == nil || accounts == nil || !route.IsValid() || !success.IsValid() {
		return usageledger.Record{}, usageledger.ErrInvalidRecord
	}
	usage, ok := success.Usage()
	if !ok {
		return usageledger.Record{}, usageledger.ErrInvalidRecord
	}
	account, err := accounts.GetByRef(ctx, route.AccountRef())
	if err != nil {
		return usageledger.Record{}, err
	}
	if !account.IsValid() || account.Ref() != route.AccountRef() {
		return usageledger.Record{}, errors.New("usage ledger account identity mismatch")
	}
	return usageledger.NewRecord(usageledger.RecordInput{
		AccountRef: route.AccountRef(),
		Provider:   account.ProviderID(),
		Model:      route.ModelID().String(),
		OccurredAt: success.HappenedAt(),
		Usage:      usage,
	})
}
