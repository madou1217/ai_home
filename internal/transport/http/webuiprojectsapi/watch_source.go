package webuiprojectsapi

import (
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// fsnotifyProjectWatchSource 是生产事件源：OS 文件通知，不做任何 ticker 轮询。
//
// macOS 走 kqueue、Linux 走 inotify；两者都只对显式 Add 的路径发事件。
// 目录负责结构变化，数据库文件/-wal 负责 SQLite 写入。
type fsnotifyProjectWatchSource struct {
	watcher *fsnotify.Watcher
	events  chan projectWatchEvent

	mu    sync.Mutex
	kinds map[string]projectWatchKind

	closeOnce sync.Once
}

func newFsnotifyProjectWatchSource() (projectWatchSource, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	source := &fsnotifyProjectWatchSource{
		watcher: watcher,
		events:  make(chan projectWatchEvent, 1024),
		kinds:   make(map[string]projectWatchKind),
	}
	go source.loop()
	return source, nil
}

func (source *fsnotifyProjectWatchSource) loop() {
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
			// 事件队列溢出等错误意味着可能丢事件：当成一次全量变化，
			// 让上层重建快照并重新对齐 watcher，而不是静默漏掉。
			source.emit(projectWatchEvent{kind: projectWatchKindProjects})
		}
	}
}

func (source *fsnotifyProjectWatchSource) handle(event fsnotify.Event) {
	// 纯权限变化不代表数据变了。
	if event.Op&^fsnotify.Chmod == 0 {
		return
	}
	// SQLite 每次读事务都会重写 -shm，监听它会造成自激循环。
	if isSQLiteSharedMemoryPath(event.Name) {
		return
	}

	source.mu.Lock()
	kind, known := source.lookupLocked(event.Name)
	if _, exact := source.kinds[event.Name]; exact && event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
		// 文件被原子替换/删除后原 fd 的监听已失效；移除映射，下一轮 syncTargets 重新挂载。
		delete(source.kinds, event.Name)
	}
	source.mu.Unlock()

	if known {
		source.emit(projectWatchEvent{kind: kind, path: event.Name})
	}
}

// lookupLocked 支持「父目录被监听、事件名是子项」的形态。
//
// macOS kqueue 对目录写入会下发新增子项的具体路径（例如
// projects/<dir>/<session>.jsonl），只按精确路径查表会漏掉事件。
func (source *fsnotifyProjectWatchSource) lookupLocked(path string) (projectWatchKind, bool) {
	for candidate := filepath.Clean(path); ; candidate = filepath.Dir(candidate) {
		if kind, exists := source.kinds[candidate]; exists {
			return kind, true
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return projectWatchKindProjects, false
		}
	}
}

func (source *fsnotifyProjectWatchSource) emit(event projectWatchEvent) {
	select {
	case source.events <- event:
	default:
		// 队列已满说明已有一批未处理事件；上层按「有变化」重建一次即可，
		// 丢重复事件不会漏掉最终状态。
	}
}

func (source *fsnotifyProjectWatchSource) Add(kind projectWatchKind, path string) error {
	source.mu.Lock()
	if _, exists := source.kinds[path]; exists {
		source.mu.Unlock()
		return nil
	}
	source.mu.Unlock()
	if err := source.watcher.Add(path); err != nil {
		return err
	}
	source.mu.Lock()
	source.kinds[path] = kind
	source.mu.Unlock()
	return nil
}

func (source *fsnotifyProjectWatchSource) Remove(path string) {
	source.mu.Lock()
	delete(source.kinds, path)
	source.mu.Unlock()
	_ = source.watcher.Remove(path)
}

func (source *fsnotifyProjectWatchSource) Events() <-chan projectWatchEvent {
	return source.events
}

func (source *fsnotifyProjectWatchSource) Close() error {
	source.closeOnce.Do(func() {
		_ = source.watcher.Close()
	})
	return nil
}

func isSQLiteSharedMemoryPath(path string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(path)), "-shm")
}
