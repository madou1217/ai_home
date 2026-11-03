package inferencegateway

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/application/accountcredentials"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// pendingAccountFailure 保存尚不能归因到账号的请求局部失败。
type pendingAccountFailure struct {
	providerID  string
	route       runtimecore.ModelRoute
	observation accountcredentials.CredentialObservation
	failure     AttemptFailure
}

// requestAccountFailureRecorder 把请求级归因与账号运行态写入解耦。
//
// 明确失败立即记录；歧义失败只在后续账号成功、或请求结束时只有一条证据时记录。
// 同一请求跨两个及以上账号都出现歧义失败，说明请求或共享资源同样可能是根因，
// 此时丢弃账号状态写入，但客户端终态仍由 Coordinator 独立保留。
type requestAccountFailureRecorder struct {
	failures *ObservedAttemptRecorder
	pending  []pendingAccountFailure
	indices  map[string]int
}

// newRequestAccountFailureRecorder 创建不跨请求共享状态的失败归因器。
func newRequestAccountFailureRecorder(
	failures *ObservedAttemptRecorder,
) *requestAccountFailureRecorder {
	return &requestAccountFailureRecorder{
		failures: failures,
		indices:  make(map[string]int),
	}
}

// Record 立即写入明确失败，并按账号模型元组暂存歧义失败。
func (recorder *requestAccountFailureRecorder) Record(
	ctx context.Context,
	providerID string,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	failure AttemptFailure,
) error {
	if !failure.DefersAccountFailureUntilRequestOutcome() {
		return recorder.recordCurrentFailure(ctx, route, observation, failure)
	}
	key := pendingFailureAccountKey(providerID, route)
	entry := pendingAccountFailure{
		providerID:  strings.TrimSpace(providerID),
		route:       route,
		observation: observation,
		failure:     failure,
	}
	if index, found := recorder.indices[key]; found {
		recorder.pending[index] = entry
		return nil
	}
	recorder.indices[key] = len(recorder.pending)
	recorder.pending = append(recorder.pending, entry)
	return nil
}

// ForgetPending 清除当前请求中已被后续成功证伪的同账号模型模糊失败。
func (recorder *requestAccountFailureRecorder) ForgetPending(
	providerID string,
	route runtimecore.ModelRoute,
) {
	if recorder == nil {
		return
	}
	key := pendingFailureAccountKey(providerID, route)
	index, found := recorder.indices[key]
	if !found {
		return
	}
	last := len(recorder.pending) - 1
	if index != last {
		recorder.pending[index] = recorder.pending[last]
		moved := recorder.pending[index]
		movedKey := pendingFailureAccountKey(moved.providerID, moved.route)
		recorder.indices[movedKey] = index
	}
	recorder.pending[last] = pendingAccountFailure{}
	recorder.pending = recorder.pending[:last]
	delete(recorder.indices, key)
}

// FinalizeSuccess 只提交与成功 route 相同 Provider 和 effective model 的暂存失败。
// 另一个 fallback 模型或 Provider 的成功不能证明此前模糊失败属于账号。
func (recorder *requestAccountFailureRecorder) FinalizeSuccess(
	ctx context.Context,
	providerID string,
	route runtimecore.ModelRoute,
) error {
	pending := recorder.takePending()
	successGroup := pendingFailureGroupKey(providerID, route)
	for _, entry := range pending {
		if pendingFailureGroupKey(entry.providerID, entry.route) != successGroup {
			continue
		}
		if err := recorder.recordCurrentFailure(
			ctx,
			entry.route,
			entry.observation,
			entry.failure,
		); err != nil {
			return err
		}
	}
	return nil
}

// FinalizeFailure 按 Provider 和 effective model 独立判断歧义账号数。
// 同一组有两个及以上账号失败时不污染账号状态；不同 fallback 组互不证明。
func (recorder *requestAccountFailureRecorder) FinalizeFailure(
	ctx context.Context,
) error {
	pending := recorder.takePending()
	accountsByGroup := make(map[string]map[string]struct{}, len(pending))
	for _, entry := range pending {
		group := pendingFailureGroupKey(entry.providerID, entry.route)
		accounts := accountsByGroup[group]
		if accounts == nil {
			accounts = make(map[string]struct{})
			accountsByGroup[group] = accounts
		}
		accounts[entry.route.AccountRef().String()] = struct{}{}
	}
	for _, entry := range pending {
		group := pendingFailureGroupKey(entry.providerID, entry.route)
		if len(accountsByGroup[group]) >= 2 {
			continue
		}
		if err := recorder.recordCurrentFailure(
			ctx,
			entry.route,
			entry.observation,
			entry.failure,
		); err != nil {
			return err
		}
	}
	return nil
}

// recordCurrentFailure 在唯一运行态写入点复核请求读取的凭据快照。
//
// 存储暂时不可验证时与已变化采用相同的 fail-closed 语义：保留上游 HTTP 终态
// 和换号决策，但不把无法证明归属的失败写入任何账号代次。
func (recorder *requestAccountFailureRecorder) recordCurrentFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	failure AttemptFailure,
) error {
	if recorder == nil || recorder.failures == nil {
		return nil
	}
	_, err := recorder.failures.RecordFailure(
		ctx,
		route,
		observation,
		failure,
	)
	return err
}

func (recorder *requestAccountFailureRecorder) takePending() []pendingAccountFailure {
	pending := recorder.pending
	recorder.pending = nil
	clear(recorder.indices)
	return pending
}

func pendingFailureAccountKey(
	providerID string,
	route runtimecore.ModelRoute,
) string {
	return pendingFailureGroupKey(providerID, route) + "\x00" + route.AccountRef().String()
}

func pendingFailureGroupKey(
	providerID string,
	route runtimecore.ModelRoute,
) string {
	return strings.TrimSpace(providerID) + "\x00" + route.ModelID().String()
}
