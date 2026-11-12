// Package writerlifecycle 串行化 agy 暖机 writer（语言服务进程）的预留、激活、释放与静默。
//
// 对应 Node lib/server/agy-writer-lifecycle.js。背景（见 lib/server/agy-warm-ls-pool.js）：
// agy 冷启动一次要 ~100s，因此每个账号保留一个常驻暖机 LS(语言服务)，同账号任意会话共用。
// 「杀掉旧 writer → 等它真正退出 → 再冷启动收编新 writer」这个流程必须按账号串行化，
// 否则并发轮次会拉起多个 LS，或在旧进程尚未退出时就开始新进程（端口/会话串用）。
// Node 把该状态机独立成 agy-writer-lifecycle.js，这里逐条对齐它的语义：
//
//   - generation：每次 reserve 先占位（pending），activate 后才绑定具体 writer（live），
//     只有更新的 generation 才允许替换旧 writer；
//   - quiescing 与 writers 分开记录：kill 已发出但 PID 尚存时，hasWriter 仍为 true，
//     避免出现「没有 writer」的假象而并发冷启动；
//   - release 的返回值表示「我是最后一个 writer，应由我触发一次性的对账/切换」，
//     coordinatedGeneration 保证同一账号的最终释放只报告一次。
package writerlifecycle

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"time"
)

// ErrAccountRefRequired 对应 Node reserve() 抛出的错误 code
// 'agy_writer_account_ref_required'：账号引用归一化后为空。
var ErrAccountRefRequired = errors.New("agy_writer_account_ref_required")

const (
	// defaultPollInterval 与 minPollInterval 对齐 Node:
	// Math.max(1, Number(options.pollIntervalMs) || 25)。
	defaultPollInterval = 25 * time.Millisecond
	minPollInterval     = time.Millisecond
	// defaultQuiesceReason 对齐 Node 的 String(options.reason || 'unspecified')。
	defaultQuiesceReason = "unspecified"
)

// Lease 是一次 writer 预留，只能由 Reserve 创建。
//
// Node 用 Object.freeze({ accountRef, generation }) 冻结租约，并以【对象身份】查找记录
// （getRecord 里的 record.lease === lease）；Go 侧用不可变字段 + 指针身份保持同样语义，
// 因此拿别的 Coordinator 或伪造的租约做 Release 不会误伤本实例的状态。
type Lease struct {
	accountRef string
	generation uint64
}

// AccountRef 返回归一化（trim）后的账号引用。
func (l *Lease) AccountRef() string {
	if l == nil {
		return ""
	}
	return l.accountRef
}

// Generation 返回该账号内的预留序号，从 1 开始单调递增。
func (l *Lease) Generation() uint64 {
	if l == nil {
		return 0
	}
	return l.generation
}

// Options 对应 Node createWriterLifecycleCoordinator(options) 的注入点。
type Options struct {
	// IsWriterAlive 判断 writer 是否仍存活。Node 侧是 pidAlive(writer.pid)。
	// 会在锁内以及静默轮询的 goroutine 中被并发调用，因此只能读外部状态
	// （pid / 进程表等）并自行保证并发安全，不要回调本包。
	// 缺省（nil）恒为 false，对齐 Node 的 () => false。
	IsWriterAlive func(writer any) bool

	// TerminateWriter 发起终止（Node 侧是 killEntry）。reason 是静默原因
	// （idle / over-cap / replacement / shutdown / explicit-evict ...）。
	// 在锁外调用，可以回调 Coordinator（Node 里 kill 后 child.onExit 会走 releaseWriter）。
	// 同步 panic 会被吞掉，对齐 Node 的 try/catch：kill 失败时继续保持 quiescing，
	// 只有 writer 真正退出才允许后继冷启动。
	TerminateWriter func(writer any, reason string)

	// WaitForPoll 是轮询间隔的等待函数，缺省 time.Sleep。测试可注入假时钟。
	WaitForPoll func(time.Duration)

	// PollInterval 是轮询间隔；0 取 25ms，低于 1ms 按下限 1ms 处理，
	// 与 Node 的 Math.max(1, Number(x) || 25) 一致。
	PollInterval time.Duration
}

// Coordinator 是账号级的 writer 生命周期协调器，可并发使用。
type Coordinator struct {
	mu sync.Mutex

	isWriterAlive   func(any) bool
	terminateWriter func(any, string)
	waitForPoll     func(time.Duration)
	pollInterval    time.Duration

	accounts map[string]*accountState
}

type writerPhase int

const (
	// phasePending：已 reserve 但冷启动还没交回 writer。
	phasePending writerPhase = iota
	// phaseLive：已绑定 writer（可能已经退出，由 IsWriterAlive 判定）。
	phaseLive
)

type writerRecord struct {
	lease  *Lease
	phase  writerPhase
	writer any
}

// accountState 对应 Node 每个 accountRef 的独立状态，用于 generation 隔离。
type accountState struct {
	accountRef            string
	nextGeneration        uint64
	coordinatedGeneration uint64
	writers               map[uint64]*writerRecord
	quiescing             *quiescence
}

// quiescence 对应 Node 的 state.quiescing：一次终止 + 等待退出的进行中流程。
type quiescence struct {
	writer any
	reason string
	done   chan struct{}
}

// completedChannel 复用同一个已关闭 channel，表示「没有 writer 要等」。
// Node 对应 Promise.resolve(true)。
var completedChannel = func() chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}()

// New 创建协调器并套用 Node 侧的默认值。
func New(options Options) *Coordinator {
	coordinator := &Coordinator{
		isWriterAlive:   options.IsWriterAlive,
		terminateWriter: options.TerminateWriter,
		waitForPoll:     options.WaitForPoll,
		pollInterval:    options.PollInterval,
		accounts:        make(map[string]*accountState),
	}
	if coordinator.isWriterAlive == nil {
		coordinator.isWriterAlive = func(any) bool { return false }
	}
	if coordinator.terminateWriter == nil {
		coordinator.terminateWriter = func(any, string) {}
	}
	if coordinator.waitForPoll == nil {
		coordinator.waitForPoll = time.Sleep
	}
	switch {
	case coordinator.pollInterval == 0:
		coordinator.pollInterval = defaultPollInterval
	case coordinator.pollInterval < minPollInterval:
		coordinator.pollInterval = minPollInterval
	}
	return coordinator
}

// Reserve 为账号占一个 writer 名额（pending），返回该名额的租约。
// 账号引用归一化后为空时返回 ErrAccountRefRequired（Node 抛同 code 的错误）。
func (c *Coordinator) Reserve(accountRef string) (*Lease, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.stateLocked(accountRef, true)
	if state == nil {
		return nil, ErrAccountRefRequired
	}
	lease := &Lease{accountRef: state.accountRef, generation: state.nextGeneration + 1}
	state.nextGeneration = lease.generation
	state.writers[lease.generation] = &writerRecord{lease: lease, phase: phasePending}
	return lease, nil
}

// Activate 把 pending 租约绑定到具体 writer。租约未知或 writer 为空时返回 false
// （对齐 Node 的 if (!record || !writer) return false）；重复 activate 会覆盖 writer。
func (c *Coordinator) Activate(lease *Lease, writer any) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	record := c.recordLocked(lease)
	if record == nil || isNilWriter(writer) {
		return false
	}
	record.phase = phaseLive
	record.writer = writer
	return true
}

// Release 释放租约，并报告「本租约是否是最后一个 writer」。
//
// 对齐 Node 的 finalWriter 判定：没有更新的记录、没有其它活跃 writer（pending 或
// live 且存活），且本 generation 晚于已协调过的 generation，才算最终释放；同一账号
// 的最终释放只会报告一次。
func (c *Coordinator) Release(lease *Lease) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if lease == nil {
		return false
	}
	state := c.stateLocked(lease.accountRef, false)
	record := c.recordLocked(lease)
	if state == nil || record == nil {
		return false
	}
	hasNewerRecord := false
	for generation := range state.writers {
		if generation > lease.generation {
			hasNewerRecord = true
			break
		}
	}
	delete(state.writers, lease.generation)
	hasOtherActiveWriter := false
	for _, candidate := range state.writers {
		if c.recordActiveLocked(candidate) {
			hasOtherActiveWriter = true
			break
		}
	}
	finalWriter := !hasNewerRecord &&
		!hasOtherActiveWriter &&
		state.coordinatedGeneration < lease.generation
	if finalWriter {
		state.coordinatedGeneration = lease.generation
	}
	c.cleanStateLocked(state)
	return finalWriter
}

// HasWriter 报告账号仍有 writer 占位：静默中、或存在 pending / live 且存活的记录。
// 对齐 Node hasWriter —— quiescing 单独记为 true，即使 kill 已发出、记录已被释放。
func (c *Coordinator) HasWriter(accountRef string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.stateLocked(accountRef, false)
	if state == nil {
		return false
	}
	if state.quiescing != nil {
		return true
	}
	for _, record := range state.writers {
		if c.recordActiveLocked(record) {
			return true
		}
	}
	return false
}

// IsQuiescing 报告账号是否正在进行「终止并等待退出」的静默流程。
func (c *Coordinator) IsQuiescing(accountRef string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.stateLocked(accountRef, false)
	return state != nil && state.quiescing != nil
}

// CanReconcileBeforeSpawn 判断 pending 租约在拉起 writer 之前能否安全对账投影资源。
//
// 对齐 Node canReconcileBeforeSpawn：只要还有【更旧的 pending】租约在排队，或有任何
// 存活 writer，就不能提前对账 —— 那些流程的最终释放会负责这次对账；账号静默中同样
// 不能对账。
func (c *Coordinator) CanReconcileBeforeSpawn(lease *Lease) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if lease == nil {
		return false
	}
	state := c.stateLocked(lease.accountRef, false)
	record := c.recordLocked(lease)
	if state == nil || record == nil || record.phase != phasePending || state.quiescing != nil {
		return false
	}
	for _, candidate := range state.writers {
		if candidate == record {
			continue
		}
		if candidate.phase == phasePending && candidate.lease.generation < lease.generation {
			return false
		}
		if candidate.phase == phaseLive &&
			!isNilWriter(candidate.writer) &&
			c.isWriterAlive(candidate.writer) {
			return false
		}
	}
	return true
}

// QuiesceOptions 对应 Node quiesce(accountRef, options)。
type QuiesceOptions struct {
	// Lease 是发起静默的租约；writer 未显式给出时用它对应的记录里的 writer。
	Lease *Lease
	// Writer 显式指定要终止的 writer（Node 侧传的是 pool entry，而不是 child）。
	Writer any
	// Reason 是静默原因；空串按 "unspecified" 处理。
	Reason string
}

// Quiesce 开始（或复用）账号级静默：终止 writer 并轮询到它真正退出。
//
// 返回的 channel 在静默完成（writer 已死、quiescing 已清除）后关闭；同一账号上的
// 重复调用共享同一个流程，不会重复终止（对齐 Node 返回 state.quiescing.promise）。
// 调用方需要超时语义时用 WaitQuiesce，或在 channel 与自己的 ctx 之间 select ——
// 超时只结束等待，后台静默继续，直到 writer 真正退出才允许后继冷启动。
func (c *Coordinator) Quiesce(accountRef string, options QuiesceOptions) <-chan struct{} {
	c.mu.Lock()
	state := c.stateLocked(accountRef, true)
	if state == nil {
		c.mu.Unlock()
		return completedChannel
	}
	if state.quiescing != nil {
		done := state.quiescing.done
		c.mu.Unlock()
		return done
	}
	writer := options.Writer
	if isNilWriter(writer) {
		if record := c.recordLocked(options.Lease); record != nil {
			writer = record.writer
		}
	}
	// 没有 writer 或已经退出：无事可做，直接完成（Node 同分支只做 cleanState）。
	if isNilWriter(writer) || !c.isWriterAlive(writer) {
		c.cleanStateLocked(state)
		c.mu.Unlock()
		return completedChannel
	}
	reason := options.Reason
	if reason == "" {
		reason = defaultQuiesceReason
	}
	quiescing := &quiescence{writer: writer, reason: reason, done: make(chan struct{})}
	state.quiescing = quiescing
	c.mu.Unlock()

	// 先在锁外同步发出终止（对齐 Node：terminateWriter 在 promise 体里同步执行），
	// 再异步轮询退出。终止失败不影响 quiescing，只有真正退出才放行后继冷启动。
	c.terminateSafely(writer, reason)
	go c.awaitWriterExit(state, quiescing)
	return quiescing.done
}

// WaitQuiesce 对齐 agy-warm-ls-pool.js 里 evict 的 Promise.race：在 ctx 结束前 writer
// 真正退出返回 true；超时返回 false，但静默流程仍在后台继续。
func (c *Coordinator) WaitQuiesce(
	ctx context.Context,
	accountRef string,
	options QuiesceOptions,
) bool {
	done := c.Quiesce(accountRef, options)
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}

// awaitWriterExit 轮询到 writer 退出，然后清除 quiescing 并回收空状态。
// 对应 Node quiescing.promise 的 while (isWriterAlive(writer)) await waitForPoll(ms)。
func (c *Coordinator) awaitWriterExit(state *accountState, quiescing *quiescence) {
	defer close(quiescing.done)
	for c.isWriterAlive(quiescing.writer) {
		c.waitForPoll(c.pollInterval)
	}
	c.mu.Lock()
	if state.quiescing == quiescing {
		state.quiescing = nil
	}
	c.cleanStateLocked(state)
	c.mu.Unlock()
}

// terminateSafely 吞掉终止回调里的 panic，对齐 Node 的 try/catch。
func (c *Coordinator) terminateSafely(writer any, reason string) {
	defer func() { _ = recover() }()
	c.terminateWriter(writer, reason)
}

// stateLocked 取（必要时创建）账号状态；账号引用为空时返回 nil。
func (c *Coordinator) stateLocked(accountRef string, create bool) *accountState {
	normalized := normalizeAccountRef(accountRef)
	if normalized == "" {
		return nil
	}
	state := c.accounts[normalized]
	if state == nil && create {
		state = &accountState{
			accountRef: normalized,
			writers:    make(map[uint64]*writerRecord),
		}
		c.accounts[normalized] = state
	}
	return state
}

// recordLocked 按【指针身份】查记录，对齐 Node 的 record.lease === lease。
func (c *Coordinator) recordLocked(lease *Lease) *writerRecord {
	if lease == nil {
		return nil
	}
	state := c.stateLocked(lease.accountRef, false)
	if state == nil {
		return nil
	}
	record := state.writers[lease.generation]
	if record == nil || record.lease != lease {
		return nil
	}
	return record
}

// recordActiveLocked 对齐 isRecordActive：pending，或 live 且 writer 仍存活。
func (c *Coordinator) recordActiveLocked(record *writerRecord) bool {
	if record == nil {
		return false
	}
	if record.phase == phasePending {
		return true
	}
	return record.phase == phaseLive &&
		!isNilWriter(record.writer) &&
		c.isWriterAlive(record.writer)
}

// cleanStateLocked 在没有 writer 且不在静默时丢弃账号状态（generation 随之归零）。
func (c *Coordinator) cleanStateLocked(state *accountState) {
	if state == nil || state.quiescing != nil || len(state.writers) > 0 {
		return
	}
	delete(c.accounts, state.accountRef)
}

// normalizeAccountRef 对齐 Node normalizeAccountRef：空值视作空串，再 trim。
func normalizeAccountRef(accountRef string) string {
	return strings.TrimSpace(accountRef)
}

// isNilWriter 对齐 Node 的 !writer 判定：nil 接口与 typed nil 都算未绑定。
// writer 在 Node 里可能是 child，也可能是 pool entry，所以这里用 any 承载，
// 具体形状交给 IsWriterAlive / TerminateWriter 解释。
func isNilWriter(writer any) bool {
	if writer == nil {
		return true
	}
	value := reflect.ValueOf(writer)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	}
	return false
}
