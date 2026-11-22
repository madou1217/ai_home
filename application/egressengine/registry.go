package egressengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Registry 保存已注册的内核插件（内置适配器或进程插件）。
type Registry struct {
	mu      sync.RWMutex
	engines map[string]Engine
}

// NewRegistry 创建空注册表。
func NewRegistry() *Registry {
	return &Registry{engines: map[string]Engine{}}
}

// Register 校验并注册一个引擎；ID 冲突返回错误（不允许静默覆盖）。
func (r *Registry) Register(engine Engine) error {
	if r == nil || engine == nil {
		return errors.New("egress_engine_invalid")
	}
	descriptor := engine.Descriptor()
	id := strings.ToLower(strings.TrimSpace(descriptor.ID))
	if id == "" {
		return errors.New("egress_engine_id_required")
	}
	if controller := strings.ToLower(strings.TrimSpace(descriptor.Controller)); controller != "clash-api" {
		return fmt.Errorf("egress_engine_controller_unsupported: %s", descriptor.Controller)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.engines[id]; exists {
		return fmt.Errorf("egress_engine_duplicate: %s", id)
	}
	r.engines[id] = engine
	return nil
}

// Engines 返回按 priority（高优先）、ID 稳定排序的插件快照。
func (r *Registry) Engines() []Engine {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	items := make([]Engine, 0, len(r.engines))
	for _, engine := range r.engines {
		items = append(items, engine)
	}
	r.mu.RUnlock()
	sort.SliceStable(items, func(left, right int) bool {
		a, b := items[left].Descriptor(), items[right].Descriptor()
		if a.Priority != b.Priority {
			return a.Priority > b.Priority
		}
		return a.ID < b.ID
	})
	return items
}

// InvokeFunc 是进程插件的能力调用端口（由 pluginhost 适配）。
type InvokeFunc func(ctx context.Context, value any, timeout time.Duration) (json.RawMessage, error)

// PluginEngine 把进程插件适配成 Engine；主体不 import 任何具体内核。
type PluginEngine struct {
	descriptor Descriptor
	invoke     InvokeFunc
}

// NewPluginEngine 创建进程插件适配器。
func NewPluginEngine(descriptor Descriptor, invoke InvokeFunc) (*PluginEngine, error) {
	if strings.TrimSpace(descriptor.ID) == "" || invoke == nil {
		return nil, errors.New("egress_engine_invalid")
	}
	if strings.ToLower(strings.TrimSpace(descriptor.Controller)) != "clash-api" {
		return nil, errors.New("egress_engine_controller_unsupported")
	}
	return &PluginEngine{descriptor: descriptor, invoke: invoke}, nil
}

// Descriptor 返回插件自报能力。
func (engine *PluginEngine) Descriptor() Descriptor { return engine.descriptor }

// Compile 调用插件编译配置；插件只返回配置/启动事实，不负责启动进程。
func (engine *PluginEngine) Compile(ctx context.Context, request CompileRequest) (LaunchSpec, error) {
	raw, err := engine.invoke(ctx, map[string]any{
		"op":      "egress.engine.compile",
		"request": request,
	}, 30*time.Second)
	if err != nil {
		return LaunchSpec{}, err
	}
	var spec LaunchSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return LaunchSpec{}, fmt.Errorf("egress_engine_compile_invalid: %w", err)
	}
	if len(spec.Config) == 0 || strings.TrimSpace(spec.ConfigFileName) == "" || strings.TrimSpace(spec.GlobalGroup) == "" {
		return LaunchSpec{}, errors.New("egress_engine_launch_spec_invalid")
	}
	if controller := strings.ToLower(strings.TrimSpace(spec.Controller)); controller != "" && controller != "clash-api" {
		return LaunchSpec{}, errors.New("egress_engine_controller_unsupported")
	}
	return spec, nil
}
