package pluginhost

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	plugincontrol "github.com/madou1217/ai_home/application/plugincontrol"
	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	adapterplugins "github.com/madou1217/ai_home/internal/adapters/pluginruntime"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

// ServiceOptions 配置统一的 Go 插件宿主组合根。
type ServiceOptions struct {
	AIHomeDir               string
	RepoRoot                string
	HostVersion             string
	NodeVersion             string
	NodePath                string
	NodeArgs                []string
	EntryPath               string
	HooksPath               string
	SocketPath              string
	Registry                *appplugins.Registry
	AccountDescriber        appplugins.AccountDescriber
	ObserverQueueSize       int
	PricingService          *pricingcatalog.Service
	PricingRefreshInterval  time.Duration
	OnPricingApplied        func(context.Context)
	ResolveHandler          HandlerResolver
	OnProviderDescriptors   func(DescriptorCollectResult)
	OnAudit                 func(operation string, details map[string]any)
	OnLog                   func(string)
	RecycleAfterGenerations int
	RetireTimeout           time.Duration
	TicketTTL               time.Duration
	BackoffSchedule         []time.Duration
	MaxConsecutiveFailures  int
	StateReader             ControlStateReader
	SupervisorFactory       func(seq int64) (HostClient, error)
}

// Service 对外提供 Go 侧插件宿主的完整生命周期与各域门面：
// Runtime、ControlPreparer（plugincontrol.RuntimePreparer）、Registry、HostInvoker、Observer 与 PricingSync。
type Service struct {
	registry       *appplugins.Registry
	invoker        *adapterplugins.HostInvoker
	observer       *appplugins.Observer
	runtime        *Runtime
	preparer       *ControlPreparer
	pricingService *pricingcatalog.Service
	pricingSync    *PricingSync
}

// NewService 创建并装配完整的插件宿主运行服务。
func NewService(options ServiceOptions) (*Service, error) {
	registry := options.Registry
	if registry == nil {
		registry = appplugins.NewRegistry()
	}
	invoker := adapterplugins.NewHostInvoker(registry)
	observer := appplugins.NewObserver(invoker, registry, options.AccountDescriber, options.ObserverQueueSize)

	pricingSvc := options.PricingService
	if pricingSvc == nil && strings.TrimSpace(options.AIHomeDir) != "" {
		store, err := pricingcatalog.NewStore(options.AIHomeDir)
		if err != nil {
			observer.Close()
			_ = invoker.Close()
			return nil, err
		}
		pricingSvc, err = pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
			Store:      store,
			HTTPClient: &http.Client{Timeout: 15 * time.Second},
		})
		if err != nil {
			observer.Close()
			_ = invoker.Close()
			return nil, err
		}
	}

	rt, err := NewRuntime(RuntimeOptions{
		AIHomeDir:               options.AIHomeDir,
		RepoRoot:                options.RepoRoot,
		SocketPath:              options.SocketPath,
		HostVersion:             options.HostVersion,
		NodePath:                options.NodePath,
		NodeArgs:                options.NodeArgs,
		EntryPath:               options.EntryPath,
		HooksPath:               options.HooksPath,
		Registry:                registry,
		SupervisorFactory:       options.SupervisorFactory,
		ResolveHandler:          options.ResolveHandler,
		OnProviderDescriptors:   options.OnProviderDescriptors,
		OnLog:                   options.OnLog,
		RecycleAfterGenerations: options.RecycleAfterGenerations,
		RetireTimeout:           options.RetireTimeout,
		TicketTTL:               options.TicketTTL,
		BackoffSchedule:         options.BackoffSchedule,
		MaxConsecutiveFailures:  options.MaxConsecutiveFailures,
	})
	if err != nil {
		observer.Close()
		_ = invoker.Close()
		return nil, err
	}

	preparer, err := NewControlPreparer(ControlPreparerOptions{
		AIHomeDir:   options.AIHomeDir,
		HostVersion: options.HostVersion,
		NodeVersion: options.NodeVersion,
		Reader:      options.StateReader,
		Runtime:     rt,
		OnAudit:     options.OnAudit,
	})
	if err != nil {
		observer.Close()
		_ = invoker.Close()
		return nil, err
	}

	rt.SetDesiredPluginsFunc(preparer.DesiredPlugins)
	var pricingSync *PricingSync
	if pricingSvc != nil {
		pricingSync, err = NewPricingSync(PricingSyncOptions{
			Runtime:         rt,
			PricingService:  pricingSvc,
			RefreshInterval: options.PricingRefreshInterval,
			OnApplied:       options.OnPricingApplied,
			OnLog:           options.OnLog,
		})
		if err != nil {
			observer.Close()
			_ = invoker.Close()
			return nil, err
		}
		rt.SetOnRuntimeChange(pricingSync.NotifyRuntimeChanged)
	}

	return &Service{
		registry:       registry,
		invoker:        invoker,
		observer:       observer,
		runtime:        rt,
		preparer:       preparer,
		pricingService: pricingSvc,
		pricingSync:    pricingSync,
	}, nil
}

// Start 读取期望插件列表激活初始代次，并启动价格同步周期任务。
func (s *Service) Start(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.runtime.Start(ctx); err != nil {
		return err
	}
	if s.pricingSync != nil {
		return s.pricingSync.Start(ctx)
	}
	return nil
}

// Close 按顺序停止价格同步、宿主运行时、观察投递器与连接池。
func (s *Service) Close() error {
	if s == nil {
		return nil
	}
	if s.pricingSync != nil {
		s.pricingSync.Stop()
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var errs []error
	if s.runtime != nil {
		if err := s.runtime.Stop(stopCtx); err != nil {
			errs = append(errs, err)
		}
	}
	if s.observer != nil {
		s.observer.Close()
	}
	if s.invoker != nil {
		if err := s.invoker.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Service) Registry() *appplugins.Registry        { return s.registry }
func (s *Service) Invoker() *adapterplugins.HostInvoker  { return s.invoker }
func (s *Service) Observer() *appplugins.Observer        { return s.observer }
func (s *Service) Runtime() *Runtime                     { return s.runtime }
func (s *Service) Preparer() plugincontrol.RuntimePreparer { return s.preparer }
func (s *Service) PricingService() *pricingcatalog.Service { return s.pricingService }
func (s *Service) PricingSync() *PricingSync             { return s.pricingSync }

// Operator 基于本机 RuntimePreparer 组装进程内 InstanceOperator，不再依赖 Node HTTP 内部协议。
func (s *Service) Operator(
	revisions plugincontrol.StateRevisionReader,
	committer plugincontrol.CandidateCommitter,
) (*plugincontrol.InstanceOperator, error) {
	return plugincontrol.NewInstanceOperator(revisions, committer, s.preparer)
}

// SyncPricingNow 立即执行一轮定价目录同步。
func (s *Service) SyncPricingNow(ctx context.Context) error {
	if s == nil || s.pricingSync == nil {
		return nil
	}
	return s.pricingSync.SyncNow(ctx)
}

// PushControlState 重新从持久存储读取 desiredPlugins 并触发运行时收敛（供 install/uninstall/enable/disable 后同步）。
func (s *Service) PushControlState(ctx context.Context) error {
	if s == nil || s.runtime == nil {
		return nil
	}
	return s.runtime.PushDesired(ctx)
}

func (s *Service) Status(ctx context.Context) RuntimeStatus {
	return s.runtime.Status(ctx)
}

func (s *Service) Doctor(ctx context.Context) DoctorReport {
	return s.preparer.Doctor(ctx)
}
