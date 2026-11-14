// Package desktoptranslation composes native-helper lifecycle with existing translation services.
package desktoptranslation

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/desktoplauncher"
	"github.com/madou1217/ai_home/internal/runtime/desktopprotocol"
	"github.com/madou1217/ai_home/internal/runtime/translation"
)

type ChatPort interface {
	Handle(context.Context, map[string]any) error
	Close() error
}
type Options struct {
	AIHomeDir, DatabasePath, Origin, Mode, Platform string
	ManagementKey                                   func() string
	LargePasteChars                                 func() int
	Build                                           func(context.Context) (desktoplauncher.LaunchSpec, error)
	Executor                                        *Executor
	Chat                                            ChatPort
	Catalog                                         func(context.Context) (translation.ModelCatalog, error)
}
type focusLease struct{ Revision, Observed, Until int64 }
type operation struct {
	event    map[string]any
	epoch    uint64
	ctx      context.Context
	cancel   context.CancelFunc
	delivery context.Context
}
type Service struct {
	options         Options
	launcher        *desktoplauncher.Launcher
	executor        *Executor
	mu              sync.Mutex
	settings        translation.Settings
	target          translation.SystemServerTarget
	targets         []translation.SystemServerTarget
	enabled, closed bool
	snapshot        map[string]any
	focus           map[string]focusLease
	epoch           uint64
	active          *operation
	pending         *operation
	notify          chan struct{}
	ctx             context.Context
	cancel          context.CancelFunc
	workerDone      chan struct{}
	catalog         modelCache
	configure       chan struct{}
	configDone      chan struct{}
	deliveryCancel  context.CancelFunc
	configCtx       context.Context
	configCancel    context.CancelFunc
	controlMu       sync.Mutex
}

func New(ctx context.Context, options Options) (*Service, error) {
	if ctx == nil || options.DatabasePath == "" || options.Build == nil || options.Executor == nil {
		return nil, errors.New("desktop_translation_dependencies_invalid")
	}
	settings := translation.DefaultSettings()
	if options.Mode == "full-app" {
		settings.ExecutionTarget = "direct-provider"
	}
	if stored, err := translation.ReadSettings(ctx, options.DatabasePath); err != nil {
		return nil, err
	} else if stored != nil {
		settings = *stored
	}
	platform := options.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	if platform == "windows" {
		platform = "win32"
	}
	options.Platform = platform
	target := translation.SystemServerTarget{Kind: "aih-server", Label: "本机 AIH Server", Origin: strings.TrimRight(options.Origin, "/")}
	if settings.SystemServerTarget != nil {
		target = *settings.SystemServerTarget
	}
	targets := settings.SystemServerTargets
	if len(targets) == 0 {
		targets = []translation.SystemServerTarget{target}
	}
	workCtx, cancel := context.WithCancel(ctx)
	s := &Service{options: options, executor: options.Executor, settings: settings, target: target, targets: targets, enabled: settings.SystemEnabled, focus: make(map[string]focusLease), notify: make(chan struct{}, 1), ctx: workCtx, cancel: cancel, workerDone: make(chan struct{})}
	s.configure = make(chan struct{}, 1)
	s.configDone = make(chan struct{})
	s.configCtx, s.configCancel = context.WithCancel(workCtx)
	s.snapshot = platformStatus(platform)
	if options.Mode == "full-app" {
		s.enabled = true
	}
	s.snapshot["enabled"] = s.enabled
	launcher, err := desktoplauncher.New(desktoplauncher.Options{Build: options.Build, Mode: options.Mode, OnEvent: s.handle, OnStatus: s.launcherStatus})
	if err != nil {
		cancel()
		return nil, err
	}
	s.launcher = launcher
	if s.executor.ResolveTarget == nil {
		s.executor.ResolveTarget = s.ResolveTarget
	}
	go s.run()
	go func() {
		defer close(s.configDone)
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-s.configure:
				s.Configure()
			}
		}
	}()
	return s, nil
}
func (s *Service) Start(ctx context.Context) error {
	s.mu.Lock()
	enabled := s.enabled && !s.closed
	s.mu.Unlock()
	if !enabled {
		return nil
	}
	return s.launcher.Start(ctx)
}
func (s *Service) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.cancelLocked()
	s.catalog.resetLocked()
	s.resetConfigLocked()
	s.mu.Unlock()
	s.cancel()
	s.mu.Lock()
	chat := s.options.Chat
	s.mu.Unlock()
	if chat != nil {
		_ = chat.Close()
	}
	err := s.launcher.Close()
	select {
	case <-s.workerDone:
	case <-time.After(5 * time.Second):
		if err == nil {
			err = errors.New("desktop_translation_close_timeout")
		}
	}
	select {
	case <-s.configDone:
	case <-time.After(time.Second):
		if err == nil {
			err = errors.New("desktop_configuration_close_timeout")
		}
	}
	return err
}
func (s *Service) StartAt(ctx context.Context, origin string) error {
	normalized, err := normalizeOrigin(origin)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.options.Origin == "" {
		s.options.Origin = normalized
		if s.target.Origin == "" {
			s.target.Origin = normalized
			s.targets = []translation.SystemServerTarget{s.target}
		}
	}
	s.mu.Unlock()
	return s.Start(ctx)
}
func (s *Service) ResolveTarget(ctx context.Context, target translation.SystemServerTarget) (ResolvedTarget, error) {
	s.mu.Lock()
	origin := s.options.Origin
	getKey := s.options.ManagementKey
	database := s.options.DatabasePath
	s.mu.Unlock()
	key := ""
	if getKey != nil {
		key = getKey()
	}
	return ResolveTarget(ctx, database, origin, key, target)
}
func (s *Service) SettingsSnapshot() translation.Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := s.settings
	result.Routes = append([]translation.Route(nil), result.Routes...)
	return result
}

// Reload consumes the canonical settings store after another API write without duplicating persistence.
func (s *Service) Reload(ctx context.Context) error {
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	settings, err := translation.ReadSettings(ctx, s.options.DatabasePath)
	if err != nil {
		return err
	}
	if settings == nil {
		defaults := translation.DefaultSettings()
		settings = &defaults
	}
	s.mu.Lock()
	wasEnabled := s.enabled
	s.settings = *settings
	s.enabled = settings.SystemEnabled || s.options.Mode == "full-app"
	s.snapshot["enabled"] = s.enabled
	enabled := s.enabled
	if settings.SystemServerTarget != nil {
		s.target = *settings.SystemServerTarget
	}
	s.targets = settings.SystemServerTargets
	if len(s.targets) == 0 {
		s.targets = []translation.SystemServerTarget{s.target}
	}
	s.cancelLocked()
	s.catalog.resetLocked()
	s.resetConfigLocked()
	delivery := s.configCtx
	s.mu.Unlock()
	_ = s.launcher.SendContext(delivery, map[string]any{"type": "cancel"})
	select {
	case s.configure <- struct{}{}:
	default:
	}
	if wasEnabled != enabled {
		if enabled {
			return s.Start(ctx)
		}
		return s.launcher.Stop(ctx)
	}
	return nil
}
func (s *Service) LocalOrigin() string { s.mu.Lock(); defer s.mu.Unlock(); return s.options.Origin }

func (s *Service) SetChat(chat ChatPort)           { s.mu.Lock(); s.options.Chat = chat; s.mu.Unlock() }
func (s *Service) Send(event map[string]any) error { return s.launcher.Send(event) }
func (s *Service) SetEnabled(ctx context.Context, enabled bool) error {
	s.mu.Lock()
	supported, _ := s.snapshot["supported"].(bool)
	s.mu.Unlock()
	if enabled && !supported {
		return errors.New("desktop_platform_unsupported")
	}
	if err := s.UpdateSettings(ctx, map[string]any{"systemEnabled": enabled}); err != nil {
		return err
	}
	s.mu.Lock()
	s.enabled = enabled
	s.snapshot["enabled"] = enabled
	s.cancelLocked()
	s.mu.Unlock()
	if enabled {
		return s.Start(ctx)
	}
	return s.launcher.Stop(ctx)
}
func (s *Service) UpdateSettings(ctx context.Context, patch map[string]any) error {
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	// Serialize settings read-modify-write with helper updates to avoid divergent state snapshots.
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return desktoplauncher.ErrClosed
	}
	updated, err := translation.WriteSettingsPatch(ctx, s.options.DatabasePath, patch, time.Now())
	if err != nil {
		s.mu.Unlock()
		return err
	}
	s.settings = updated
	if updated.SystemServerTarget != nil {
		s.target = *updated.SystemServerTarget
	}
	s.targets = updated.SystemServerTargets
	if len(s.targets) == 0 {
		s.targets = []translation.SystemServerTarget{s.target}
	}
	s.cancelLocked()
	s.catalog.resetLocked()
	s.resetConfigLocked()
	delivery := s.configCtx
	s.mu.Unlock()
	_ = s.launcher.SendContext(delivery, map[string]any{"type": "cancel"})
	select {
	case s.configure <- struct{}{}:
	default:
	}
	return nil
}
func (s *Service) SetServerTarget(ctx context.Context, target translation.SystemServerTarget) error {
	origin, err := normalizeOrigin(target.Origin)
	if err != nil || target.Kind != "aih-server" {
		return ErrTarget
	}
	target.Origin = origin
	// Authorization is resolved at execution, not embedded in settings or helper messages.
	s.mu.Lock()
	targets := append([]translation.SystemServerTarget(nil), s.targets...)
	s.mu.Unlock()
	found := false
	for _, entry := range targets {
		if entry.ServerID == target.ServerID && entry.Origin == target.Origin {
			found = true
		}
	}
	if !found {
		targets = append(targets, target)
		if len(targets) > 32 {
			targets = targets[len(targets)-32:]
		}
	}
	return s.UpdateSettings(ctx, map[string]any{"systemServerTarget": toMap(target), "systemServerTargets": toAny(targets)})
}
func (s *Service) SetServerTargets(ctx context.Context, targets []translation.SystemServerTarget) error {
	if len(targets) > 32 {
		return ErrTarget
	}
	return s.UpdateSettings(ctx, map[string]any{"systemServerTargets": toAny(targets)})
}
func (s *Service) SetExecutionTarget(ctx context.Context, target string) error {
	if target != "direct-provider" && target != "aih-server" {
		return errors.New("translation_execution_target_invalid")
	}
	return s.UpdateSettings(ctx, map[string]any{"executionTarget": target})
}
func (s *Service) RequestPermission() error {
	return s.Send(map[string]any{"type": "request-permission"})
}
func (s *Service) UpdateFocus(id string, focused bool, observed, revision int64) {
	now := time.Now().UnixMilli()
	if id == "" || desktopprotocol.Units(id) > 100 || revision < 0 || observed < now-6000 || observed > now+6000 {
		return
	}
	s.mu.Lock()
	for key, lease := range s.focus {
		if lease.Observed+12000 < now {
			delete(s.focus, key)
		}
	}
	old, exists := s.focus[id]
	if exists && revision <= old.Revision || !exists && len(s.focus) >= 64 {
		s.mu.Unlock()
		return
	}
	until := int64(0)
	if focused {
		until = observed + 6000
	}
	s.focus[id] = focusLease{revision, observed, until}
	max := s.focusUntilLocked()
	s.mu.Unlock()
	_ = s.Send(map[string]any{"type": "webui-focus", "until": max})
}
func (s *Service) focusUntilLocked() int64 {
	var until int64
	for _, lease := range s.focus {
		if lease.Until > until {
			until = lease.Until
		}
	}
	return until
}
func (s *Service) cancelLocked() {
	s.epoch++
	if s.deliveryCancel != nil {
		s.deliveryCancel()
		s.deliveryCancel = nil
	}
	if s.active != nil {
		s.active.cancel()
	}
	if s.pending != nil {
		s.pending.cancel()
		s.pending = nil
	}
}
func (s *Service) Cancel() { s.mu.Lock(); s.cancelLocked(); s.mu.Unlock() }
func (s *Service) launcherStatus(status desktoplauncher.Status) {
	s.mu.Lock()
	if status.State == "error" || status.State == "stopping" || status.State == "stopped" {
		s.cancelLocked()
		s.resetConfigLocked()
	}
	if !s.enabled {
		s.snapshot["status"] = "disabled"
	} else if status.State == "starting" || status.State == "handshaking" {
		s.snapshot["status"] = "starting"
	} else if status.State == "error" {
		s.snapshot["status"] = "error"
		s.snapshot["detail"] = "桌面进程已退出，可关闭后重新开启"
	}
	s.mu.Unlock()
}

// HandleNativeEvent uses the same validated protocol path for the private helper stream.
func (s *Service) HandleNativeEvent(ctx context.Context, event map[string]any) error {
	safe, err := desktopprotocol.Normalize(event)
	if err != nil {
		return err
	}
	s.handle(ctx, safe)
	return nil
}
func (s *Service) handle(ctx context.Context, event map[string]any) {
	kind := desktopprotocol.Text(event["type"])
	switch kind {
	case "ready":
		s.Configure()
		s.mu.Lock()
		until := s.focusUntilLocked()
		s.mu.Unlock()
		_ = s.Send(map[string]any{"type": "webui-focus", "until": until})
	case "translate", "translate-intent":
		s.queue(ctx, event)
	case "cancel":
		s.Cancel()
	case "settings":
		if event["action"] == "save" {
			if patch, ok := event["patch"].(map[string]any); ok {
				s.applyHelperSettings(ctx, patch)
			}
		}
	case "server-target":
		target := translation.SystemServerTarget{Kind: "aih-server", Origin: desktopprotocol.Text(event["origin"]), ServerID: desktopprotocol.Text(event["serverId"]), Label: desktopprotocol.Text(event["label"])}
		if s.SetServerTarget(ctx, target) != nil {
			_ = s.Send(map[string]any{"type": "server-target-error", "message": "该 AIH Server 尚未完成授权配置"})
		}
	case "status":
		s.mu.Lock()
		trusted, _ := event["trusted"].(bool)
		if trusted {
			s.snapshot["status"] = "running"
			s.snapshot["detail"] = "在本机应用或网页中选词后翻译"
		} else {
			s.snapshot["status"] = "permission-required"
			s.snapshot["detail"] = "请为 AIH Translation 开启系统辅助功能或快捷键权限"
		}
		for _, k := range []string{"platform", "permission", "shortcut", "captureModes"} {
			if v, ok := event[k]; ok {
				s.snapshot[k] = v
			}
		}
		s.mu.Unlock()
	case "error":
		s.mu.Lock()
		s.snapshot["status"] = "error"
		s.snapshot["detail"] = "桌面取词进程发生错误"
		s.mu.Unlock()
	case "selection-state":
		s.mu.Lock()
		count, _ := s.snapshot["selectionEvents"].(int)
		s.snapshot["selectionEvents"] = count + 1
		s.snapshot["diagnostics"] = event
		s.mu.Unlock()
	default:
		if strings.HasPrefix(kind, "chat.") {
			s.mu.Lock()
			chat := s.options.Chat
			s.mu.Unlock()
			if chat != nil {
				_ = chat.Handle(ctx, event)
			} else {
				_ = s.Send(map[string]any{"type": "chat.error", "requestId": event["requestId"], "code": "chat_runtime_unavailable", "message": "当前桌面模式没有可用的 Chat Runtime"})
			}
		}
	}
}
func (s *Service) applyHelperSettings(ctx context.Context, patch map[string]any) {
	copy := map[string]any{}
	for k, v := range patch {
		switch k {
		case "serverTarget":
			copy["systemServerTarget"] = v
		case "serverTargets":
			copy["systemServerTargets"] = v
		default:
			copy[k] = v
		}
	}
	_ = s.UpdateSettings(ctx, copy)
}
func platformStatus(platform string) map[string]any {
	supported := platform == "darwin" || platform == "win32"
	status := "disabled"
	permission := "none"
	shortcut := ""
	modes := []string{}
	if platform == "darwin" {
		permission = "accessibility"
		shortcut = "⌘⌥T"
		modes = []string{"accessibility", "services", "shortcut"}
	} else if platform == "win32" {
		permission = "clipboard-shortcut"
		shortcut = "Ctrl+Alt+T"
		modes = []string{"shortcut-clipboard"}
	} else {
		status = "unsupported"
	}
	return map[string]any{"supported": supported, "enabled": false, "status": status, "detail": "", "platform": platform, "permission": permission, "shortcut": shortcut, "captureModes": modes, "diagnostics": map[string]any{"selectionEvents": 0, "outcome": "idle"}}
}
func toMap(value any) map[string]any {
	raw, _ := json.Marshal(value)
	var result map[string]any
	_ = json.Unmarshal(raw, &result)
	return result
}
func toAny(value any) any {
	raw, _ := json.Marshal(value)
	var result any
	_ = json.Unmarshal(raw, &result)
	return result
}

func (s *Service) resetConfigLocked() {
	if s.configCancel != nil {
		s.configCancel()
	}
	if !s.closed {
		s.configCtx, s.configCancel = context.WithCancel(s.ctx)
	}
}
