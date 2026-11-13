package chatruntime

import (
	"context"
	"sync"
)

// ExtensionContext 传递扩展执行期上下文。
type ExtensionContext struct {
	SessionID       string
	Source          string
	Command         *Command
	AcceptedCommand *Command
	Trace           *TraceRecord
	Result          map[string]any
	Extra           map[string]any
}

// Extension 定义可挂载到 Chat Runtime 的扩展钩子集合（全部字段按需提供）。
type Extension struct {
	Observe         func(value map[string]any, ect ExtensionContext)
	BeforeCommand   func(ctx context.Context, cmd *Command, ect ExtensionContext) error
	PrepareNextTurn func(ctx context.Context, cmd *Command, ect ExtensionContext) (*Command, error)
	BeforeToolCall  func(ctx context.Context, event map[string]any, ect ExtensionContext) error
	AfterToolCall   func(ctx context.Context, event map[string]any, ect ExtensionContext) error
	Dispose         func(reason string)
}

func (e *Extension) hasHook() bool {
	if e == nil {
		return false
	}
	return e.Observe != nil || e.BeforeCommand != nil || e.PrepareNextTurn != nil ||
		e.BeforeToolCall != nil || e.AfterToolCall != nil || e.Dispose != nil
}

// PluginPipeline 为外部插件管线保留的可选桥接接口。
type PluginPipeline interface {
	Waterfall(stage string, cmd *Command, ect ExtensionContext) (*Command, error)
	Serial(stage string, cmd *Command, ect ExtensionContext) error
	Terminal(stage string, event map[string]any, ect ExtensionContext) error
	Observe(stage string, value map[string]any, ect ExtensionContext)
}

// ExtensionPipeline 按注册顺序执行命令准备、串行拦截、工具钩子及只读观察。
type ExtensionPipeline struct {
	mu              sync.RWMutex
	extensions      []*Extension
	pluginPipeline  PluginPipeline
	onObserverError func(err error, value map[string]any, ect ExtensionContext)
}

// ExtensionPipelineOptions 配置扩展管线。
type ExtensionPipelineOptions struct {
	Extensions      []*Extension
	PluginPipeline  PluginPipeline
	OnObserverError func(err error, value map[string]any, ect ExtensionContext)
}

// NewExtensionPipeline 构造扩展管线；若任何初始扩展无钩子则返回错误。
func NewExtensionPipeline(opts ExtensionPipelineOptions) (*ExtensionPipeline, error) {
	sink := opts.OnObserverError
	if sink == nil {
		sink = func(error, map[string]any, ExtensionContext) {}
	}
	p := &ExtensionPipeline{
		pluginPipeline:  opts.PluginPipeline,
		onObserverError: sink,
	}
	for _, ext := range opts.Extensions {
		if _, err := p.Register(ext); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// Register 注册扩展并返回注销函数。
func (p *ExtensionPipeline) Register(ext *Extension) (func() bool, error) {
	if ext == nil {
		return nil, NewError("chat_runtime_extension_invalid", 500, nil)
	}
	if !ext.hasHook() {
		return nil, NewError("chat_runtime_extension_no_hooks", 500, nil)
	}
	p.mu.Lock()
	p.extensions = append(p.extensions, ext)
	p.mu.Unlock()
	return func() bool {
		return p.Unregister(ext)
	}, nil
}

// Unregister 移除扩展并触发 Dispose。
func (p *ExtensionPipeline) Unregister(ext *Extension) bool {
	p.mu.Lock()
	idx := -1
	for i, cur := range p.extensions {
		if cur == ext {
			idx = i
			break
		}
	}
	if idx >= 0 {
		p.extensions = append(p.extensions[:idx], p.extensions[idx+1:]...)
	}
	p.mu.Unlock()
	if idx < 0 {
		return false
	}
	p.disposeExtension(ext, "unregister")
	return true
}

// Close 注销全部扩展并释放资源。
func (p *ExtensionPipeline) Close() {
	p.mu.Lock()
	copyExts := append([]*Extension(nil), p.extensions...)
	p.mu.Unlock()
	for _, ext := range copyExts {
		p.Unregister(ext)
	}
}

// RunPrepareNextTurn 依次执行 prepareNextTurn 瀑布流改造下一轮命令。
func (p *ExtensionPipeline) RunPrepareNextTurn(ctx context.Context, cmd *Command, ect ExtensionContext) (*Command, error) {
	p.mu.RLock()
	exts := append([]*Extension(nil), p.extensions...)
	plugin := p.pluginPipeline
	p.mu.RUnlock()

	current := cmd
	for _, ext := range exts {
		if ext.PrepareNextTurn == nil {
			continue
		}
		next, err := ext.PrepareNextTurn(ctx, current, ect)
		if err != nil {
			return nil, err
		}
		if next != nil {
			current = next
		}
	}
	if plugin != nil {
		next, err := plugin.Waterfall("chat.prepare", current, ect)
		if err != nil {
			return nil, err
		}
		if next != nil {
			current = next
		}
	}
	return current, nil
}

// RunBeforeCommand 串行执行 beforeCommand 扩展校验。
func (p *ExtensionPipeline) RunBeforeCommand(ctx context.Context, cmd *Command, ect ExtensionContext) error {
	p.mu.RLock()
	exts := append([]*Extension(nil), p.extensions...)
	plugin := p.pluginPipeline
	p.mu.RUnlock()

	for _, ext := range exts {
		if ext.BeforeCommand == nil {
			continue
		}
		if err := ext.BeforeCommand(ctx, cmd, ect); err != nil {
			return err
		}
	}
	if plugin != nil {
		return plugin.Serial("chat.beforeCommand", cmd, ect)
	}
	return nil
}

// RunToolHook 执行 beforeToolCall / afterToolCall 钩子。
func (p *ExtensionPipeline) RunToolHook(ctx context.Context, stage string, event map[string]any, ect ExtensionContext) error {
	if stage != "beforeToolCall" && stage != "afterToolCall" {
		return NewError("chat_runtime_extension_stage_unsupported:"+stage, 500, map[string]any{"stage": stage})
	}
	p.mu.RLock()
	exts := append([]*Extension(nil), p.extensions...)
	plugin := p.pluginPipeline
	p.mu.RUnlock()

	for _, ext := range exts {
		var fn func(context.Context, map[string]any, ExtensionContext) error
		if stage == "beforeToolCall" {
			fn = ext.BeforeToolCall
		} else {
			fn = ext.AfterToolCall
		}
		if fn != nil {
			if err := fn(ctx, event, ect); err != nil {
				return err
			}
		}
	}
	if plugin != nil {
		return plugin.Terminal("tool", map[string]any{"stage": stage, "event": event}, ect)
	}
	return nil
}

// Observe 安全广播只读观察事件（任何异常会被隔离到 onObserverError）。
func (p *ExtensionPipeline) Observe(value map[string]any, ect ExtensionContext) {
	p.mu.RLock()
	exts := append([]*Extension(nil), p.extensions...)
	plugin := p.pluginPipeline
	p.mu.RUnlock()

	for _, ext := range exts {
		if ext.Observe == nil {
			continue
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					p.reportObserverError(NewError("extension_observer_panicked", 500, map[string]any{"panic": r}), value, ect)
				}
			}()
			ext.Observe(value, ect)
		}()
	}
	if plugin != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					p.reportObserverError(NewError("extension_observer_panicked", 500, map[string]any{"panic": r}), value, ect)
				}
			}()
			plugin.Observe("observe", value, ect)
		}()
	}
}

func (p *ExtensionPipeline) reportObserverError(err error, value map[string]any, ect ExtensionContext) {
	if p.onObserverError == nil {
		return
	}
	defer func() { _ = recover() }()
	p.onObserverError(err, value, ect)
}

func (p *ExtensionPipeline) disposeExtension(ext *Extension, reason string) {
	if ext == nil || ext.Dispose == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			p.reportObserverError(NewError("extension_dispose_panicked", 500, nil), map[string]any{"type": "extension.dispose.failed"}, ExtensionContext{})
		}
	}()
	ext.Dispose(reason)
}
