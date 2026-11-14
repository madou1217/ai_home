package aihserver

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/transport/http/webuichatapi"
)

// WebUIChatRuntimeBuildOptions 配置宿主层 Canonical Chat Runtime 服务的装配参数。
type WebUIChatRuntimeBuildOptions struct {
	AIHomeDir           string
	HostHomeDir         string
	DBPath              string
	Catalog             *providers.Catalog
	ModelModalities     *modelsdev.Index
	AccountStore        chatruntime.AccountPoolReader
	ChatStreamer        chatruntime.ChatTurnStreamer
	ArtifactReader      chatruntime.ArtifactReader
	ApprovalCallbackURL string
	NodeExecutablePath  string
}

// BuildWebUIChatRuntimeService 构造并初始化供 WebUI 管理入口复用的 Canonical Chat Runtime Service。
func BuildWebUIChatRuntimeService(
	ctx context.Context,
	opts WebUIChatRuntimeBuildOptions,
) (*chatruntime.Service, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if hostHome == "" {
		if home, err := os.UserHomeDir(); err == nil {
			hostHome = home
		}
	}
	var checkpoints chatruntime.WorkspaceCheckpointsOpener
	if strings.TrimSpace(opts.AIHomeDir) != "" {
		checkpoints = chatruntime.DefaultWorkspaceCheckpointsOpener(opts.AIHomeDir, hostHome, nil)
	}
	svc, err := chatruntime.NewService(ctx, chatruntime.ServiceOptions{
		DBPath:               strings.TrimSpace(opts.DBPath),
		AIHomeDir:            strings.TrimSpace(opts.AIHomeDir),
		HostHomeDir:          hostHome,
		AccountStore:         opts.AccountStore,
		ProviderCatalog:      opts.Catalog,
		MetadataIndex:        opts.ModelModalities,
		ChatStreamer:         opts.ChatStreamer,
		WorkspaceCheckpoints: checkpoints,
		ArtifactReader:       opts.ArtifactReader,
		ApprovalCallbackURL:  strings.TrimSpace(opts.ApprovalCallbackURL),
		NodeExecutablePath:   strings.TrimSpace(opts.NodeExecutablePath),
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 Canonical Chat Runtime 失败: %w", err)
	}
	return svc, nil
}

// AttachWebUIChatRuntime 基于现有 webuichatapi.Handler 创建共享 Chat Runtime 服务并绑定双向端口。
func AttachWebUIChatRuntime(
	ctx context.Context,
	handler *webuichatapi.Handler,
	dependencies webuiRouteDependencies,
) (*chatruntime.Service, error) {
	if handler == nil {
		return nil, nil
	}
	var accountPool chatruntime.AccountPoolReader
	// 跳过 nil 指针，避免传入类型化 nil 接口。
	if dependencies.Store != nil {
		accountPool = dependencies.Store
	}
	approvalCallbackURL := ""
	if trimmedNodeURL := strings.TrimRight(strings.TrimSpace(dependencies.NodeBaseURL), "/"); trimmedNodeURL != "" {
		approvalCallbackURL = trimmedNodeURL + "/v0/webui/internal/approval-request"
	}
	svc, err := BuildWebUIChatRuntimeService(ctx, WebUIChatRuntimeBuildOptions{
		AIHomeDir:           dependencies.AIHomeDir,
		HostHomeDir:         dependencies.HostHomeDir,
		Catalog:             dependencies.Catalog,
		ModelModalities:     dependencies.ModelModalities,
		AccountStore:        accountPool,
		ChatStreamer:        handler.InProcessChatTurnStreamer(),
		ApprovalCallbackURL: approvalCallbackURL,
	})
	if err != nil {
		return nil, err
	}
	handler.AttachRuntime(svc, nil)
	svc.StartRecovery(ctx)
	return svc, nil
}

// BuildWebUIChatRuntimeCollectionRoutes 返回不会与 mountWebUIChat("/v1/management/webui/chat/sessions/") 冲突的集合与产物路由。
func BuildWebUIChatRuntimeCollectionRoutes(handler *webuichatapi.Handler) ([]webuiRoute, error) {
	if handler == nil {
		return nil, nil
	}
	sessionsCollectionPath := strings.TrimSuffix(webuichatapi.ManagementCollectionPath, "/")
	return []webuiRoute{
		{
			Pattern: "GET " + sessionsCollectionPath,
			Handler: http.HandlerFunc(handler.ServeSessionsCollection),
		},
		{
			Pattern: "POST " + sessionsCollectionPath,
			Handler: http.HandlerFunc(handler.ServeSessionsCollection),
		},
		{
			Pattern: "GET " + webuichatapi.ArtifactCollectionPath + "{artifactId}",
			Handler: http.HandlerFunc(handler.ServeArtifact),
		},
		{
			// 浏览器产物下载入口：处理器已识别 /v0 前缀，直接挂载即可。
			Pattern: "GET /v0/webui/chat/artifacts/{artifactId}",
			Handler: http.HandlerFunc(handler.ServeArtifact),
		},
	}, nil
}

// buildWebUIChatRuntimeRoutes 遵循 webui_*_routes 统一装配签名；集合路由复用共享 *webuichatapi.Handler。
func buildWebUIChatRuntimeRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUIChatRuntimeRoutesWithHandler(dependencies, nil)
}

func buildWebUIChatRuntimeRoutesWithHandler(
	dependencies webuiRouteDependencies,
	handler *webuichatapi.Handler,
) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || handler == nil {
		return nil, nil
	}
	return BuildWebUIChatRuntimeCollectionRoutes(handler)
}
