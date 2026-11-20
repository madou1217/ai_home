// Package clientversion 探测 Gemini CLI 版本。
//
// 顺序：AIH_GEMINI_CLIENT_VERSION → 本机安装的 gemini CLI → 上次探测缓存 → 兜底。
// Gemini Code Assist 的 User-Agent 形如
// `GeminiCLI-cli-command/<version>/<model> (<platform>; <arch>; terminal)`，
// 版本必须随本机 CLI 自动更新，不能长期写死；探测结果落盘，重启后先复用。
package clientversion

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// envVar 是显式锁定版本（人工回退/紧急修复）的入口。
	envVar = "AIH_GEMINI_CLIENT_VERSION"
	// refreshInterval 是本机 CLI 的重新探测间隔：CLI 会自动升级。
	refreshInterval = 6 * time.Hour
	// probeTimeout 限制单次 `gemini --version`。
	probeTimeout = 3 * time.Second
)

var (
	once     sync.Once
	current  atomic.Value
	pattern  = regexp.MustCompile(`[0-9]+[.][0-9]+[.][0-9]+`)
	mu       sync.Mutex
	probing  bool
	probedAt time.Time
)

// Detect 返回当前应自报的 Gemini CLI 版本；进程内只做首次初始化。
func Detect() string {
	once.Do(func() {
		value := detectLocal()
		if value == "" {
			value = readCachedVersion()
		}
		current.Store(value)
		go refreshLoop()
	})
	if value, ok := current.Load().(string); ok {
		return value
	}
	// 观测不到版本时返回空串：调用方不下发版本头，而不是自报写死的版本。
	return ""
}

// DetectFrom 是纯函数版本：只读取显式配置与本机 CLI，便于验证。
func DetectFrom(configured string, commands []string) string {
	if value := parseVersion(configured); value != "" {
		return value
	}
	for _, command := range commands {
		if value := probe(command); value != "" {
			return value
		}
	}
	return ""
}

func detectLocal() string {
	return DetectFrom(os.Getenv(envVar), probeCommands())
}

// refreshLoop 周期性重新探测本机 CLI，CLI 升级后自动跟上。
//
// 显式锁定（AIH_GEMINI_CLIENT_VERSION）时不覆盖调用方意图。
func refreshLoop() {
	ticker := time.NewTicker(refreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		if parseVersion(os.Getenv(envVar)) != "" {
			continue
		}
		if value := detectLocal(); value != "" {
			current.Store(value)
			writeCachedVersion(value)
		}
	}
}

// probeCommands 列出本机可能安装的 Gemini CLI。
func probeCommands() []string {
	commands := make([]string, 0, 8)
	if explicit := strings.TrimSpace(os.Getenv("AIH_GEMINI_BINARY")); explicit != "" {
		commands = append(commands, explicit)
	}
	commands = append(commands, "gemini", "gemini-cli")
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home != "" {
		commands = append(commands,
			filepath.Join(home, ".local", "bin", "gemini"),
			filepath.Join(home, ".npm-global", "bin", "gemini"),
			filepath.Join(home, ".volta", "bin", "gemini"),
			filepath.Join(home, ".local", "share", "pnpm", "gemini"),
		)
	}
	return commands
}

// probe 执行 `<command> --version` 并解析版本号；失败返回空串。
func probe(command string) string {
	mu.Lock()
	if probing {
		mu.Unlock()
		return ""
	}
	probing = true
	probedAt = time.Now()
	mu.Unlock()
	defer func() {
		mu.Lock()
		probing = false
		mu.Unlock()
	}()
	timeout := probeTimeout
	done := make(chan string, 1)
	go func() {
		output, err := exec.Command(command, "--version").Output()
		if err != nil {
			done <- ""
			return
		}
		done <- parseVersion(string(output))
	}()
	select {
	case value := <-done:
		return value
	case <-time.After(timeout):
		return ""
	}
}

// parseVersion 从任意输出里取第一个 x.y.z。
func parseVersion(raw string) string {
	match := pattern.FindString(strings.TrimSpace(raw))
	return match
}

// cacheFilePath 返回上次探测结果的落盘点。
func cacheFilePath() string {
	directory, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(directory) == "" {
		return ""
	}
	return filepath.Join(directory, "aih", "gemini-client-version")
}

func readCachedVersion() string {
	path := cacheFilePath()
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return parseVersion(string(raw))
}

func writeCachedVersion(value string) {
	path := cacheFilePath()
	if path == "" || strings.TrimSpace(value) == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(path, []byte(value), 0o600)
}
