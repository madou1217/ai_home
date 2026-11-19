package aihserver

import (
	"context"

	"github.com/madou1217/ai_home/application/accountscheduling"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// relayQuotaBuckets 让透传通道的档位归因与选号/诊断同源。
//
// 档位事实来自额度门禁（它已经读过该账号的快照），选哪一档由调度策略决定：
// 这里只做一次组合，不复制任何 Provider 语义。
type relayQuotaBuckets struct {
	gate      *usageSchedulingGate
	evaluator *accountscheduling.Evaluator
}

// QuotaBucket 返回该 (账号, 模型) 本次消费的额度档位；空表示不区分档位。
func (source relayQuotaBuckets) QuotaBucket(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
) (string, error) {
	if source.gate == nil || source.evaluator == nil {
		return "", nil
	}
	decision, err := source.gate.EvaluateScheduling(ctx, providerID, accountRef, modelID)
	if err != nil {
		return "", err
	}
	if decision.Blocked {
		return "", nil
	}
	verdict := source.evaluator.Evaluate(accountscheduling.Evidence{
		Provider:   providerID,
		AccountRef: accountRef.String(),
		ModelID:    modelID.String(),
		Account:    accountscheduling.AccountFacts{Enabled: true, Configured: true},
		Buckets:    decision.Buckets,
	})
	return verdict.Bucket, nil
}
