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
	// ProbeCache 持久化本机 CLI 探测结果及其身份；为空时每次启动都重新探测。
	ProbeCache *ProbeCache
}

// Resolver 合并配置、学习、探测与最低版本，返回单调不降的当前版本。
type Resolver struct {
	provider      string
	floor         Version
	configured    Version
	probeCommands []string
	probeInterval time.Duration
	learnedStore  *LearnedStore
	probeCache    *ProbeCache

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
		probeCache:    options.ProbeCache,
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
//
// 起子进程之前先看快照：候选命令的文件身份（存在性、大小、mtime）没变时，重复执行
// `--version` 必然得到同一个版本号，直接复用即可。这也让 Start 的首次「同步探测」
// 在绝大多数启动里退化成一次 stat，不再把服务启动卡在 Node 垫片的冷启动上。
func (resolver *Resolver) Probe(ctx context.Context) {
	if resolver == nil || len(resolver.probeCommands) == 0 {
		return
	}
	if cached, ok := resolver.probeCache.Lookup(resolver.provider, ProbeIdentity(resolver.probeCommands)); ok {
		resolver.recordDetected(cached)
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
	resolver.recordDetected(best)
	// 身份在探测之后再取一次：探测期间 CLI 若被升级，快照记录的是升级后的身份。
	resolver.probeCache.Store(resolver.provider, ProbeIdentity(resolver.probeCommands), best)
}

// recordDetected 记住探测到的版本，并同步抬高已学习版本。
func (resolver *Resolver) recordDetected(version Version) {
	if version.IsZero() {
		return
	}
	resolver.mu.Lock()
	resolver.detected = Max(resolver.detected, version)
	resolver.mu.Unlock()
	// 探测结果同样记入已学习版本：下次启动在探测完成前也从最近一次已知版本起步。
	if resolver.learnedStore != nil {
		resolver.learnedStore.Raise(resolver.provider, version)
	}
}

// Start 异步执行首次探测，并按间隔重新探测，直到 Close。
func (resolver *Resolver) Start(parent context.Context) {
	if resolver == nil || len(resolver.probeCommands) == 0 || resolver.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	resolver.cancel = cancel
	resolver.done = make(chan struct{})
	// 首次探测同步完成再开始服务：探测前 Current 只有最低版本，按版本下发的新模型
	// （如 gpt-6.1-sol 需 >= 0.159）在这几秒内会被上游拒成「ChatGPT 账号不支持该模型」，
	// 进而把所有账号对该模型长时间冷却。每条命令有 3 秒上限。
	resolver.Probe(ctx)
	go func() {
		defer close(resolver.done)
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
