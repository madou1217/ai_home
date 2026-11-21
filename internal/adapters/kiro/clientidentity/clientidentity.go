// Package clientidentity 提供 kiro 上游要求的客户端标识。
//
// 2026-11-13 在 AWS 服务器上用真实账号实测（5 个 Builder ID / 社交登录账号）：
//   - 不带 Kiro 版本的请求会被上游拒绝：Go 默认 UA 回 403，aws-sdk-js UA 回
//     400 UnsupportedClientVersionException；
//   - 同一 token、同一请求体，只补上 Kiro 版本就回 200，响应是正常的 AWS
//     event-stream。
//
// 上游只校验「请求里带 Kiro 版本」这一件事（0.5.0–2.5.0 实测都放行），因此
// 版本取自本机真实安装的 kiro-cli，不写死常量：写死的版本会随官方升级而过时，
// 反而成为一处可区分的非官方指纹。探测不到时不下发该头，让上游自己报错，
// 而不是自报一个假版本。
package clientidentity

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

const (
	// envBinary 允许显式指定 kiro-cli 路径。
	envBinary = "AIH_KIRO_BINARY"
	// probeInterval 是本机 CLI 重新探测间隔（CLI 会自动升级）。
	probeInterval = time.Hour
	// probeTimeout 限制单次 `kiro-cli --version`。
	probeTimeout = 3 * time.Second
)

var versionPattern = regexp.MustCompile(`[0-9]+[.][0-9]+[.][0-9]+`)

var cache struct {
	sync.Mutex
	version   string
	probedAt  time.Time
	attempted bool
}

// UserAgent 返回推理与模型发现共用的客户端标识；拿不到版本时返回空串
// （调用方据此不下发该头）。
func UserAgent() string {
	version := Detect()
	if version == "" {
		return ""
	}
	return "Kiro/" + version
}

// Detect 返回本机 kiro-cli 自报的版本；探测不到返回空串。
func Detect() string {
	cache.Lock()
	defer cache.Unlock()
	if cache.attempted && time.Since(cache.probedAt) < probeInterval {
		return cache.version
	}
	cache.version = detect()
	cache.probedAt = time.Now()
	cache.attempted = true
	return cache.version
}

// detect 按「显式路径 > PATH > 常见安装位置」探测版本。
func detect() string {
	for _, command := range probeCommands() {
		output, err := exec.Command(command, "--version").Output()
		if err != nil {
			continue
		}
		if version := versionPattern.FindString(string(output)); version != "" {
			return version
		}
	}
	return ""
}

// probeCommands 列出本机可能的 kiro-cli 位置。
func probeCommands() []string {
	commands := make([]string, 0, 6)
	if explicit := strings.TrimSpace(os.Getenv(envBinary)); explicit != "" {
		commands = append(commands, explicit)
	}
	commands = append(commands, "kiro-cli")
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home != "" {
		commands = append(commands,
			filepath.Join(home, ".local", "bin", "kiro-cli"),
			filepath.Join(home, providerroot.ConfigDir("kiro"), "bin", "kiro-cli"),
		)
	}
	return commands
}
