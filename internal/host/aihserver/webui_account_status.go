package aihserver

import (
	"context"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountrefreshapi"
)

// errAccountStatusStoreMissing 表示状态段没有接上账号存储。
var errAccountStatusStoreMissing = errors.New("账号存储未接线")

// webuiAccountStatusRefresher 实现 WebUI 账号刷新作业的「状态」段。
//
// 状态段只复核账号的持久事实是否仍然可读：凭据文档能重新解码并核对引用，运行态
// 文档能重新解析。它不访问上游、不写任何数据——本地事实损坏时上游探测照样可能
// 成功，用一次成功掩盖「没刷新」会让界面继续展示一个读不出来的账号。
type webuiAccountStatusRefresher struct {
	store *sqliteaccount.Store
}

// 编译期确认状态段满足账号刷新接口的端口定义。
var _ webuiaccountrefreshapi.StatusRefresher = webuiAccountStatusRefresher{}

// RefreshAccountStatus 复核单个账号的持久事实。
//
// 凭据缺失或损坏一律报错，让这一段在作业里显式失败；运行态文档不存在是正常状态
// （账号从未被上游标记过），只有存在却解析不出来才算失败。
func (refresher webuiAccountStatusRefresher) RefreshAccountStatus(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if !accountRef.IsValid() {
		return accountcore.ErrInvalidAccountRef
	}
	if refresher.store == nil {
		return errAccountStatusStoreMissing
	}
	if _, err := refresher.store.GetCredentialSnapshot(ctx, accountRef); err != nil {
		return fmt.Errorf("凭据不可读: %w", err)
	}
	if _, err := refresher.store.GetAccountState(ctx, accountRef); err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			return nil
		}
		return fmt.Errorf("运行态文档不可读: %w", err)
	}
	return nil
}
