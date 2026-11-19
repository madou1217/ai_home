package codexlocalappserver

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
	"github.com/madou1217/ai_home/internal/runtime/platform"
)

const (
	poolStateVersion   = 1
	poolLockStaleAfter = 30 * time.Second
	poolReadyTimeout   = 20 * time.Second
)

// poolFingerprintEnv 只纳入决定后端等价性的环境变量；终端级关联值必须排除。
var poolFingerprintEnv = []string{
	"HOME",
	"CODEX_HOME",
	"CODEX_SQLITE_HOME",
	"AIH_HOME_DIR",
	"AIH_HOST_HOME",
	"AIH_CODEX_FLAGS",
	"AIH_RUNTIME_MARKER",
}

type poolState struct {
	Version   int    `json:"version"`
	PID       int    `json:"pid"`
	URL       string `json:"url"`
	CreatedAt int64  `json:"createdAt"`
}

type poolLeaseFile struct {
	PID       int   `json:"pid"`
	CreatedAt int64 `json:"createdAt"`
}

// PoolLease 是一次后端借用；Release 幂等且不会终止其它终端的后端。
type PoolLease struct {
	URL     string
	release func()
}

// Release 归还后端；其它租约仍在时后端保持运行。
func (l *PoolLease) Release() {
	if l == nil || l.release == nil {
		return
	}
	l.release()
}

func poolRoot(env []string) string {
	values := envMap(env)
	if dir := strings.TrimSpace(values["AIH_HOME_DIR"]); dir != "" {
		return filepath.Join(dir, "run", "codex", "app-server-pool")
	}
	home := strings.TrimSpace(values["HOME"])
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".ai_home", "run", "codex", "app-server-pool")
}

func envMap(env []string) map[string]string {
	out := make(map[string]string, len(env))
	for _, entry := range env {
		index := strings.Index(entry, "=")
		if index <= 0 {
			continue
		}
		out[entry[:index]] = entry[index+1:]
	}
	return out
}

func poolKey(command string, args []string, cwd string, env []string, injectCwd bool) string {
	values := envMap(env)
	var builder strings.Builder
	builder.WriteString("v1\n")
	builder.WriteString(command)
	builder.WriteString("\n")
	builder.WriteString(strings.Join(args, "\x00"))
	builder.WriteString("\n")
	builder.WriteString(cwd)
	builder.WriteString("\n")
	builder.WriteString(strconv.FormatBool(injectCwd))
	builder.WriteString("\n")
	for _, name := range poolFingerprintEnv {
		builder.WriteString(name)
		builder.WriteString("=")
		builder.WriteString(values[name])
		builder.WriteString("\n")
	}
	sum := sha256.Sum256([]byte(builder.String()))
	return hex.EncodeToString(sum[:16])
}

func newLeaseID() string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

// acquirePooledBackend 返回一个共享 app-server：同指纹的终端复用一个进程，
// 没有可用后端时按需启动，其余租约为空的后端会被顺带回收。
func acquirePooledBackend(ctx context.Context, config Config, env []string) (*PoolLease, error) {
	root := poolRoot(env)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	args := codexappserverws.StripSessionHeaderArgs(config.Args)
	key := poolKey(config.Command, args, config.Cwd, env, config.InjectCwd)
	reapIdleBackends(root)
	deadline := time.Now().Add(poolReadyTimeout)
	for {
		if lease, ok := leaseExistingBackend(root, key, config.Cwd); ok {
			return lease, nil
		}
		lock, ok, err := takePoolLock(root, key)
		if err != nil {
			return nil, err
		}
		if ok {
			defer releasePoolLock(lock)
			if lease, exists := leaseExistingBackend(root, key, config.Cwd); exists {
				return lease, nil
			}
			return startPooledBackend(root, key, config, args, env)
		}
		if time.Now().After(deadline) {
			return nil, errors.New("codex_backend_pool_lock_timeout")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(120 * time.Millisecond):
		}
	}
}

func startPooledBackend(root, key string, config Config, args []string, env []string) (*PoolLease, error) {
	statePath := filepath.Join(root, key+".json")
	backend, err := codexappserverws.StartSharedBackend(codexappserverws.SharedBackendOptions{
		Command: config.Command,
		Args:    args,
		Dir:     config.Cwd,
		Env:     env,
		LogPath: filepath.Join(root, key+".log"),
	})
	if err != nil {
		return nil, err
	}
	if err = writePoolState(statePath, poolState{Version: poolStateVersion, PID: backend.PID, URL: backend.URL, CreatedAt: time.Now().Unix()}); err != nil {
		return nil, err
	}
	return newPoolLease(root, key, backend.URL)
}

func leaseExistingBackend(root, key, cwd string) (*PoolLease, bool) {
	state, ok := readPoolState(filepath.Join(root, key+".json"))
	if !ok {
		return nil, false
	}
	if !platform.ProcessAlive(state.PID) || !backendReady(state.URL) {
		return nil, false
	}
	lease, err := newPoolLease(root, key, state.URL)
	if err != nil {
		return nil, false
	}
	return lease, true
}

func newPoolLease(root, key, url string) (*PoolLease, error) {
	leaseDir := filepath.Join(root, key+".leases")
	if err := os.MkdirAll(leaseDir, 0o755); err != nil {
		return nil, err
	}
	leasePath := filepath.Join(leaseDir, newLeaseID()+".json")
	payload, err := json.Marshal(poolLeaseFile{PID: os.Getpid(), CreatedAt: time.Now().Unix()})
	if err != nil {
		return nil, err
	}
	if err = os.WriteFile(leasePath, payload, 0o600); err != nil {
		return nil, err
	}
	var once sync.Once
	return &PoolLease{URL: url, release: func() {
		once.Do(func() {
			_ = os.Remove(leasePath)
			reapIdleBackends(root)
		})
	}}, nil
}

// backendReady 只在端口确实关闭或明确不可用时否定复用。
// app-server 启动初期可能忙于拉起插件，/readyz 偶尔超时；
// 此时端口仍由该后端占用，按存活处理，避免重复拉起第二个后端。
func backendReady(url string) bool {
	address := strings.TrimPrefix(strings.TrimSuffix(url, "/"), "ws://")
	conn, err := net.DialTimeout("tcp", address, 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://" + address + "/readyz")
	if err != nil {
		return true
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func readPoolState(path string) (poolState, bool) {
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return poolState{}, false
	}
	var state poolState
	if json.Unmarshal(raw, &state) != nil || state.Version != poolStateVersion || state.PID <= 0 || !strings.HasPrefix(state.URL, "ws://127.0.0.1:") {
		return poolState{}, false
	}
	return state, true
}

func writePoolState(path string, state poolState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temp := path + ".tmp" + strconv.Itoa(os.Getpid())
	if err = os.WriteFile(temp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

func takePoolLock(root, key string) (string, bool, error) {
	lockPath := filepath.Join(root, key+".lock")
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		_, _ = file.WriteString(strconv.Itoa(os.Getpid()) + "\n")
		_ = file.Close()
		return lockPath, true, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return "", false, err
	}
	if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > poolLockStaleAfter {
		_ = os.Remove(lockPath)
	}
	return "", false, nil
}

func releasePoolLock(lockPath string) {
	if lockPath == "" {
		return
	}
	_ = os.Remove(lockPath)
}

// reapIdleBackends 回收没有任何存活租约的后端；仍在服务的后端保持不动。
func reapIdleBackends(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		key := strings.TrimSuffix(entry.Name(), ".json")
		statePath := filepath.Join(root, entry.Name())
		state, ok := readPoolState(statePath)
		if !ok {
			continue
		}
		if livePoolLeases(root, key) > 0 {
			continue
		}
		lock, got, lockErr := takePoolLock(root, key)
		if lockErr != nil || !got {
			continue
		}
		if livePoolLeases(root, key) == 0 {
			terminatePooledBackend(state)
			_ = os.Remove(statePath)
			_ = os.RemoveAll(filepath.Join(root, key+".leases"))
		}
		releasePoolLock(lock)
	}
}

func livePoolLeases(root, key string) int {
	leaseDir := filepath.Join(root, key+".leases")
	entries, err := os.ReadDir(leaseDir)
	if err != nil {
		return 0
	}
	live := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(leaseDir, entry.Name())
		raw, err := os.ReadFile(filepath.Clean(path))
		if err != nil {
			continue
		}
		var lease poolLeaseFile
		if json.Unmarshal(raw, &lease) != nil || lease.PID <= 0 {
			_ = os.Remove(path)
			continue
		}
		if platform.ProcessAlive(lease.PID) {
			live++
			continue
		}
		_ = os.Remove(path)
	}
	return live
}

func terminatePooledBackend(state poolState) {
	process, err := os.FindProcess(state.PID)
	if err != nil {
		return
	}
	_ = process.Signal(syscall.SIGTERM)
	if waitForProcessExit(state.PID, 3*time.Second) {
		return
	}
	// 终端的 TUI 已离开；后端必须让出内存，不再保留僵尸后端。
	_ = process.Kill()
	_ = waitForProcessExit(state.PID, 2*time.Second)
}

func waitForProcessExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !platform.ProcessAlive(pid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return !platform.ProcessAlive(pid)
}
