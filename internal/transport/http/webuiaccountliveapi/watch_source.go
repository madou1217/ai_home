package webuiaccountliveapi

import (
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// accountWatchEvent 是事件源产出的最小事实：账号数据库发生了写入。
//
// 不在事件里解析表名或账号：SQLite 的 WAL 写入不携带行级信息，事件只负责
// 唤醒快照重建；真正的变化由重建后的行 diff 决定。
type accountWatchEvent struct {
	path string
}

// accountWatchSource 是「真实事件源」的端口。
//
// 生产实现是 fsnotify（macOS kqueue / Linux inotify），不做任何 ticker 轮询。
// 测试可以注入假实现，不依赖真实文件系统时序。
type accountWatchSource interface {
	Add(path string) error
	Remove(path string)
	Events() <-chan accountWatchEvent
	Close() error
}

// idleAccountWatchSource 在 fsnotify 不可用（或没有数据目录）时保底：
// 没有自动事件，但 SSE 仍能建立，显式 snapshot 请求仍然生效。
type idleAccountWatchSource struct {
	events chan accountWatchEvent
	once   sync.Once
}

func newIdleAccountWatchSource() *idleAccountWatchSource {
	return &idleAccountWatchSource{events: make(chan accountWatchEvent)}
}

func (source *idleAccountWatchSource) Add(string) error                 { return nil }
func (source *idleAccountWatchSource) Remove(string)                    {}
func (source *idleAccountWatchSource) Events() <-chan accountWatchEvent { return source.events }
func (source *idleAccountWatchSource) Close() error {
	source.once.Do(func() { close(source.events) })
	return nil
}

// fsnotifyAccountWatchSource 用 OS 文件通知监听 aih.db 的事务写入。
//
// 监听三处：
//   - aih.db：checkpoint 或非 WAL 写入；
//   - aih.db-wal：WAL 模式下的正常写入；
//   - 数据根目录：-wal 被删除后重新创建、数据库被原子替换时重新挂载。
//
// -shm 是 SQLite 读事务也会改写的共享内存文件，必须忽略，否则读快照本身
// 会触发下一轮重建，形成自激循环。
type fsnotifyAccountWatchSource struct {
	watcher *fsnotify.Watcher
	events  chan accountWatchEvent

	mu      sync.Mutex
	watched map[string]struct{}

	closeOnce sync.Once
}

func newFsnotifyAccountWatchSource() (accountWatchSource, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	source := &fsnotifyAccountWatchSource{
		watcher: watcher,
		events:  make(chan accountWatchEvent, 64),
		watched: make(map[string]struct{}),
	}
	go source.loop()
	return source, nil
}

func (source *fsnotifyAccountWatchSource) loop() {
	defer close(source.events)
	for {
		select {
		case event, ok := <-source.watcher.Events:
			if !ok {
				return
			}
			source.handle(event)
		case _, ok := <-source.watcher.Errors:
			if !ok {
				return
			}
			// 队列溢出等错误意味着可能丢事件：当成一次全量变化唤醒重建，
			// 上层会在重建后重新对齐监听目标。
			source.emit(accountWatchEvent{})
		}
	}
}

func (source *fsnotifyAccountWatchSource) handle(event fsnotify.Event) {
	// 纯权限变化不代表数据变了。
	if event.Op&^fsnotify.Chmod == 0 {
		return
	}
	// SQLite 每次读事务都会重写 -shm，监听它会造成自激循环。
	if isSQLiteSharedMemoryPath(event.Name) {
		return
	}
	name := filepath.Clean(event.Name)
	source.mu.Lock()
	_, exact := source.watched[name]
	if exact && event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
		// 文件被原子替换/删除后原 fd 的监听已失效；移除映射，下一轮
		// syncTargets 重新挂载。
		delete(source.watched, name)
	}
	source.mu.Unlock()

	if !isAccountDatabasePath(name) {
		return
	}
	source.emit(accountWatchEvent{path: name})
}

func (source *fsnotifyAccountWatchSource) emit(event accountWatchEvent) {
	select {
	case source.events <- event:
	default:
		// 已有一批未处理事件：合并成一次重建即可，丢重复事件不会漏最终状态。
	}
}

func (source *fsnotifyAccountWatchSource) Add(path string) error {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "" || cleaned == "." {
		return nil
	}
	source.mu.Lock()
	if _, exists := source.watched[cleaned]; exists {
		source.mu.Unlock()
		return nil
	}
	source.mu.Unlock()
	if err := source.watcher.Add(cleaned); err != nil {
		return err
	}
	source.mu.Lock()
	source.watched[cleaned] = struct{}{}
	source.mu.Unlock()
	return nil
}

func (source *fsnotifyAccountWatchSource) Remove(path string) {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	source.mu.Lock()
	delete(source.watched, cleaned)
	source.mu.Unlock()
	_ = source.watcher.Remove(cleaned)
}

func (source *fsnotifyAccountWatchSource) Events() <-chan accountWatchEvent {
	return source.events
}

func (source *fsnotifyAccountWatchSource) Close() error {
	source.closeOnce.Do(func() {
		_ = source.watcher.Close()
	})
	return nil
}

// isAccountDatabasePath 只把账号库文件当成有效事件。
//
// 数据根目录下还有日志、锁文件等无关写入；目录监听只用于重新挂载数据库文件，
// 不能让这些噪声把快照重建打成常量。
func isAccountDatabasePath(path string) bool {
	switch strings.ToLower(filepath.Base(strings.TrimSpace(path))) {
	case "aih.db", "aih.db-wal", "aih.db-journal":
		return true
	default:
		return false
	}
}

func isSQLiteSharedMemoryPath(path string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(path)), "-shm")
}
