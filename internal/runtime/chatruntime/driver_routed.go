package chatruntime

import (
	"context"
	"net/http"
	"strings"
	"sync"
)

// CapabilityRoutedDriverOptions 配置在 GoChatDriver 与回落原生/Codex 驱动之间按模型能力分流的路由驱动。
type CapabilityRoutedDriverOptions struct {
	Session         *Session
	Store           *PublishingStore
	Catalog         *ModelCatalogResolver
	CanonicalCaps   map[string]any
	CreateGoEntry   func(ctx context.Context) (*DriverEntry, error)
	CreateNodeEntry func(ctx context.Context) (*DriverEntry, error)
	ComposerCatalog func(ctx context.Context) (map[string]any, error)
	Diagnostics     func(map[string]any)
}

// CapabilityRoutedChatDriver 根据请求模型与附件情况按轮选择 Go Relay 或回落驱动。
type CapabilityRoutedChatDriver struct {
	opts    CapabilityRoutedDriverOptions
	session *Session

	mu        sync.Mutex
	goEntry   *DriverEntry
	nodeEntry *DriverEntry
	activeDrv Driver
}

// NewCapabilityRoutedChatDriver 创建能力分流驱动。
func NewCapabilityRoutedChatDriver(opts CapabilityRoutedDriverOptions) (*CapabilityRoutedChatDriver, error) {
	if opts.Session == nil {
		return nil, NewError("routed_driver_session_required", http.StatusUnprocessableEntity, nil)
	}
	if opts.CreateGoEntry == nil || opts.CreateNodeEntry == nil {
		return nil, NewError("routed_driver_factories_required", http.StatusInternalServerError, nil)
	}
	return &CapabilityRoutedChatDriver{
		opts:    opts,
		session: opts.Session,
	}, nil
}

// CreateCapabilityRoutedChatDriverEntry 构建动态能力快照与路由驱动包装器。
func CreateCapabilityRoutedChatDriverEntry(opts CapabilityRoutedDriverOptions) (*DriverEntry, error) {
	drv, err := NewCapabilityRoutedChatDriver(opts)
	if err != nil {
		return nil, err
	}
	canonicalCaps := CloneMap(opts.CanonicalCaps)
	if canonicalCaps == nil {
		canonicalCaps = map[string]any{}
	}
	goCaps := buildGoRouteCapabilities(canonicalCaps)
	return &DriverEntry{
		Driver:       drv,
		Capabilities: canonicalCaps,
		CapabilitiesFor: func(sess *Session) map[string]any {
			if drv.RouteForCapabilities(sess).Target == RouteTargetGo {
				return goCaps
			}
			return canonicalCaps
		},
		ComposerCatalog: opts.ComposerCatalog,
		Handlers:        map[string]CommandHandler{},
	}, nil
}

func buildGoRouteCapabilities(canonical map[string]any) map[string]any {
	base := GoChatCapabilities()
	slashCmds := stringSlice(canonical["slashCommands"])
	if len(slashCmds) == 0 {
		slashCmds = []string{"compact", "goal", "plan"}
	}
	return map[string]any{
		"revision":           "go-chat-relay-v1",
		"capabilities":       base["capabilities"],
		"slashCommands":      slashCmds,
		"slashPassthrough":   false,
		"turnInterveneModes": []string{},
	}
}

// RouteForCapabilities 仅根据会话当前模型/绑定账号判断能力快照应展示 Go 还是回落驱动。
func (d *CapabilityRoutedChatDriver) RouteForCapabilities(sess *Session) ChatTurnRouteResult {
	if sess == nil {
		sess = d.session
	}
	return d.resolveRoute(context.Background(), sess, nil, nil)
}

func (d *CapabilityRoutedChatDriver) resolveRoute(
	ctx context.Context,
	sess *Session,
	payload map[string]any,
	imagePaths []string,
) ChatTurnRouteResult {
	if d.opts.Catalog == nil {
		return ChatTurnRouteResult{Target: RouteTargetFallback, Reason: "catalog_unavailable"}
	}
	return d.opts.Catalog.ResolveChatTurnRoute(ctx, sess, payload, imagePaths)
}

func (d *CapabilityRoutedChatDriver) ensureGoEntry(ctx context.Context) (*DriverEntry, error) {
	d.mu.Lock()
	existing := d.goEntry
	d.mu.Unlock()
	if existing != nil {
		return existing, nil
	}
	entry, err := d.opts.CreateGoEntry(ctx)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	if d.goEntry == nil {
		d.goEntry = entry
	}
	res := d.goEntry
	d.mu.Unlock()
	return res, nil
}

func (d *CapabilityRoutedChatDriver) ensureNodeEntry(ctx context.Context) (*DriverEntry, error) {
	d.mu.Lock()
	existing := d.nodeEntry
	d.mu.Unlock()
	if existing != nil {
		return existing, nil
	}
	entry, err := d.opts.CreateNodeEntry(ctx)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	if d.nodeEntry == nil {
		d.nodeEntry = entry
	}
	res := d.nodeEntry
	d.mu.Unlock()
	return res, nil
}

// StartTurn 按模型路由策略选择 GoChatDriver 或回落原生驱动。
func (d *CapabilityRoutedChatDriver) StartTurn(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	var payload map[string]any
	if tc.Command != nil {
		payload = tc.Command.Payload
	}
	sess := d.session
	if d.opts.Store != nil {
		if latest, err := d.opts.Store.GetSession(ctx, d.session.SessionID); err == nil && latest != nil {
			sess = latest
		}
	}
	route := d.resolveRoute(ctx, sess, payload, tc.ImagePaths)
	if d.opts.Diagnostics != nil {
		d.opts.Diagnostics(map[string]any{
			"kind":      "chat_turn_route",
			"sessionId": d.session.SessionID,
			"model":     firstNonEmptyStr(asString(payload["model"]), asString(sess.Policy["model"])),
			"target":    route.Target,
			"reason":    route.Reason,
			"providers": route.Providers,
		})
	}
	var entry *DriverEntry
	var err error
	if route.Target == RouteTargetGo {
		entry, err = d.ensureGoEntry(ctx)
	} else {
		entry, err = d.ensureNodeEntry(ctx)
	}
	if err != nil {
		return nil, err
	}
	if entry == nil || entry.Driver == nil {
		return nil, NewError("chat_runtime_driver_unavailable", http.StatusServiceUnavailable, map[string]any{"target": route.Target})
	}
	d.mu.Lock()
	d.activeDrv = entry.Driver
	d.mu.Unlock()
	return entry.Driver.StartTurn(ctx, tc)
}

// InterruptTurn 中断当前正在执行的下级驱动轮次。
func (d *CapabilityRoutedChatDriver) InterruptTurn(ctx context.Context, tc DriverTurnContext) error {
	d.mu.Lock()
	drv := d.activeDrv
	d.mu.Unlock()
	if ti, ok := drv.(TurnInterrupter); ok {
		return ti.InterruptTurn(ctx, tc)
	}
	return nil
}

// CompactThread 委派压缩到回落驱动。
func (d *CapabilityRoutedChatDriver) CompactThread(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	entry, err := d.ensureNodeEntry(ctx)
	if err != nil {
		return nil, err
	}
	if tcDrv, ok := entry.Driver.(ThreadCompactor); ok {
		d.mu.Lock()
		d.activeDrv = entry.Driver
		d.mu.Unlock()
		return tcDrv.CompactThread(ctx, tc)
	}
	return nil, NewError("chat_slash_execution_unsupported", http.StatusUnprocessableEntity, nil)
}

// RecoverTurn 把崩溃恢复委派给回落驱动。
func (d *CapabilityRoutedChatDriver) RecoverTurn(ctx context.Context, in RecoverTurnInput) (*ProviderRun, error) {
	entry, err := d.ensureNodeEntry(ctx)
	if err != nil {
		return nil, err
	}
	if rec, ok := entry.Driver.(TurnRecoverer); ok {
		d.mu.Lock()
		d.activeDrv = entry.Driver
		d.mu.Unlock()
		return rec.RecoverTurn(ctx, in)
	}
	return nil, NewError("chat_turn_recovery_unavailable", http.StatusConflict, nil)
}

// HistoryBranchPort 返回回落驱动的历史分支端口。
func (d *CapabilityRoutedChatDriver) HistoryBranchPort() HistoryBranchPort {
	entry, err := d.ensureNodeEntry(context.Background())
	if err != nil || entry == nil || entry.Driver == nil {
		return nil
	}
	if hb, ok := entry.Driver.(HistoryBranchDriver); ok {
		return hb.HistoryBranchPort()
	}
	return nil
}

// HandlerFor 按命令类型懒解析底层（回落）驱动提供的专属处理器。
func (d *CapabilityRoutedChatDriver) HandlerFor(commandType string) CommandHandler {
	entry, err := d.ensureNodeEntry(context.Background())
	if err != nil || entry == nil {
		return nil
	}
	if h, ok := entry.Handlers[strings.TrimSpace(commandType)]; ok {
		return h
	}
	if dp, ok := entry.Driver.(DynamicCommandProvider); ok {
		return dp.HandlerFor(commandType)
	}
	return nil
}

// Dispose 释放已初始化的 Go 与回落驱动。
func (d *CapabilityRoutedChatDriver) Dispose() bool {
	d.mu.Lock()
	g := d.goEntry
	n := d.nodeEntry
	d.goEntry = nil
	d.nodeEntry = nil
	d.activeDrv = nil
	d.mu.Unlock()
	changed := false
	if g != nil && g.Driver != nil && DisposeDriver(g.Driver) {
		changed = true
	}
	if n != nil && n.Driver != nil && DisposeDriver(n.Driver) {
		changed = true
	}
	return changed
}
