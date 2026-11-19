package completion

import (
	"io"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Environment 隔离进程环境、终端 I/O 与时钟，便于真实入口与测试复用。
type Environment struct {
	Getenv      func(string) string
	UserHomeDir func() (string, error)
	Stdin       io.Reader
	StdinIsTTY  bool
	Stdout      io.Writer
	Stderr      io.Writer
	Now         func() time.Time
}

func (environment Environment) env(name string) string {
	if environment.Getenv == nil {
		return ""
	}
	return environment.Getenv(name)
}

func (environment Environment) now() time.Time {
	if environment.Now == nil {
		return time.Now()
	}
	return environment.Now()
}

func (environment Environment) stdout() io.Writer {
	if environment.Stdout == nil {
		return io.Discard
	}
	return environment.Stdout
}

func (environment Environment) stderr() io.Writer {
	if environment.Stderr == nil {
		return io.Discard
	}
	return environment.Stderr
}

func (environment Environment) userHome() string {
	if environment.UserHomeDir != nil {
		if value, err := environment.UserHomeDir(); err == nil && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	if value, err := os.UserHomeDir(); err == nil && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	// HOME 缺失时仍要和 Node 的 os.userInfo().homedir 一样退回 passwd 家目录，
	// 否则补全会去相对路径 `.ai_home` 找数据库而静默没有候选。
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.HomeDir) != "" {
		return strings.TrimSpace(current.HomeDir)
	}
	return ""
}

func (environment Environment) cwd() string {
	value, err := os.Getwd()
	if err != nil {
		return ""
	}
	return value
}

// hostHomeDir 对齐 Node runtime/host-home.resolveHostHomeDir：
// AIH_HOST_HOME → (Windows USERPROFILE / HOMEDRIVE+HOMEPATH) → HOME → 用户家目录。
func (environment Environment) hostHomeDir() string {
	if value := strings.TrimSpace(environment.env("AIH_HOST_HOME")); value != "" {
		return normalizeHostHome(value)
	}
	if runtime.GOOS == "windows" {
		if value := strings.TrimSpace(environment.env("USERPROFILE")); value != "" {
			return normalizeHostHome(value)
		}
		drive := strings.TrimSpace(environment.env("HOMEDRIVE"))
		rest := strings.TrimSpace(environment.env("HOMEPATH"))
		if drive != "" && rest != "" {
			return normalizeHostHome(filepath.Join(drive, rest))
		}
	}
	if value := strings.TrimSpace(environment.env("HOME")); value != "" {
		return normalizeHostHome(value)
	}
	return normalizeHostHome(environment.userHome())
}

// unprojectedHostHomeDir 对齐 Node resolveUnprojectedHostHomeDir：跳过账号投影 HOME。
func (environment Environment) unprojectedHostHomeDir() string {
	if value := strings.TrimSpace(environment.env("AIH_HOST_HOME")); value != "" {
		return normalizeHostHome(value)
	}
	home := strings.TrimSpace(environment.env("HOME"))
	if home == "" {
		home = strings.TrimSpace(environment.env("USERPROFILE"))
	}
	if home != "" && !looksProjectedHome(home) {
		return normalizeHostHome(home)
	}
	if value := environment.userHome(); value != "" {
		return normalizeHostHome(value)
	}
	return normalizeHostHome(home)
}

// aiHomeDir 对齐 Node runtime/aih-home.resolveAiHomeDir：
// AIH_HOME_DIR → AI_HOME → <宿主 home>/.ai_home。
func (environment Environment) aiHomeDir() string {
	explicit := strings.TrimSpace(environment.env("AIH_HOME_DIR"))
	if explicit == "" {
		explicit = strings.TrimSpace(environment.env("AI_HOME"))
	}
	if explicit != "" {
		return explicit
	}
	return filepath.Join(environment.hostHomeDir(), ".ai_home")
}

// hostAIHomeDir 是「宿主那份 ai_home」：没有显式环境变量时使用非投影宿主家目录。
func (environment Environment) hostAIHomeDir() string {
	explicit := strings.TrimSpace(environment.env("AIH_HOME_DIR"))
	if explicit == "" {
		explicit = strings.TrimSpace(environment.env("AI_HOME"))
	}
	if explicit != "" {
		return explicit
	}
	return filepath.Join(environment.unprojectedHostHomeDir(), ".ai_home")
}

func looksProjectedHome(value string) bool {
	normalized := strings.ReplaceAll(value, "\\", "/")
	for _, marker := range []string{"/run/login/", "/run/auth-projections/"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func normalizeHostHome(value string) string {
	text := strings.TrimSpace(value)
	normalized := strings.ReplaceAll(text, "\\", "/")
	normalized = strings.TrimRight(normalized, "/")
	if strings.HasSuffix(strings.ToLower(normalized), "/.codex") {
		return normalized[:len(normalized)-len("/.codex")]
	}
	if normalized == "" {
		return text
	}
	return text
}
