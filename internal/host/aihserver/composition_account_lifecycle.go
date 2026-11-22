package aihserver

import (
	"fmt"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountdeletionruntime"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/accountrecovery"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/deletionhost"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	runtimeupstreamretry "github.com/madou1217/ai_home/internal/runtime/upstreamretry"
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

// accountDeletionRuntimeHandles 是账号删除装配的两个外部句柄。
type accountDeletionRuntimeHandles struct {
	host  *deletionhost.Service
	guard *accountdeletionruntime.Guard
}

// accountDeletionInputs 收拢账号删除装配的稳定依赖。
type accountDeletionInputs struct {
	aiHomeDir          string
	hostHomeDir        string
	catalog            *providers.Catalog
	store              *sqliteaccount.Store
	nodeBaseURL        string
	managementKey      func() string
	occupancy          accountapp.DeletionOccupancy
	preparation        accountapp.DeletionPreparation
	chatRuntimeService func() *chatruntime.Service
	upstream429Store   *runtimeupstreamretry.Store
	modelRefresh       *accountapp.ModelRefreshCoordinator
	usage              *usageComposition
	accountRuntime     serverAccountRuntime
	credentials        *accountcredentials.Resolver
}

// newAccountDeletionLifecycle 装配宿主投影、删除运行保护与删除用例。
func newAccountDeletionLifecycle(inputs accountDeletionInputs) (*accountDeletionRuntimeHandles, error) {
	aiHomeDir := inputs.aiHomeDir
	catalog := inputs.catalog
	store := inputs.store
	nodeBaseURL := inputs.nodeBaseURL
	managementKey := inputs.managementKey
	deletionOccupancy := inputs.occupancy
	deletionPreparation := inputs.preparation
	chatRuntimeService := inputs.chatRuntimeService()
	upstream429Store := inputs.upstream429Store
	modelRefresh := inputs.modelRefresh
	usage := inputs.usage
	accountRuntime := inputs.accountRuntime
	credentials := inputs.credentials
	deletionHost, err := deletionhost.New(deletionhost.Options{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: inputs.hostHomeDir,
		Catalog:     catalog,
		Credentials: store,
		// Codex host credentials/default pointers now share the transactional host
		// service. Other providers remain explicitly unavailable in this adapter.
		CodexDefaults: codexDefaultProjection{aiHome: aiHomeDir, hostHome: inputs.hostHomeDir},
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号删除宿主投影失败: %w", err)
	}
	deletionRuntime, err := newAccountDeletionRuntime(aiHomeDir, catalog, nodeBaseURL, managementKey, deletionOccupancy, deletionPreparation, func() *chatruntime.Service { return chatRuntimeService }, upstream429Store)
	if err != nil {
		return nil, fmt.Errorf("创建账号删除运行保护失败: %w", err)
	}
	deleter, err := accountapp.NewDeleter(
		store,
		deletionRuntime,
		deletionRuntime,
		modelRefresh,
		usage,
		accountRuntime,
		credentials,
	)
	if err != nil {
		return nil, fmt.Errorf("创建账号删除用例失败: %w", err)
	}
	deleter.WithHostProjection(deletionHost, deletionHost)
	deletionRuntime.Bind(deleter)
	return &accountDeletionRuntimeHandles{host: deletionHost, guard: deletionRuntime}, nil
}
