package clientversion

import (
	"context"
	"errors"
	"os/exec"
	"sync"
	"time"
)

// ErrInvalidResolver 表示解析器缺少 Provider 名称或最低版本。
var ErrInvalidResolver = errors.New("客户端版本解析器配置无效")

// Source 是 Adapter 构造请求时读取当前客户端版本的端口。
type Source interface {
	Current() string
}

// Static 是固定版本来源，用于测试与未装配解析器的兜底。
type Static string

// Current 返回固定版本。
func (static Static) Current() string {
	return string(static)
}

// ResolverOptions 显式声明一个 Provider 的版本来源。
type ResolverOptions struct {
	// Provider 是学习存储中的键，例如 codex、claude。
	Provider string
	// Floor 是编译期最低版本：编码器已按该版本真实请求验证。
	Floor string
	// Configured 是可选显式版本（人工锁定/紧急回退），非空时只用它。
	Configured string
	// ProbeCommands 是本机 CLI 候选命令，每个都以 `--version` 执行，取最大值。
	ProbeCommands []string
	// ProbeInterval 是本机 CLI 重新探测间隔；CLI 会自动更新，不能只在启动时探测。
	ProbeInterval time.Duration
	// Learned 持久化从真实客户端学到的版本；为空时只在内存中学习。
	Learned *LearnedStore
}

// Resolver 合并配置、学习、探测与最低版本，返回单调不降的当前版本。
type Resolver struct {
	provider      string
	floor         Version
	configured    Version
	probeCommands []string
	probeInterval time.Duration
	learnedStore  *LearnedStore

	mu       sync.RWMutex
	detected Version
	learned  Version

	cancel context.CancelFunc
	done   chan struct{}
}

// NewResolver 创建解析器，并读取已持久化的学习版本。
func NewResolver(options ResolverOptions) (*Resolver, error) {
	floor, ok := Parse(options.Floor)
	if options.Provider == "" || !ok || floor.String() != options.Floor {
		return nil, ErrInvalidResolver
	}
	resolver := &Resolver{
		provider:      options.Provider,
		floor:         floor,
		probeCommands: append([]string(nil), options.ProbeCommands...),
		probeInterval: options.ProbeInterval,
		learnedStore:  options.Learned,
	}
	if configured, ok := Parse(options.Configured); ok {
		resolver.configured = configured
	}
	if options.Learned != nil {
		if learned, ok := Parse(options.Learned.Get(options.Provider)); ok {
			resolver.learned = learned
		}
	}
	return resolver, nil
}

// Current 返回当前应自报的客户端版本。
func (resolver *Resolver) Current() string {
	if resolver == nil {
		return ""
	}
	if !resolver.configured.IsZero() {
		return resolver.configured.String()
	}
	resolver.mu.RLock()
	defer resolver.mu.RUnlock()
	return Max(resolver.floor, resolver.detected, resolver.learned).String()
}

// Observe 从已鉴权的真实客户端版本中学习；只接受更高版本，并尽力持久化。
//
// relay 部署的服务器上往往没有安装 CLI，经过它的真实客户端就是最新版本的唯一来源。
func (resolver *Resolver) Observe(version Version) {
	if resolver == nil || version.IsZero() {
		return
	}
	resolver.mu.Lock()
	if version.Compare(resolver.learned) <= 0 {
		resolver.mu.Unlock()
		return
	}
	resolver.learned = version
	resolver.mu.Unlock()
	if resolver.learnedStore != nil {
		resolver.learnedStore.Raise(resolver.provider, version)
	}
}

// Probe 立即执行一次本机 CLI 探测。
func (resolver *Resolver) Probe(ctx context.Context) {
	if resolver == nil || len(resolver.probeCommands) == 0 {
		return
	}
	var best Version
	for _, command := range resolver.probeCommands {
		probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		output, err := exec.CommandContext(probeCtx, command, "--version").Output()
		cancel()
		if err != nil {
			continue
		}
		if version, ok := Parse(string(output)); ok {
			best = Max(best, version)
		}
	}
	if best.IsZero() {
		return
	}
	resolver.mu.Lock()
	resolver.detected = best
	resolver.mu.Unlock()
}

// Start 异步执行首次探测，并按间隔重新探测，直到 Close。
func (resolver *Resolver) Start(parent context.Context) {
	if resolver == nil || len(resolver.probeCommands) == 0 || resolver.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	resolver.cancel = cancel
	resolver.done = make(chan struct{})
	go func() {
		defer close(resolver.done)
		resolver.Probe(ctx)
		if resolver.probeInterval <= 0 {
			return
		}
		ticker := time.NewTicker(resolver.probeInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				resolver.Probe(ctx)
			}
		}
	}()
}

// Close 停止周期探测并等待退出。
func (resolver *Resolver) Close() error {
	if resolver == nil || resolver.cancel == nil {
		return nil
	}
	resolver.cancel()
	<-resolver.done
	return nil
}
