// Package persistentsessionguard 在账号删除前验证 Node 运行时登记的精确 tmux 所有权。
package persistentsessionguard

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
	registryRelativePath = "run/persistent-sessions"
	probeTimeout         = 1500 * time.Millisecond
	maxRegistryFileBytes = 64 * 1024
	maxProbeOutputBytes  = 1024 * 1024
)

var (
	// ErrInvalidGuardOptions 表示运行时删除保护缺少有效 AIH_HOME。
	ErrInvalidGuardOptions = errors.New("持久会话删除保护配置无效")
)

// Guard 只读取持久会话寻址登记，并探测登记指向的精确 tmux 会话。
type Guard struct {
	registryDir string
	runner      sessionCommandRunner
}

type registryEntry struct {
	Provider     string `json:"provider"`
	RuntimeScope string `json:"runtimeScope"`
	Gateway      bool   `json:"gateway"`
	AccountRef   string `json:"accountRef"`
	Socket       string `json:"socket"`
	Session      string `json:"session"`
	filePath     string
}

type commandResult struct {
	exitCode int
	stdout   string
	stderr   string
}

type sessionCommandRunner interface {
	LookPath(file string) (string, error)
	Run(
		ctx context.Context,
		command string,
		arguments ...string,
	) (commandResult, error)
}

type osSessionCommandRunner struct{}

// New 创建生产持久会话删除保护；构造过程不访问文件或执行外部命令。
func New(aiHomeDir string) (*Guard, error) {
	normalizedHome := strings.TrimSpace(aiHomeDir)
	if normalizedHome == "" || normalizedHome != aiHomeDir {
		return nil, ErrInvalidGuardOptions
	}
	return newGuard(normalizedHome, osSessionCommandRunner{}), nil
}

func newGuard(aiHomeDir string, runner sessionCommandRunner) *Guard {
	return &Guard{
		registryDir: filepath.Join(aiHomeDir, filepath.FromSlash(registryRelativePath)),
		runner:      runner,
	}
}

// AssertAccountDeletable 在任何账号写入前确认精确会话均已退出。
func (guard *Guard) AssertAccountDeletable(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if guard == nil || guard.runner == nil || ctx == nil || !accountRef.IsValid() {
		return accountapp.ErrInvalidDeletionRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := guard.loadRegistryEntries()
	if err != nil {
		return runtimeUnverifiable(err)
	}
	matching := make([]registryEntry, 0)
	for _, entry := range entries {
		if !entry.Gateway && entry.AccountRef == accountRef.String() {
			matching = append(matching, entry)
		}
	}
	if len(matching) == 0 {
		return nil
	}

	engine, err := guard.resolveEngine()
	if err != nil {
		return runtimeUnverifiable(err)
	}
	probes := make(map[string]map[string]struct{})
	absentSockets := make(map[string]struct{})
	for _, entry := range matching {
		if _, found := probes[entry.Socket]; found {
			continue
		}
		if _, found := absentSockets[entry.Socket]; found {
			continue
		}
		alive, absent, probeErr := guard.probeSocket(ctx, engine, entry.Socket)
		if probeErr != nil {
			return probeErr
		}
		if absent {
			absentSockets[entry.Socket] = struct{}{}
			continue
		}
		probes[entry.Socket] = alive
	}

	stalePaths := make([]string, 0, len(matching))
	for _, entry := range matching {
		alive := probes[entry.Socket]
		if _, exists := alive[entry.Session]; exists {
			return fmt.Errorf("%w: persistent_session", accountapp.ErrAccountRuntimeActive)
		}
		stalePaths = append(stalePaths, entry.filePath)
	}
	for _, stalePath := range stalePaths {
		if err := os.Remove(stalePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return runtimeUnverifiable(err)
		}
	}
	return nil
}

func (guard *Guard) loadRegistryEntries() ([]registryEntry, error) {
	files, err := os.ReadDir(guard.registryDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries := make([]registryEntry, 0, len(files))
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
		filePath := filepath.Join(guard.registryDir, name)
		document, err := readBoundedFile(filePath, maxRegistryFileBytes)
		if err != nil {
			return nil, err
		}
		var entry registryEntry
		if err := json.Unmarshal(document, &entry); err != nil ||
			!validRegistryEntry(entry, name) {
			return nil, errors.New("持久会话登记内容无效")
		}
		entry.filePath = filePath
		entries = append(entries, entry)
	}
	return entries, nil
}

func validRegistryEntry(entry registryEntry, fileName string) bool {
	if !safeKeyPart(entry.Provider) ||
		!safeKeyPart(entry.Socket) ||
		!safeKeyPart(entry.Session) ||
		fileName != entry.Socket+"--"+entry.Session+".json" {
		return false
	}
	if entry.Gateway {
		return entry.AccountRef == "" &&
			entry.RuntimeScope == "gateway" &&
			entry.Socket == "aih-"+entry.Provider+"-gateway"
	}
	accountRef, err := accountcore.ParseAccountRef(entry.AccountRef)
	return err == nil &&
		entry.RuntimeScope == accountRef.String() &&
		entry.Socket == "aih-"+entry.Provider+"-"+accountRef.String()
}

func safeKeyPart(value string) bool {
	if value == "" || len(value) > 512 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
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

func (guard *Guard) resolveEngine() (string, error) {
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
		command, err := guard.runner.LookPath(candidate)
		if err == nil && command != "" {
			return command, nil
		}
	}
	return "", errors.New("未找到可验证持久会话的 tmux 引擎")
}

func (guard *Guard) probeSocket(
	ctx context.Context,
	engine string,
	socket string,
) (map[string]struct{}, bool, error) {
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	result, err := guard.runner.Run(
		probeCtx,
		engine,
		"-u",
		"-L",
		socket,
		"list-sessions",
		"-F",
		"#{session_name}",
	)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, false, ctxErr
		}
		return nil, false, runtimeUnverifiable(err)
	}
	if result.exitCode != 0 {
		if strings.Contains(strings.ToLower(result.stderr), "no server running") {
			return nil, true, nil
		}
		return nil, false, runtimeUnverifiable(errors.New("tmux 会话探测失败"))
	}
	alive := make(map[string]struct{})
	for _, line := range strings.Split(result.stdout, "\n") {
		session := strings.TrimSpace(line)
		if session == "" {
			continue
		}
		if !safeKeyPart(session) {
			return nil, false, runtimeUnverifiable(errors.New("tmux 返回无效会话身份"))
		}
		alive[session] = struct{}{}
	}
	return alive, false, nil
}

func runtimeUnverifiable(err error) error {
	return fmt.Errorf("%w: %v", accountapp.ErrAccountRuntimeUnverifiable, err)
}

func (osSessionCommandRunner) LookPath(file string) (string, error) {
	return exec.LookPath(file)
}

func (osSessionCommandRunner) Run(
	ctx context.Context,
	command string,
	arguments ...string,
) (commandResult, error) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	process := exec.CommandContext(ctx, command, arguments...)
	process.Stdout = &stdout
	process.Stderr = &stderr
	err := process.Run()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return commandResult{}, ctxErr
	}
	if stdout.Len() > maxProbeOutputBytes || stderr.Len() > maxProbeOutputBytes {
		return commandResult{}, errors.New("tmux 会话探测输出过大")
	}
	result := commandResult{
		exitCode: 0,
		stdout:   stdout.String(),
		stderr:   stderr.String(),
	}
	if err == nil {
		return result, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		result.exitCode = exitError.ExitCode()
		return result, nil
	}
	return commandResult{}, err
}

var _ accountapp.DeletionGuard = (*Guard)(nil)
