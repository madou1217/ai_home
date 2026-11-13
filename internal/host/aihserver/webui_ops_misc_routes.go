package aihserver

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/runtime/codexresetcredit"
	"github.com/madou1217/ai_home/internal/runtime/scheduledtasks"
	"github.com/madou1217/ai_home/internal/runtime/taskhub"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountoutcomesapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuicodexresetcreditapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipeerapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuischeduledtasksapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverrestartapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitasksapi"
)

// webuiOpsMiscPorts 允许组合根或测试注入共享作业池与外部端口。
type webuiOpsMiscPorts struct {
	Hub                *taskhub.Hub
	EnvironmentJobs    *environment.JobManager
	ActivityService    *accountactivity.Service
	ActivityAccounts   accountactivity.AccountLister
	ScheduledTasks     *scheduledtasks.Service
	SkipSchedulerStart bool
	CodexTransport     codexresetcredit.Transport
	ServerRestarter    webuiserverrestartapi.Restarter
	OnResetConfirmed   func(ctx context.Context, accountRef string)
}

func newNativeActivityExecutor(dependencies webuiRouteDependencies) accountactivity.Executor {
	return accountactivity.NewNativeExecutor(accountactivity.NativeExecutorOptions{
		AIHomeDir:   dependencies.AIHomeDir,
		HostHomeDir: dependencies.HostHomeDir,
		Catalog:     accountactivity.BuiltinCatalog(),
		OnClaimed: func(_ context.Context, _ string, accountRef string, result map[string]any) {
			usageSvc := dependencies.UsageService
			if usageSvc == nil || result == nil {
				return
			}
			status, _ := result["status"].(string)
			normalizedStatus := strings.ToLower(strings.TrimSpace(status))
			if normalizedStatus != "claimed" && normalizedStatus != "already_claimed" {
				return
			}
			ref, parseErr := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
			if parseErr != nil {
				return
			}
			go func() {
				refreshCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				_, _ = usageSvc.RefreshUsage(refreshCtx, ref)
			}()
		},
	})
}

// buildWebUIOpsMiscRoutes 装配运维与杂项 WebUI 管理路由：
//   - peer 只读消息与 watch（/v1/management/webui/peer/messages*）
//   - 账号请求结果汇总视图（/v1/management/webui/account-outcomes）
//   - 统一活跃任务队列与 watch（/v1/management/webui/tasks*）
//   - 计划任务调度与运行记录（/v1/management/webui/scheduled-tasks*）
//   - Codex 额度重置卡与幂等消费（/v1/management/webui/accounts/codex/*）
//   - server 配置重启触发（/v1/management/webui/server/restart）
func buildWebUIOpsMiscRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUIOpsMiscRoutesWithPorts(dependencies, webuiOpsMiscPorts{})
}

func buildWebUIOpsMiscRoutesWithPorts(
	dependencies webuiRouteDependencies,
	ports webuiOpsMiscPorts,
) ([]webuiRoute, error) {
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}

	peerHandler, err := webuipeerapi.NewHandler(webuipeerapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		AIHomeDir:  aiHome,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 peer 消息只读接口失败: %w", err)
	}

	// 跳过 nil *sqliteaccount.Store 指针，避免传入类型化 nil accountoutcomes.Reader。
	var goOutcomes accountoutcomes.Reader
	if dependencies.Store != nil {
		goOutcomes = dependencies.Store
	}
	outcomesHandler, err := webuiaccountoutcomesapi.NewHandler(webuiaccountoutcomesapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		GoOutcomes: goOutcomes,
		AIHomeDir:  aiHome,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号结果汇总接口失败: %w", err)
	}

	hub := ports.Hub
	if hub == nil {
		hub = taskhub.NewHub()
	}
	if ports.EnvironmentJobs != nil {
		taskhub.AttachEnvironmentJobs(context.Background(), hub, ports.EnvironmentJobs)
	}

	activityAccounts := ports.ActivityAccounts
	if activityAccounts == nil && aiHome != "" {
		lister, listerErr := accountactivity.NewCredentialAccountLister(aiHome)
		if listerErr != nil {
			return nil, fmt.Errorf("创建计划任务账号来源失败: %w", listerErr)
		}
		activityAccounts = lister
	}

	activitySvc := ports.ActivityService
	if activitySvc != nil {
		taskhub.AttachAccountActivityJobs(hub, activitySvc.Jobs())
	} else if activityAccounts != nil {
		activityJobs := accountactivity.NewJobManager(time.Now, taskhub.AccountActivityChangedHandler(hub))
		createdActivitySvc, svcErr := accountactivity.NewService(accountactivity.ServiceDependencies{
			Catalog:  accountactivity.BuiltinCatalog(),
			Accounts: activityAccounts,
			Executor: newNativeActivityExecutor(dependencies),
			Jobs:     activityJobs,
			Now:      time.Now,
		})
		if svcErr != nil {
			return nil, fmt.Errorf("创建计划任务账号活动服务失败: %w", svcErr)
		}
		activitySvc = createdActivitySvc
		taskhub.AttachAccountActivityJobs(hub, activitySvc.Jobs())
	}

	tasksHandler, err := webuitasksapi.NewHandler(webuitasksapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Hub:        hub,
	})
	if err != nil {
		return nil, fmt.Errorf("创建任务队列接口失败: %w", err)
	}

	// nil 接口保护：未显式传入 Restarter 且 NodeBaseURL 为空时保持 nil，让 Handler 明确回 503。
	restarter := ports.ServerRestarter
	if restarter == nil {
		if hostRestarter := webuiserverrestartapi.NewHostRestarter(webuiserverrestartapi.HostRestarterOptions{
			BaseURL:       dependencies.NodeBaseURL,
			ManagementKey: dependencies.ManagementKey,
		}); hostRestarter != nil {
			restarter = hostRestarter
		}
	}
	serverRestartHandler, err := webuiserverrestartapi.NewHandler(webuiserverrestartapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Restarter:  restarter,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 server 重启接口失败: %w", err)
	}

	routes := []webuiRoute{
		{Pattern: "GET " + webuipeerapi.MessagesPath, Handler: peerHandler},
		{Pattern: "GET " + webuipeerapi.WatchPath, Handler: peerHandler},
		{Pattern: "GET " + webuiaccountoutcomesapi.Path, Handler: outcomesHandler},
		{Pattern: "GET " + webuitasksapi.Path, Handler: tasksHandler},
		{Pattern: "GET " + webuitasksapi.WatchPath, Handler: tasksHandler},
		{Pattern: "POST " + webuiserverrestartapi.Path, Handler: serverRestartHandler},
	}

	scheduledSvc := ports.ScheduledTasks
	if scheduledSvc == nil && aiHome != "" {
		createdScheduledSvc, schedErr := scheduledtasks.NewService(scheduledtasks.ServiceDependencies{
			AIHomeDir:        aiHome,
			Catalog:          accountactivity.BuiltinCatalog(),
			ActivityService:  activitySvc,
			ActivityAccounts: activityAccounts,
			Now:              time.Now,
		})
		if schedErr != nil {
			return nil, fmt.Errorf("创建计划任务服务失败: %w", schedErr)
		}
		if !ports.SkipSchedulerStart {
			createdScheduledSvc.Start()
		}
		scheduledSvc = createdScheduledSvc
	}
	if scheduledSvc != nil {
		scheduledHandler, schedHandlerErr := webuischeduledtasksapi.NewHandler(webuischeduledtasksapi.Dependencies{
			Authorizer: dependencies.Authorizer,
			Service:    scheduledSvc,
		})
		if schedHandlerErr != nil {
			return nil, fmt.Errorf("创建计划任务接口失败: %w", schedHandlerErr)
		}
		routes = append(routes,
			webuiRoute{Pattern: "GET " + webuischeduledtasksapi.TasksPath, Handler: scheduledHandler},
			webuiRoute{Pattern: "POST " + webuischeduledtasksapi.TasksPath, Handler: scheduledHandler},
			webuiRoute{Pattern: "GET " + webuischeduledtasksapi.RecordsPath, Handler: scheduledHandler},
			webuiRoute{Pattern: "POST " + webuischeduledtasksapi.PreviewPath, Handler: scheduledHandler},
			webuiRoute{Pattern: "POST " + webuischeduledtasksapi.ActionPrefix + "{taskId}/run", Handler: scheduledHandler},
			webuiRoute{Pattern: "POST " + webuischeduledtasksapi.ActionPrefix + "{taskId}/toggle", Handler: scheduledHandler},
			webuiRoute{Pattern: "POST " + webuischeduledtasksapi.ActionPrefix + "{taskId}/delete", Handler: scheduledHandler},
		)
	}

	if aiHome != "" {
		transport := ports.CodexTransport
		if transport == nil {
			var creds codexresetcredit.CredentialReader
			if dependencies.Store != nil {
				creds = dependencies.Store
			}
			transport = &codexresetcredit.StdioTransport{
				AIHomeDir:   aiHome,
				HostHomeDir: hostHome,
				Credentials: creds,
			}
		}
		onResetConfirmed := ports.OnResetConfirmed
		if onResetConfirmed == nil && dependencies.UsageService != nil {
			usageSvc := dependencies.UsageService
			onResetConfirmed = func(ctx context.Context, accountRef string) {
				ref, parseErr := accountcore.ParseAccountRef(accountRef)
				if parseErr != nil {
					return
				}
				// 已确认的重置成功后只触发一次可信用量刷新；刷新失败不能把消费改写为失败。
				_, _ = usageSvc.RefreshUsage(ctx, ref)
			}
		}
		codexResetSvc, resetErr := codexresetcredit.NewService(codexresetcredit.ServiceDependencies{
			AIHomeDir:        aiHome,
			Transport:        transport,
			OnResetConfirmed: onResetConfirmed,
		})
		if resetErr != nil {
			return nil, fmt.Errorf("创建 Codex 重置卡服务失败: %w", resetErr)
		}
		codexResetHandler, resetHandlerErr := webuicodexresetcreditapi.NewHandler(webuicodexresetcreditapi.Dependencies{
			Authorizer: dependencies.Authorizer,
			Service:    codexResetSvc,
		})
		if resetHandlerErr != nil {
			return nil, fmt.Errorf("创建 Codex 重置卡接口失败: %w", resetHandlerErr)
		}
		routes = append(routes,
			webuiRoute{Pattern: "GET " + webuicodexresetcreditapi.ListPatternPrefix + "{accountRef}/reset-credits", Handler: codexResetHandler},
			webuiRoute{Pattern: "POST " + webuicodexresetcreditapi.ListPatternPrefix + "{accountRef}/reset-credits/consume", Handler: codexResetHandler},
			webuiRoute{Pattern: "GET " + webuicodexresetcreditapi.ListPatternPrefix + "{accountRef}/reset-operations/{operationId}", Handler: codexResetHandler},
			webuiRoute{Pattern: "GET " + webuicodexresetcreditapi.ListPatternPrefix + "{accountRef}/reset-operations/{operationId}/watch", Handler: codexResetHandler},
			webuiRoute{Pattern: "POST " + webuicodexresetcreditapi.ListPatternPrefix + "{accountRef}/reset-operations/{operationId}/reconcile", Handler: codexResetHandler},
		)
	}

	return routes, nil
}
