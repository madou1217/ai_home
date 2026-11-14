package webuiaccountliveapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

// hubOptions 是 Hub 的装配输入。
type hubOptions struct {
	rows       RowSource
	runtime    RuntimeSource
	states     StateSource
	tokenUsage TokenUsageSource
	catalog    *providers.Catalog
	// aiHomeDir 是 aih.db 所在的数据根：事件源只监听这里的数据库文件。
	aiHomeDir string
	// sourceFactory 是测试注入点；nil 时使用 fsnotify。
	sourceFactory func() (accountWatchSource, error)
	now           func() time.Time
}

// subscriber 是一路事件流的投递队列。
//
// events 永不关闭：广播与取消可能并发，关闭 channel 会让仍在发送的一方 panic。
// 取消只关闭 done，由读循环退出。
type subscriber struct {
	events chan []byte
	done   chan struct{}
	once   sync.Once
}

func newSubscriber() *subscriber {
	return &subscriber{events: make(chan []byte, subscriberQueue), done: make(chan struct{})}
}

func (sub *subscriber) stop() {
	sub.once.Do(func() { close(sub.done) })
}

type tokenUsageEntry struct {
	value     *tokenUsageView
	fetchedAt time.Time
	retryAt   time.Time
}

// Hub 持有账号页的实时快照、revision 与订阅者。
//
// 刷新由两类事件驱动：账号数据库的 fsnotify 事件（aih.db / -wal 的写入）和
// 前端的显式快照请求。没有周期轮询：第一路订阅建立前不创建 watcher，最后一路
// 订阅离开后立即释放。
type Hub struct {
	rows          RowSource
	runtime       RuntimeSource
	states        StateSource
	tokenUsage    TokenUsageSource
	catalog       *providers.Catalog
	aiHomeDir     string
	sourceFactory func() (accountWatchSource, error)
	now           func() time.Time

	mu          sync.Mutex
	subs        map[*subscriber]struct{}
	snapshot    []webuiaccountsapi.Row
	byRef       map[string]webuiaccountsapi.Row
	hasSnapshot bool
	revision    int64
	hydratedAt  int64
	refreshing  bool
	forceQueued bool
	lastRequest int64
	// lastRefreshAt 是上一次事件驱动重建完成的时刻，用于 2s 合并窗口。
	lastRefreshAt time.Time
	// eventBeforeSnapshot 记录首帧快照建立前是否已有数据库事件；落定后补一次对齐。
	eventBeforeSnapshot bool
	capabilityMap       map[string]json.RawMessage

	// 事件源生命周期：只有存在订阅者时才 active。
	active  bool
	source  accountWatchSource
	watched map[string]struct{}
	timer   *time.Timer
	closed  bool

	initialMu sync.Mutex
	refreshMu sync.Mutex

	tokenMu    sync.Mutex
	tokenCache map[string]tokenUsageEntry

	wake chan struct{}
	done chan struct{}
	once sync.Once
}

func newHub(options hubOptions) *Hub {
	now := options.now
	if now == nil {
		now = time.Now
	}
	hub := &Hub{
		rows:          options.rows,
		runtime:       options.runtime,
		states:        options.states,
		tokenUsage:    options.tokenUsage,
		catalog:       options.catalog,
		aiHomeDir:     options.aiHomeDir,
		sourceFactory: options.sourceFactory,
		now:           now,
		subs:          make(map[*subscriber]struct{}),
		tokenCache:    make(map[string]tokenUsageEntry),
		wake:          make(chan struct{}, 1),
		done:          make(chan struct{}),
	}
	if hub.catalog != nil {
		hub.capabilityMap = buildCapabilityMap(hub.catalog)
	}
	if hub.capabilityMap == nil {
		hub.capabilityMap = map[string]json.RawMessage{}
	}
	go hub.run()
	return hub
}

func (hub *Hub) close() {
	hub.once.Do(func() {
		close(hub.done)
		hub.mu.Lock()
		hub.closed = true
		hub.active = false
		if hub.timer != nil {
			hub.timer.Stop()
			hub.timer = nil
		}
		source := hub.source
		hub.source = nil
		hub.watched = nil
		for sub := range hub.subs {
			sub.stop()
			delete(hub.subs, sub)
		}
		hub.mu.Unlock()
		if source != nil {
			_ = source.Close()
		}
	})
}

func (hub *Hub) capabilities() map[string]json.RawMessage {
	return hub.capabilityMap
}

// signal 唤醒后台工人重新评估「是否有人在听」或处理一次显式刷新。
func (hub *Hub) signal() {
	select {
	case hub.wake <- struct{}{}:
	default:
	}
}

// run 只处理显式刷新请求；账号变化由 fsnotify 事件驱动，没有周期定时器。
func (hub *Hub) run() {
	for {
		select {
		case <-hub.done:
			return
		case <-hub.wake:
			hub.mu.Lock()
			force := hub.forceQueued
			hub.forceQueued = false
			hub.mu.Unlock()
			if force {
				hub.refresh(context.Background(), true)
			}
		}
	}
}

// start 惰性启动事件源：第一路订阅建立时才创建 watcher。
func (hub *Hub) start() {
	targets := hub.watchTargets()

	hub.mu.Lock()
	if hub.active || hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.active = true
	hub.watched = make(map[string]struct{})
	hub.mu.Unlock()

	var source accountWatchSource
	if len(targets) == 0 {
		// 没有数据目录（测试或降级装配）：保持 SSE 可用，不创建 watcher。
		source = newIdleAccountWatchSource()
	} else {
		var err error
		if hub.sourceFactory != nil {
			source, err = hub.sourceFactory()
		} else {
			source, err = newFsnotifyAccountWatchSource()
		}
		if err != nil || source == nil {
			// watcher 创建失败（fd 用尽、文件系统不支持）时降级为「只在显式
			// 请求时重建」；不能因此让 SSE 建立失败。
			source = newIdleAccountWatchSource()
		}
	}

	hub.mu.Lock()
	if hub.closed || !hub.active {
		hub.mu.Unlock()
		_ = source.Close()
		return
	}
	hub.source = source
	hub.mu.Unlock()

	go hub.consume(source)
	hub.syncTargets()

	// 空闲期间事件源是关闭的，缓存快照可能已经过期；新订阅建立后立即对齐
	// 一次（首帧快照已返回的情况下只会广播真正的差异）。
	hub.mu.Lock()
	if hub.active && !hub.closed && hub.hasSnapshot {
		hub.scheduleLocked(0)
	}
	hub.mu.Unlock()
}

// stopIfIdle 在最后一路订阅离开后释放 watcher，避免后台空转。
func (hub *Hub) stopIfIdle() {
	hub.mu.Lock()
	if !hub.active || len(hub.subs) > 0 || hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.active = false
	source := hub.source
	hub.source = nil
	hub.watched = nil
	if hub.timer != nil {
		hub.timer.Stop()
		hub.timer = nil
	}
	hub.mu.Unlock()
	if source != nil {
		_ = source.Close()
	}
}

func (hub *Hub) consume(source accountWatchSource) {
	for range source.Events() {
		hub.handleEvent()
	}
}

// handleEvent 把一批数据库写入合并成一次重建。
//
// 250ms 去抖吸收一次事务里的多个文件事件；2s 合并窗口与项目 watch 同口径，
// 持续写 WAL 时不会把整表重建打成每事件一次。
func (hub *Hub) handleEvent() {
	hub.mu.Lock()
	if !hub.active || hub.closed {
		hub.mu.Unlock()
		return
	}
	// 首帧快照建立前的文件事件由 ensureSnapshot 那次读取覆盖；此时按行 diff
	// 的前值是空的，提前重建会把整页账号当成新增逐条广播。记下发生过事件，
	// 等首帧落定后再补一次对齐，避免读取与事件之间的窗口漏掉写入。
	if !hub.hasSnapshot {
		hub.eventBeforeSnapshot = true
		hub.mu.Unlock()
		return
	}
	hub.scheduleLocked(accountWatchDebounce)
	hub.mu.Unlock()
}

// scheduleLocked 只安排一次合并重建；已有定时器时不重复排队。
func (hub *Hub) scheduleLocked(delay time.Duration) {
	if hub.closed || !hub.active || hub.timer != nil {
		return
	}
	if delay < 0 {
		delay = 0
	}
	hub.timer = time.AfterFunc(delay, func() {
		hub.mu.Lock()
		hub.timer = nil
		hub.mu.Unlock()
		hub.refresh(context.Background(), false)
	})
}

// syncTargets 把事件目标对齐到当前真实存在的数据库文件。
//
// 只增删差异项：-wal 在 checkpoint 后可能被删除/重建，重建完成后重新挂载，
// 避免 watcher 永久盯住已经失效的 inode。
func (hub *Hub) syncTargets() {
	targets := hub.watchTargets()

	hub.mu.Lock()
	source := hub.source
	if source == nil || !hub.active || hub.closed {
		hub.mu.Unlock()
		return
	}
	toRemove := make([]string, 0)
	for path := range hub.watched {
		if !containsPath(targets, path) {
			toRemove = append(toRemove, path)
		}
	}
	toAdd := make([]string, 0)
	for _, path := range targets {
		if _, exists := hub.watched[path]; !exists {
			toAdd = append(toAdd, path)
		}
	}
	hub.mu.Unlock()

	for _, path := range toRemove {
		source.Remove(path)
		hub.mu.Lock()
		if hub.watched != nil {
			delete(hub.watched, path)
		}
		hub.mu.Unlock()
	}
	for _, path := range toAdd {
		if source.Add(path) != nil {
			continue
		}
		hub.mu.Lock()
		if hub.watched != nil {
			hub.watched[path] = struct{}{}
		}
		hub.mu.Unlock()
	}
}

// watchTargets 返回账号库的监听目标。
//
// 数据根目录始终监听（捕获 -wal 重建/数据库替换），数据库文件存在时才单独
// 监听（不存在的路径 Add 会失败，目录事件仍会带来创建事件）。
func (hub *Hub) watchTargets() []string {
	directory := strings.TrimSpace(hub.aiHomeDir)
	if directory == "" {
		return nil
	}
	directory = filepath.Clean(directory)
	targets := make([]string, 0, 3)
	targets = append(targets, directory)
	for _, name := range []string{"aih.db", "aih.db-wal"} {
		path := filepath.Join(directory, name)
		if _, err := os.Stat(path); err == nil {
			targets = append(targets, path)
		}
	}
	return targets
}

func containsPath(paths []string, target string) bool {
	for _, path := range paths {
		if path == target {
			return true
		}
	}
	return false
}

// ensureSnapshot 保证首帧之前有一份已装配的快照。
//
// 读模型不可用时明确报错（Handler 回 503）：空快照会被前端当成「账号全没了」，
// 比一次明确的不可用更糟。
// liveSnapshot 返回最新实时账号列表，始终直读权威 SQLite + 运行态叠加层，并在已有长连快照时顺便同步给观察者。
func (hub *Hub) liveSnapshot(ctx context.Context) ([]webuiaccountsapi.Row, int64, map[string]json.RawMessage, error) {
	hub.refreshMu.Lock()
	defer hub.refreshMu.Unlock()

	rows, err := hub.loadRows(ctx)
	if err != nil {
		return nil, 0, nil, err
	}
	hub.mu.Lock()
	hasSnapshot := hub.hasSnapshot
	revision := hub.revision
	hub.mu.Unlock()
	if hasSnapshot {
		if applyErr := hub.applyRows(rows, false); applyErr == nil {
			hub.mu.Lock()
			revision = hub.revision
			hub.mu.Unlock()
		}
	}
	return rows, revision, hub.capabilities(), nil
}

func (hub *Hub) ensureSnapshot(ctx context.Context) ([]webuiaccountsapi.Row, int64, error) {
	hub.initialMu.Lock()
	defer hub.initialMu.Unlock()
	hub.mu.Lock()
	if hub.hasSnapshot {
		rows := append([]webuiaccountsapi.Row{}, hub.snapshot...)
		revision := hub.revision
		hub.mu.Unlock()
		return rows, revision, nil
	}
	hub.mu.Unlock()
	if err := hub.refreshOnce(ctx, true); err != nil {
		return nil, 0, err
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return append([]webuiaccountsapi.Row{}, hub.snapshot...), hub.revision, nil
}

func (hub *Hub) subscribe() *subscriber {
	sub := newSubscriber()
	hub.mu.Lock()
	hub.subs[sub] = struct{}{}
	hub.mu.Unlock()
	// 先登记再启动：启动期间的 stopIfIdle 不会把刚连上的这一路当成空闲。
	hub.start()
	hub.signal()
	return sub
}

func (hub *Hub) unsubscribe(sub *subscriber) {
	hub.mu.Lock()
	if _, found := hub.subs[sub]; found {
		delete(hub.subs, sub)
	}
	hub.mu.Unlock()
	sub.stop()
	hub.stopIfIdle()
	hub.signal()
}

// requestRefresh 记录一次显式刷新并立即返回（Node 的 202 语义）。
func (hub *Hub) requestRefresh() (int64, bool) {
	hub.mu.Lock()
	now := hub.now()
	requestedAt := now.UnixMilli()
	alreadyRunning := hub.refreshing || hub.forceQueued
	hub.lastRequest = requestedAt
	hub.forceQueued = true
	revision := hub.revision
	// 在释放 hub.mu 前把 snapshot-requested 放进订阅者队列，保证它严格先于随后由 forceQueued 触发的 hydrated 帧到达。
	frame := mustEncodeFrame(snapshotRequestedFrame{
		Type: "snapshot-requested", Revision: revision,
		RequestedAt: requestedAt, Hydrating: true,
	})
	dropped := hub.enqueueLocked(frame)
	hub.mu.Unlock()

	for _, sub := range dropped {
		hub.unsubscribe(sub)
	}
	hub.signal()
	return requestedAt, alreadyRunning
}

// refreshOnce 串行执行一次重建；force 时无论是否有变化都发 hydrated（Node 的
// 强制刷新语义）。
func (hub *Hub) refreshOnce(ctx context.Context, force bool) error {
	hub.refreshMu.Lock()
	defer hub.refreshMu.Unlock()

	if !force {
		hub.mu.Lock()
		if !hub.lastRefreshAt.IsZero() {
			if elapsed := time.Since(hub.lastRefreshAt); elapsed < accountWatchCoalesce {
				hub.scheduleLocked(accountWatchCoalesce - elapsed)
				hub.mu.Unlock()
				return nil
			}
		}
		hub.mu.Unlock()
	}

	hub.mu.Lock()
	hub.refreshing = true
	hub.mu.Unlock()
	defer func() {
		hub.mu.Lock()
		hub.refreshing = false
		hub.mu.Unlock()
	}()

	rows, err := hub.loadRows(ctx)
	if err != nil {
		return err
	}
	if err := hub.applyRows(rows, force); err != nil {
		return err
	}
	hub.mu.Lock()
	hub.lastRefreshAt = time.Now()
	hub.mu.Unlock()
	// 一轮重建后重新对齐监听目标：checkpoint 可能删除/重建 -wal。
	hub.syncTargets()
	return nil
}

// refresh 是事件驱动的入口：失败保持旧快照，不把一次数据库抖动放大成空列表。
func (hub *Hub) refresh(ctx context.Context, force bool) {
	hub.mu.Lock()
	closed := hub.closed
	hub.mu.Unlock()
	if closed {
		return
	}
	_ = hub.refreshOnce(ctx, force)
}

// applyRows 对比新旧行集合并广播增量。
//
// 规则与 Node 的 live hub 对齐：新增/变化的行发 account，消失的行发
// account-removed，每条事件自增 revision；最后在 force 或确有变化时发 hydrated。
func (hub *Hub) applyRows(rows []webuiaccountsapi.Row, force bool) error {
	next := make(map[string]webuiaccountsapi.Row, len(rows))
	for _, row := range rows {
		if ref := strings.TrimSpace(row.AccountRef); ref != "" {
			next[ref] = row
		}
	}

	hub.mu.Lock()
	// 首份快照由 serveWatch 的 snapshot 帧整体下发；此时按空前值做 diff 会把
	// 每个账号都当成新增再广播一遍。首帧只建立前值，不发增量。
	firstSnapshot := !hub.hasSnapshot
	previous := hub.byRef
	changed := make([]webuiaccountsapi.Row, 0)
	removed := make([]webuiaccountsapi.Row, 0)
	for _, ref := range sortedRefs(next) {
		row := next[ref]
		old, found := previous[ref]
		if found && rowsEqual(old, row) {
			continue
		}
		changed = append(changed, row)
	}
	for _, ref := range sortedRefs(previous) {
		if _, found := next[ref]; !found {
			removed = append(removed, previous[ref])
		}
	}
	nowMS := hub.now().UnixMilli()
	if firstSnapshot {
		changed = changed[:0]
		removed = removed[:0]
	}
	frames := make([][]byte, 0, len(changed)+len(removed)+1)
	for _, row := range changed {
		hub.revision++
		frames = append(frames, mustEncodeFrame(accountFrame{
			Type: "account", Revision: hub.revision, Account: row,
		}))
	}
	for _, row := range removed {
		hub.revision++
		reason := "canonical_account_missing"
		frames = append(frames, mustEncodeFrame(accountRemovedFrame{
			Type: "account-removed", Revision: hub.revision,
			Provider: row.Provider, AccountRef: row.AccountRef,
			Reason: reason, RemovedAt: nowMS,
		}))
	}
	if !firstSnapshot && (force || len(changed) > 0 || len(removed) > 0) {
		hub.hydratedAt = nowMS
		frames = append(frames, mustEncodeFrame(hydratedFrame{
			Type: "hydrated", Revision: hub.revision, HydratedAt: nowMS,
		}))
	}
	hub.snapshot = rows
	hub.byRef = next
	hub.hasSnapshot = true
	if hub.eventBeforeSnapshot {
		// 首帧建立期间来过数据库事件：前值现在才就绪，立刻补一次对齐。
		hub.eventBeforeSnapshot = false
		hub.lastRefreshAt = time.Time{}
		hub.scheduleLocked(0)
	}
	hub.mu.Unlock()

	for _, frame := range frames {
		hub.broadcast(frame)
	}
	return nil
}

func mustEncodeFrame(payload any) []byte {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	return []byte("data: " + string(encoded) + "\n\n")
}

func (hub *Hub) broadcastFrame(payload any) {
	if frame := mustEncodeFrame(payload); frame != nil {
		hub.broadcast(frame)
	}
}

func (hub *Hub) enqueueLocked(frame []byte) []*subscriber {
	if frame == nil || len(hub.subs) == 0 {
		return nil
	}
	var dropped []*subscriber
	for sub := range hub.subs {
		select {
		case sub.events <- frame:
		case <-sub.done:
		default:
			dropped = append(dropped, sub)
		}
	}
	return dropped
}

// broadcast 永不阻塞：慢订阅者积压满队列就断开，浏览器会自行重连。
func (hub *Hub) broadcast(frame []byte) {
	if frame == nil {
		return
	}
	hub.mu.Lock()
	dropped := hub.enqueueLocked(frame)
	hub.mu.Unlock()
	for _, sub := range dropped {
		hub.unsubscribe(sub)
	}
}

// loadRows 按稳定游标翻完账号页读模型，再补齐展示字段。
func (hub *Hub) loadRows(ctx context.Context) ([]webuiaccountsapi.Row, error) {
	rows := make([]webuiaccountsapi.Row, 0)
	afterRef := ""
	for page := 0; page < rowsMaxPages; page++ {
		result, err := hub.rows.ListAccountRows(ctx, webuiaccountsapi.Query{
			AfterRef: afterRef, Limit: rowsPageSize,
		})
		if err != nil {
			return nil, err
		}
		rows = append(rows, result.Rows...)
		if len(result.Rows) < rowsPageSize {
			break
		}
		last := strings.TrimSpace(result.Rows[len(result.Rows)-1].AccountRef)
		if last == "" || last == afterRef {
			break
		}
		afterRef = last
	}
	hub.enrichRows(ctx, rows)
	return rows, nil
}

func rowsEqual(left, right webuiaccountsapi.Row) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return string(leftJSON) == string(rightJSON)
}

func (hub *Hub) enrichRows(ctx context.Context, rows []webuiaccountsapi.Row) {
	if len(rows) == 0 {
		return
	}
	now := hub.now()
	states := hub.loadStates(ctx)
	runtimeViews := hub.loadRuntimeViews()
	for index := range rows {
		row := &rows[index]
		ref := strings.TrimSpace(row.AccountRef)
		row.Status = "up"
		if !row.Enabled {
			row.Status = "down"
		}
		lastUsed := int64(0)
		if state, found := states[ref]; found {
			if documentLast := documentLastSuccessMS(state.Document()); documentLast > lastUsed {
				lastUsed = documentLast
			}
			status := state.DeriveStatus(now)
			if !status.IsHealthy() {
				row.RuntimeStatus = status.Status()
				row.RuntimeReason = status.Reason()
				row.RuntimeUntil = unixMilli(status.Until())
			}
		}
		// Go 运行态叠加层最后生效：与 Node 的 applyGoRuntimeOverlay 一致，
		// Go 亲自观察到的阻塞/最近成功优先于 Node 推进来的运行态文档。
		if view, found := runtimeViews[ref]; found {
			applyRuntimeView(row, view)
			if lastSuccess := unixMilli(view.LastSuccessAt); lastSuccess > lastUsed {
				lastUsed = lastSuccess
			}
		}
		if captured := usageSnapshotCapturedAt(row.UsageSnapshot); captured > lastUsed {
			lastUsed = captured
		}
		if lastUsed > 0 {
			value := lastUsed
			row.LastUsedAt = &value
		}
		if usage, ok := hub.tokenUsageFor(ctx, ref); ok {
			row.TokenUsage = usage
			row.TokenUsageSource = "go"
		}
	}
	hub.enrichExtras(ctx, rows)
}

func (hub *Hub) loadStates(ctx context.Context) map[string]runtimecore.AccountState {
	states := make(map[string]runtimecore.AccountState)
	if hub.states == nil {
		return states
	}
	list, err := hub.states.ListAccountStates(ctx)
	if err != nil {
		return states
	}
	for _, state := range list {
		ref := state.AccountRef().String()
		if ref != "" {
			states[ref] = state
		}
	}
	return states
}

func (hub *Hub) loadRuntimeViews() map[string]runtimeapp.AccountView {
	views := make(map[string]runtimeapp.AccountView)
	if hub.runtime == nil {
		return views
	}
	for _, view := range hub.runtime.RuntimeSnapshot() {
		if ref := view.AccountRef.String(); ref != "" {
			views[ref] = view
		}
	}
	return views
}

// accountBlockStatus 与 Node 的 ACCOUNT_BLOCK_STATUS 逐条一致。
var accountBlockStatus = map[string]struct {
	status string
	reason string
}{
	"credentials_updated": {"auth_invalid", "go_runtime_credentials_rejected"},
	"usage_snapshot":      {"rate_limited", "go_runtime_quota_exhausted"},
	"billing_snapshot":    {"service_unavailable", "go_runtime_billing_blocked"},
	"account_status":      {"service_unavailable", "go_runtime_account_deactivated"},
	"policy_snapshot":     {"service_unavailable", "go_runtime_policy_blocked"},
}

// applyRuntimeView 把 Go 的账号级阻塞折算成账号页的运行态字段。
// 只有模型级状态时不整号标红（一个模型 429 不代表整号不可用），与 Node 一致。
func applyRuntimeView(row *webuiaccountsapi.Row, view runtimeapp.AccountView) {
	for _, block := range view.Blocks {
		mapped, found := accountBlockStatus[string(block)]
		if !found {
			continue
		}
		row.RuntimeStatus = mapped.status
		row.RuntimeReason = mapped.reason
		row.RuntimeUntil = 0
		return
	}
}

// usageSnapshotCapturedAt 从归一后的额度快照里取采集时间（毫秒）。
func usageSnapshotCapturedAt(snapshot any) int64 {
	object, ok := snapshot.(map[string]any)
	if !ok || object == nil {
		return 0
	}
	return numberFromAny(object["capturedAt"])
}

func documentLastSuccessMS(document []byte) int64 {
	if len(document) == 0 {
		return 0
	}
	var parsed struct {
		LastSuccessAt any `json:"lastSuccessAt"`
	}
	if err := json.Unmarshal(document, &parsed); err != nil {
		return 0
	}
	return numberFromAny(parsed.LastSuccessAt)
}

// tokenUsageFor 读账号 token 用量：60s 缓存、失败 30s 后重试——与 Node 的
// account-token-usage-go-source 同口径，避免每拍快照把整库账本扫一遍。
func (hub *Hub) tokenUsageFor(ctx context.Context, accountRef string) (*tokenUsageView, bool) {
	if hub.tokenUsage == nil || accountRef == "" {
		return nil, false
	}
	now := hub.now()
	hub.tokenMu.Lock()
	entry, found := hub.tokenCache[accountRef]
	hub.tokenMu.Unlock()
	if found {
		if entry.value != nil && now.Before(entry.fetchedAt.Add(defaultTokenUsageTTL)) {
			return entry.value, true
		}
		if entry.value == nil && now.Before(entry.retryAt) {
			return nil, false
		}
	}
	ref, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		return nil, false
	}
	_, offsetSeconds := now.Zone()
	usage, err := hub.tokenUsage.QueryAccountTokenUsage(ctx, usageledger.Query{
		From:       time.Unix(0, 0).UTC(),
		To:         now.UTC(),
		AccountRef: ref,
	}, offsetSeconds/60)
	if err != nil {
		hub.tokenMu.Lock()
		hub.tokenCache[accountRef] = tokenUsageEntry{retryAt: now.Add(tokenUsageRetryDelay)}
		hub.tokenMu.Unlock()
		return nil, false
	}
	value := newTokenUsageView(usage)
	hub.tokenMu.Lock()
	hub.tokenCache[accountRef] = tokenUsageEntry{value: value, fetchedAt: now}
	hub.tokenMu.Unlock()
	return value, true
}

// PublishPath 让宿主把 Node 仍然产生的事件（token-consumed / account-activity）
// 注入同一条实时流：迁移 watch 到 Go 时，这两类帧必须继续出现在浏览器端。
//
//	POST /v1/management/webui/accounts/watch/publish
const PublishPath = Path + "/publish"

// 保留类型：快照与账号行只能由 Go 从数据库推导，外部注入会让两侧版本与内容分叉。
var reservedPublishTypes = map[string]struct{}{
	"snapshot": {},
	"account":  {},
}

// ErrInvalidPublish 表示外部事件体不合法（缺 type 或类型保留）。
var ErrInvalidPublish = errors.New("账号实时事件体无效")

// Publish 把外部事件广播给所有订阅者。
//
// 事件体必须自带 type；revision 由 hub 统一补，保证前端按同一版本号排序。
// 广播永不阻塞：慢订阅者积压满队列就断开，浏览器会自行重连。
func (hub *Hub) Publish(event map[string]any) error {
	if hub == nil || event == nil {
		return ErrInvalidPublish
	}
	eventType := strings.TrimSpace(fmt.Sprint(event["type"]))
	if eventType == "" {
		return ErrInvalidPublish
	}
	if _, reserved := reservedPublishTypes[eventType]; reserved {
		return ErrInvalidPublish
	}
	hub.mu.Lock()
	event["revision"] = hub.revision
	hub.mu.Unlock()
	hub.broadcastFrame(event)
	return nil
}
