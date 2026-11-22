package aihserver

import (
	"fmt"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/accountrecovery"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// accountRegistrationRuntime 是账号注册、重登与导入的装饰器产物。
//
// 从 newHandlers 拆出：注册/重登后触发模型刷新与额度刷新是一条独立链路，
// 新增装饰器只需改这里。
type accountRegistrationRuntime struct {
	registrar       *usageapp.RegistrationDecorator
	reauthenticator *usageapp.ReauthenticationDecorator
	importer        *accountapp.AccountImporter
}

func newAccountRegistrationRuntime(
	registrar *accountapp.Registrar,
	modelRefresh *accountapp.ModelRefreshCoordinator,
	usage *usageComposition,
	recoveringReauthenticator *accountrecovery.Reauthenticator,
	store *sqliteaccount.Store,
) (*accountRegistrationRuntime, error) {
	modelRefreshingRegistrar, err := accountapp.NewRegistrationModelRefreshDecorator(
		registrar,
		modelRefresh,
	)
	if err != nil {
		return nil, fmt.Errorf("创建注册模型刷新边界失败: %w", err)
	}
	scheduledRegistrar, err := usageapp.NewRegistrationDecorator(
		modelRefreshingRegistrar,
		usage,
	)
	if err != nil {
		return nil, fmt.Errorf("创建注册额度刷新边界失败: %w", err)
	}
	modelRefreshingReauthenticator, err :=
		accountapp.NewReauthenticationModelRefreshDecorator(
			recoveringReauthenticator,
			modelRefresh,
		)
	if err != nil {
		return nil, fmt.Errorf("创建重登模型刷新边界失败: %w", err)
	}
	scheduledReauthenticator, err :=
		usageapp.NewReauthenticationDecorator(
			modelRefreshingReauthenticator,
			usage,
		)
	if err != nil {
		return nil, fmt.Errorf("创建重登额度刷新边界失败: %w", err)
	}
	accountImporter, err := accountapp.NewAccountImporter(
		scheduledRegistrar,
		store,
		scheduledReauthenticator,
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号导入用例失败: %w", err)
	}
	return &accountRegistrationRuntime{
		registrar:       scheduledRegistrar,
		reauthenticator: scheduledReauthenticator,
		importer:        accountImporter,
	}, nil
}
