package accountremoval

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// registryRelativeDir 与 lib/runtime/persistent-session-registry.js 的
	// REGISTRY_SUBDIR 保持同一落点。
	registryRelativeDir = "run/persistent-sessions"
	// gatewayRuntimeScope 是网关会话的固定作用域；这类登记不绑定账号。
	gatewayRuntimeScope = "gateway"
	// probeTimeout 与 Node 的 spawnSync timeout 保持一致。
	probeTimeout = 1500 * time.Millisecond
	// maxRegistryFileBytes 防止异常登记文件把删除流程拖死。
	maxRegistryFileBytes = 64 * 1024
	// maxProbeOutputBytes 限制 tmux list-sessions 的输出规模。
	maxProbeOutputBytes  = 4 * 1024 * 1024
	maxRegistryKeyLength = 512
)

// SessionSnapshot 是一次 tmux 服务端探测的三态结果。
type SessionSnapshot struct {
	// ServerAlive 表示该 socket 上的 tmux 服务端仍在运行。
	ServerAlive bool
	// Sessions 是服务端返回的会话名；ServerAlive 为 false 时为空。
	Sessions []string
}

// SessionProbe 把「这台机器上的 tmux 服务端是否还在」抽成可注入边界。
//
// 返回 error 表示无法确认（引擎缺失、超时、输出异常）：调用方必须 fail-closed，
// 因为无法确认的会话仍可能攥着待删除账号的凭据。
type SessionProbe interface {
	Probe(ctx context.Context, socket string) (SessionSnapshot, error)
}

// hostTmuxProbe 使用宿主 tmux/psmux 探测指定 socket。
type hostTmuxProbe struct{}

// sessionEntry 是持久会话登记的一行；字段与 Node 的 normalizeEntry 对齐。
type sessionEntry struct {
	Provider     string `json:"provider"`
	RuntimeScope string `json:"runtimeScope"`
	Gateway      bool   `json:"gateway"`
	AccountRef   string `json:"accountRef"`
	Socket       string `json:"socket"`
	Session      string `json:"session"`
	// filePath 是实际读到的登记文件；陈旧条目按它删除。
	filePath string
}

// probeState 缓存同一 socket 的探测结果，避免为每个会话重复拉起 tmux。
type probeState struct {
	serverAlive bool
	names       map[string]struct{}
	err         error
}

// AssertNoSessionWriters 按 Node 的语义检查目标账号是否仍被持久会话占用。
//
// 判定与 lib/account/account-removal.js 的 assertNoPersistentSessionWriters 一致：
//   - 精确会话仍存活 → ErrAccountRuntimeActive；
//   - 服务端不存在，或服务端存活但精确会话已消失 → 陈旧登记，当场清除后放行；
//   - 探测无法确认 → ErrAccountRuntimeUnverifiable（同样拒绝删除）。
//
// 实现直接复用 InspectAccountDeletion：删除前探测与占用者上报必须是同一份事实，
// 两套实现只会让「探测说有人、上报说没人」这类偏差长期存在。
func (service *Service) AssertNoSessionWriters(
	ctx context.Context,
	providerRaw string,
	accountRefRaw string,
) error {
	if service == nil || service.aiHomeDir == "" || ctx == nil {
		return ErrInvalidRequest
	}
	provider, accountRef, err := parseTarget(providerRaw, accountRefRaw)
	if err != nil {
		return err
	}
	blockers, err := service.inspectAccountDeletion(ctx, provider, accountRef, false)
	if err != nil {
		return err
	}
	for _, blocker := range blockers {
		if blocker.Uncertain {
			detail := strings.TrimSpace(blocker.Detail)
			if detail == "" {
				detail = "持久会话探测失败"
			}
			return fmt.Errorf("%w: %s", accountapp.ErrAccountRuntimeUnverifiable, detail)
		}
	}
	if len(blockers) > 0 {
		return fmt.Errorf("%w: persistent_session", accountapp.ErrAccountRuntimeActive)
	}
	return nil
}

// readRegistryEntries 读取全部可用登记；损坏的登记必须 fail-closed。
func (service *Service) readRegistryEntries() ([]sessionEntry, error) {
	directory := filepath.Join(service.aiHomeDir, filepath.FromSlash(registryRelativeDir))
	files, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries := make([]sessionEntry, 0, len(files))
	for _, file := range files {
		name := file.Name()
		if strings.HasPrefix(name, ".") || filepath.Ext(name) != ".json" {
			continue
		}
		if file.Type()&os.ModeSymlink != 0 {
			return nil, errors.New("持久会话登记不能是符号链接")
		}
		info, err := file.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxRegistryFileBytes {
			return nil, errors.New("持久会话登记文件无效")
		}
		filePath := filepath.Join(directory, name)
		document, err := readBoundedFile(filePath, maxRegistryFileBytes)
		if err != nil {
			return nil, err
		}
		var entry sessionEntry
		if err := json.Unmarshal(document, &entry); err != nil {
			return nil, errors.New("持久会话登记内容无效")
		}
		// 不可用的登记与 Node 的 isUsableEntry 一样静默跳过：它们不指向任何
		// 可验证的会话，也不构成删除阻塞。
		if !usableSessionEntry(entry) {
			continue
		}
		entry.filePath = filePath
		entries = append(entries, entry)
	}
	return entries, nil
}

// usableSessionEntry 复刻 Node 的 isUsableEntry：网关登记不绑定账号，账号登记
// 必须自洽（作用域等于账号引用）。
func usableSessionEntry(entry sessionEntry) bool {
	if !safeRegistryKey(entry.Provider) || !safeRegistryKey(entry.Socket) || !safeRegistryKey(entry.Session) {
		return false
	}
	if entry.Gateway {
		return entry.AccountRef == "" && entry.RuntimeScope == gatewayRuntimeScope
	}
	if entry.AccountRef == "" || entry.RuntimeScope != entry.AccountRef {
		return false
	}
	_, err := accountcore.ParseAccountRef(entry.AccountRef)
	return err == nil
}

func safeRegistryKey(value string) bool {
	if value == "" || len(value) > maxRegistryKeyLength {
		return false
	}
	for _, character := range value {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '.', character == '_', character == '-':
		default:
			return false
		}
	}
	return true
}

func readBoundedFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = file.Close()
	}()
	document, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(document)) > limit {
		return nil, errors.New("持久会话登记文件过大或无法读取")
	}
	return document, nil
}

func (hostTmuxProbe) Probe(ctx context.Context, socket string) (SessionSnapshot, error) {
	if strings.TrimSpace(socket) == "" {
		return SessionSnapshot{}, errors.New("持久会话 socket 为空")
	}
	command, err := lookTmux()
	if err != nil {
		return SessionSnapshot{}, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	process := exec.CommandContext(
		probeCtx,
		command,
		"-u",
		"-L",
		socket,
		"list-sessions",
		"-F",
		"#{session_name}",
	)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	process.Stdout = &stdout
	process.Stderr = &stderr
	runErr := process.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return SessionSnapshot{}, ctxErr
	}
	if probeCtxErr := probeCtx.Err(); probeCtxErr != nil {
		return SessionSnapshot{}, probeCtxErr
	}
	if stdout.Len() > maxProbeOutputBytes || stderr.Len() > maxProbeOutputBytes {
		return SessionSnapshot{}, errors.New("tmux 会话探测输出过大")
	}
	if runErr == nil {
		return SessionSnapshot{ServerAlive: true, Sessions: parseSessionNames(stdout.String())}, nil
	}
	var exitError *exec.ExitError
	if errors.As(runErr, &exitError) {
		output := strings.ToLower(stderr.String() + "\n" + stdout.String())
		if strings.Contains(output, "no server running") {
			return SessionSnapshot{ServerAlive: false}, nil
		}
		return SessionSnapshot{}, fmt.Errorf("tmux 会话探测失败: %s", strings.TrimSpace(stderr.String()))
	}
	return SessionSnapshot{}, runErr
}

func lookTmux() (string, error) {
	candidates := []string{"tmux"}
	if runtime.GOOS == "windows" {
		candidates = []string{
			"psmux",
			"tmux",
			`C:\msys64\usr\bin\tmux.exe`,
			`C:\cygwin64\bin\tmux.exe`,
		}
	}
	for _, candidate := range candidates {
		command, err := exec.LookPath(candidate)
		if err == nil && command != "" {
			return command, nil
		}
	}
	return "", errors.New("未找到可探测持久会话的 tmux 引擎")
}

// parseSessionNames 只取会话名；list-sessions 的其余字段本流程不需要。
func parseSessionNames(stdout string) []string {
	names := make([]string, 0, 8)
	for _, line := range strings.Split(stdout, "\n") {
		name := strings.TrimSpace(line)
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names
}
