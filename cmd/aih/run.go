package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihcli"
)

const defaultGatewayBaseURL = "http://127.0.0.1:9527"

var errInvalidCommand = errors.New("aih 命令无效")

// providerApplication 是命令入口依赖的最小 Host 端口。
type providerApplication interface {
	Run(
		ctx context.Context,
		providerID string,
		arguments []string,
		gateway aihcli.GatewayConfig,
	) error
	Close() error
}

// commandRuntime 隔离环境、用户目录、终端 I/O 和 Composition Root 创建。
type commandRuntime struct {
	lookupEnv   func(string) (string, bool)
	userHomeDir func() (string, error)
	stdin       io.Reader
	stdout      io.Writer
	stderr      io.Writer
	newApp      func(context.Context, aihcli.Options) (providerApplication, error)
}

// defaultCommandRuntime 绑定真实操作系统环境和 Go Composition Root。
func defaultCommandRuntime() commandRuntime {
	return commandRuntime{
		lookupEnv:   os.LookupEnv,
		userHomeDir: os.UserHomeDir,
		stdin:       os.Stdin,
		stdout:      os.Stdout,
		stderr:      os.Stderr,
		newApp: func(ctx context.Context, options aihcli.Options) (providerApplication, error) {
			return aihcli.New(ctx, options)
		},
	}
}

// run 只解析 aih 根命令；Provider 参数由官方 CLI 和双模式意图解析器处理。
func run(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if ctx == nil || runtime.lookupEnv == nil || runtime.userHomeDir == nil ||
		runtime.stdin == nil || runtime.stdout == nil || runtime.stderr == nil || runtime.newApp == nil {
		return errInvalidCommand
	}
	if len(arguments) == 0 || isRootHelp(arguments[0]) {
		writeUsage(runtime.stdout)
		return nil
	}
	providerID := arguments[0]
	if providerID == "help" {
		writeUsage(runtime.stdout)
		return nil
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	app, err := runtime.newApp(ctx, aihcli.Options{
		AIHomeDir: aiHomeDir,
		Stdin:     runtime.stdin,
		Stdout:    runtime.stdout,
		Stderr:    runtime.stderr,
	})
	if err != nil {
		return fmt.Errorf("初始化 Go CLI 失败: %w", err)
	}
	gateway := aihcli.GatewayConfig{
		BaseURL:   lookupOrDefault(runtime.lookupEnv, "AIH_SERVER_BASE_URL", defaultGatewayBaseURL),
		ClientKey: lookupOrDefault(runtime.lookupEnv, "AIH_SERVER_CLIENT_KEY", ""),
	}
	runErr := app.Run(ctx, providerID, arguments[1:], gateway)
	closeErr := app.Close()
	return errors.Join(runErr, closeErr)
}

// resolveAIHomeDir 复用全局 AIH_HOME；不创建任何 Provider 或账号级 HOME。
func resolveAIHomeDir(runtime commandRuntime) (string, error) {
	value, found := runtime.lookupEnv("AIH_HOME")
	if !found || strings.TrimSpace(value) == "" {
		userHome, err := runtime.userHomeDir()
		if err != nil || strings.TrimSpace(userHome) == "" {
			return "", errInvalidCommand
		}
		value = filepath.Join(userHome, ".ai_home")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", errInvalidCommand
	}
	return absolute, nil
}

// lookupOrDefault 保留敏感环境原值，让下层严格校验空白和控制字符。
func lookupOrDefault(
	lookupEnv func(string) (string, bool),
	name string,
	fallback string,
) string {
	value, found := lookupEnv(name)
	if !found {
		return fallback
	}
	return value
}

// isRootHelp 只识别 aih 根帮助，不吞掉 Provider 自身的 --help。
func isRootHelp(argument string) bool {
	return argument == "-h" || argument == "--help"
}

// writeUsage 说明当前已实现的双模式命令和共享状态约束。
func writeUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> [provider_args...]                  # Gateway 账号池")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> relay [account_id] [provider_args...] # Gateway 同 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih <client> relay <provider> <account_id> [provider_args...] # Gateway 跨 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> <account_id> [provider_args...]       # Native Direct")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih codex relay claude 9 --model claude-opus-5")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "共享状态:")
	_, _ = fmt.Fprintln(output, "  Codex 继承官方 CODEX_HOME；Claude 继承官方 CLAUDE_CONFIG_DIR。")
	_, _ = fmt.Fprintln(output, "  AIH 不创建 Provider 或账号级 HOME，会话、信任和插件配置保持共享。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_HOME")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL（默认 http://127.0.0.1:9527）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_CLIENT_KEY（仅 Gateway 模式必需）")
	_, _ = fmt.Fprintln(output, "  AIH_CODEX_BINARY / AIH_CLAUDE_BINARY（可选官方 CLI 路径）")
}
