package inmemory

import (
	"context"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ManualAdminClearEvidence 是人工清空运行态门禁时使用的证据名。
//
// 它与 Node 的 RUNTIME_CLEAR_EVIDENCE 以及 core/accounts 的状态转移事件同名：证据名
// 就是两端并行比对的键，改名会让日志与排查口径分叉。
const ManualAdminClearEvidence = accountcore.StatusEventManualAdminClear

// ClearManualAdminBlocks 人工清空目标账号在运行态门禁里的全部阻塞（manual_admin_clear）。
//
// 清理范围与 Node 的 account-runtime-gate.forceRecover 对齐：账号级与模型级的真相源
// 阻塞、上游失败观察、持久化运行态投影，以及该账号全部模型 cooldown 与连败记录。
// remaining 有意保留——额度权重来自最新额度快照，不是阻塞，人工恢复不该把它抹成未知。
//
// 它只清内存投影：持久化账号文档仍是真相源，文档若仍记录 auth_invalid 等失败，
// 下一次 ApplyAccountState 会把阻塞重新投影回来；要长期恢复必须同时修真相源。
//
// 返回值是本次实际使用的证据名（恒为 ManualAdminClearEvidence），调用方可以原样透出，
// 不需要自己复制字符串。
func (runtime *Runtime) ClearManualAdminBlocks(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.StatusEventKind, error) {
	if err := runtime.validateManualClear(ctx, accountRef); err != nil {
		return "", err
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.clearAccountRuntime(accountRef)
	return ManualAdminClearEvidence, nil
}

// validateManualClear 拒绝无效的人工覆盖请求。
//
// 人工覆盖不读凭据也不写数据库，因此不看 ctx 是否已取消：它的语义就是「立刻归零」，
// 与 CheckEligibility / ClearAccountBlock 那类需要访问外部真相源的路径不同。
func (runtime *Runtime) validateManualClear(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if runtime == nil ||
		ctx == nil ||
		!accountRef.IsValid() ||
		runtime.cooldowns == nil ||
		runtime.accountBlocks == nil ||
		runtime.modelBlocks == nil {
		return ErrInvalidRequest
	}
	return nil
}

// clearAccountRuntime 在写锁内清空一个账号的调度门禁；调用方必须已持有写锁。
func (runtime *Runtime) clearAccountRuntime(accountRef accountcore.AccountRef) {
	delete(runtime.accountBlocks, accountRef)
	delete(runtime.accountFailures, accountRef)
	delete(runtime.persistedFailures, accountRef)
	for route := range runtime.modelBlocks {
		if route.AccountRef() == accountRef {
			delete(runtime.modelBlocks, route)
		}
	}
	for route := range runtime.modelFailures {
		if route.AccountRef() == accountRef {
			delete(runtime.modelFailures, route)
		}
	}
	runtime.cooldowns.ForgetAccount(accountRef)
}
