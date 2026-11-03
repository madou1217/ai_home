package aihaccount

import (
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// AccountView 是 CLI 允许展示的单个无敏感账号投影。
type AccountView struct {
	ProviderID       string
	CLIAccountID     int64
	AccountRef       string
	Enabled          bool
	HasCredential    bool
	AuthKind         string
	AuthMode         string
	HasProfile       bool
	DisplayName      string
	Email            string
	SubscriptionKind string
	SubscriptionRaw  string
	ProfileUpdatedAt time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// newAccountView 从应用投影集中选择 CLI 允许公开的字段。
func newAccountView(overview accountapp.AccountOverview) AccountView {
	account := overview.Account()
	return AccountView{
		ProviderID:       account.ProviderID(),
		CLIAccountID:     account.CLIAccountID().Int64(),
		AccountRef:       account.Ref().String(),
		Enabled:          account.Enabled(),
		HasCredential:    overview.HasCredential(),
		AuthKind:         overview.AuthKind(),
		AuthMode:         overview.AuthMode(),
		HasProfile:       overview.HasProfile(),
		DisplayName:      overview.DisplayName(),
		Email:            overview.Email(),
		SubscriptionKind: overview.SubscriptionKind(),
		SubscriptionRaw:  overview.SubscriptionRaw(),
		ProfileUpdatedAt: overview.ProfileUpdatedAt(),
		CreatedAt:        account.CreatedAt(),
		UpdatedAt:        account.UpdatedAt(),
	}
}
