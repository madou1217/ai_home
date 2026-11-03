package main

import (
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// newHostAccountView 把远端管理投影转换成 CLI 既有的无敏感输出模型。
func newHostAccountView(view managementapi.AccountView) aihaccount.AccountView {
	return aihaccount.AccountView{
		ProviderID:       view.ProviderID,
		CLIAccountID:     view.CLIAccountID.Int64(),
		AccountRef:       view.AccountRef.String(),
		Enabled:          view.Enabled,
		HasCredential:    view.HasCredential,
		AuthKind:         view.AuthKind,
		AuthMode:         view.AuthMode,
		HasProfile:       view.HasProfile,
		DisplayName:      view.DisplayName,
		Email:            view.Email,
		SubscriptionKind: view.SubscriptionKind,
		SubscriptionRaw:  view.SubscriptionRaw,
		ProfileUpdatedAt: view.ProfileUpdatedAt,
		CreatedAt:        view.CreatedAt,
		UpdatedAt:        view.UpdatedAt,
	}
}

// newHostAccountListResult 保留 Server 返回的分页边界并复制公开账号行。
func newHostAccountListResult(result managementapi.AccountListResult) aihaccount.ListResult {
	accounts := make([]aihaccount.AccountView, 0, len(result.Accounts))
	for _, account := range result.Accounts {
		accounts = append(accounts, newHostAccountView(account))
	}
	return aihaccount.ListResult{
		Accounts:     accounts,
		Limit:        result.Limit,
		HasMore:      result.HasMore,
		NextAfterRef: result.NextAfterRef,
	}
}

// newHostAccountModelsResult 保持模型顺序和服务端公开时间，不重新查询本地数据库。
func newHostAccountModelsResult(result managementapi.AccountModelsResult) aihaccount.AccountModelsResult {
	models := make([]aihaccount.AccountModelView, 0, len(result.Models))
	for _, model := range result.Models {
		models = append(models, aihaccount.AccountModelView{
			ModelID:           model.ModelID,
			UpstreamAvailable: model.UpstreamAvailable,
			ManualPolicy:      model.ManualPolicy,
			Effective:         model.Effective,
			UpdatedAt:         model.UpdatedAt,
		})
	}
	return aihaccount.AccountModelsResult{
		AccountRef: result.AccountRef,
		Models:     models,
	}
}
