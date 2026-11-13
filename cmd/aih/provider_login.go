package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihlogin"
)

// runProviderLogin 执行 CodeBuddy / WorkBuddy 家族的原生 CLI 登录。
//
// 只支持裸 login（不带额外参数）；其它登录子选项仍交回 Node。
func runProviderLogin(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	for _, argument := range arguments {
		if isRootHelp(argument) {
			writeProviderLoginUsage(runtime.stdout, providerID)
			return nil
		}
		if strings.TrimSpace(argument) != "" {
			writeProviderLoginUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: login 不接受参数", errInvalidCommand)
		}
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	hostHomeDir := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHomeDir == "" {
		hostHomeDir, err = runtime.userHomeDir()
		if err != nil {
			return err
		}
	}
	account, err := aihlogin.Run(ctx, aihlogin.Options{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		ProviderID:  providerID,
		Stdin:       runtime.stdin,
		Stdout:      runtime.stdout,
		Stderr:      runtime.stderr,
	})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "登录完成: %s #%d (%s)\n",
		account.ProviderID(), account.CLIAccountID().Int64(), account.Ref())
	return nil
}

func writeProviderLoginUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "用法:\n  aih %s login\n", providerID)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  用临时 fake-home 投影启动官方 codebuddy 登录；退出后注册 .info 账号。")
}
