package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
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
	lookupEnv     func(string) (string, bool)
	userHomeDir   func() (string, error)
	stdin         io.Reader
	stdout        io.Writer
	stderr        io.Writer
	newApp        func(context.Context, aihcli.Options) (providerApplication, error)
	newAccountApp func(context.Context, aihaccount.Options) (accountApplication, error)
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
		newAccountApp: func(
			ctx context.Context,
			options aihaccount.Options,
		) (accountApplication, error) {
			return aihaccount.New(ctx, options)
		},
	}
}

// run 只解析 aih 根命令；Provider 参数由官方 CLI 和双模式意图解析器处理。
func run(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if ctx == nil || runtime.lookupEnv == nil || runtime.userHomeDir == nil ||
		runtime.stdin == nil || runtime.stdout == nil || runtime.stderr == nil ||
		runtime.newApp == nil || runtime.newAccountApp == nil {
		return errInvalidCommand
	}
	if len(arguments) == 0 || isRootHelp(arguments[0]) {
		writeUsage(runtime.stdout)
		return nil
	}
	providerID := arguments[0]
	if providerID == accountCommandName {
		return runAccount(ctx, arguments[1:], runtime)
	}
	if providerID == "help" {
		if len(arguments) == 2 && isCLIProvider(arguments[1]) {
			writeProviderUsage(runtime.stdout, arguments[1])
			return nil
		}
		if len(arguments) == 2 && arguments[1] == accountCommandName {
			writeAccountUsage(runtime.stdout)
			return nil
		}
		if len(arguments) != 1 {
			return errInvalidCommand
		}
		writeUsage(runtime.stdout)
		return nil
	}
	if len(arguments) == 2 && isCLIProvider(providerID) &&
		isRootHelp(arguments[1]) {
		writeProviderUsage(runtime.stdout, providerID)
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

// isCLIProvider 与当前 Go CLI 实际开放的官方客户端保持一致。
func isCLIProvider(providerID string) bool {
	return providerID == "codex" || providerID == "claude"
}

// writeUsage 说明当前已实现的双模式命令和共享状态约束。
func writeUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> [provider_args...]                  # Gateway 账号池")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> relay [account_id] [provider_args...] # Gateway 同 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih <client> relay <provider> <account_id> [provider_args...] # Gateway 跨 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> <account_id> [provider_args...]       # Native Direct")
	_, _ = fmt.Fprintln(output, "  "+accountUsageLine())
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

// writeProviderUsage 在打开数据库或连接 Server 前说明 AIH 模式边界。
func writeProviderUsage(output io.Writer, providerID string) {
	if providerID == "claude" {
		_, _ = fmt.Fprintln(output, "AIH Claude 用法:")
		_, _ = fmt.Fprintln(output, "  aih claude [claude_args...]                    # Gateway 账号池")
		_, _ = fmt.Fprintln(output, "  aih claude relay <account_id> [claude_args...] # Gateway 固定账号")
		_, _ = fmt.Fprintln(output, "  aih claude <account_id> [claude_args...]       # Native Direct")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "模式说明:")
		_, _ = fmt.Fprintln(output, "  Gateway 账号池按请求中的真实模型公平征召账号；Claude 官方客户端的 OAuth 走原生 Relay 保留客户端证明，")
		_, _ = fmt.Fprintln(output, "  其余凭据与跨协议客户端走 Canonical Adapter。")
		_, _ = fmt.Fprintln(output, "  Gateway 固定账号仍经 Server Relay，但不会失败换号。")
		_, _ = fmt.Fprintln(output, "  Native Direct 使用指定账号的原生 OAuth、API Key 或 Auth Token 直连上游。")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "示例:")
		_, _ = fmt.Fprintln(output, "  aih claude --model claude-opus-5")
		_, _ = fmt.Fprintln(output, "  aih claude relay 9 --model claude-opus-5")
		_, _ = fmt.Fprintln(output, "  aih claude 9 --model claude-opus-5")
		_, _ = fmt.Fprintln(output, "  aih codex relay claude 9 --model claude-opus-5")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "参数规则:")
		_, _ = fmt.Fprintln(output, "  AIH 模式/账号 token 必须放在前面；其后的参数原样交给官方 Claude CLI。")
		_, _ = fmt.Fprintln(output, "  查看官方 Claude CLI 参数请直接运行: claude --help")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "共享状态:")
		_, _ = fmt.Fprintln(output, "  所有模式继承同一个 CLAUDE_CONFIG_DIR；AIH 不创建账号级 HOME，会话、信任和插件配置保持共享。")
		return
	}

	_, _ = fmt.Fprintln(output, "AIH Codex 用法:")
	_, _ = fmt.Fprintln(output, "  aih codex [codex_args...]                            # Gateway 账号池")
	_, _ = fmt.Fprintln(output, "  aih codex relay <account_id> [codex_args...]         # Gateway 固定账号")
	_, _ = fmt.Fprintln(output, "  aih codex relay <provider> <account_id> [codex_args...] # Gateway 跨 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih codex <account_id> [codex_args...]               # Native Direct")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "模式说明:")
	_, _ = fmt.Fprintln(output, "  Gateway 账号池按请求中的真实模型公平征召 Codex 账号。")
	_, _ = fmt.Fprintln(output, "  Gateway 固定账号仍经 Server Relay，但不会失败换号。")
	_, _ = fmt.Fprintln(output, "  跨 Provider 固定账号让 Codex 客户端使用其他 Provider 的账号：Codex 仍发 Responses 请求，")
	_, _ = fmt.Fprintln(output, "  Server 用 Canonical Adapter 转码到目标 Provider 的线协议，模型必须是该账号可用的真实模型。")
	_, _ = fmt.Fprintln(output, "  Native Direct 使用指定账号的原生 OAuth 或 API Key 直连上游。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih codex --model gpt-5.5")
	_, _ = fmt.Fprintln(output, "  aih codex relay 1 --model gpt-5.5")
	_, _ = fmt.Fprintln(output, "  aih codex 1 --model gpt-5.5")
	_, _ = fmt.Fprintln(output, "  aih codex relay claude 9 --model claude-opus-5")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "参数规则:")
	_, _ = fmt.Fprintln(output, "  AIH 模式/账号 token 必须放在前面；其后的参数原样交给官方 Codex CLI。")
	_, _ = fmt.Fprintln(output, "  查看官方 Codex CLI 参数请直接运行: codex --help")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "共享状态:")
	_, _ = fmt.Fprintln(output, "  所有模式继承同一个 CODEX_HOME；AIH 不创建账号级 HOME，会话、信任和 MCP 配置保持共享。")
}
