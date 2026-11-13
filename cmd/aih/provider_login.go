package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/host/aihlogin"
	"github.com/madou1217/ai_home/internal/host/clilogin"
)

// runProviderLogin 执行原生 CLI 登录。
//
// 家族四支走临时 fake-home 投影；已迁移的非家族 CLI（agy）走通用 CLI 登录。
// 只支持裸 login（不带额外参数）；未迁移的 Provider 明确拒绝，不静默交给 Node。
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
		if argument == "--no-browser" {
			// 登录进程本来就用 BROWSER 捕获脚本，不打开宿主浏览器；接受该旗标
			// 以保证 Node 旧用法原样可用。
			continue
		}
		if strings.TrimSpace(argument) != "" {
			writeProviderLoginUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: login 不接受参数", errInvalidCommand)
		}
	}
	family := codebuddyfamilystorage.IsFamilyProvider(providerID)
	if !family && !clilogin.Supported(providerID) {
		return fmt.Errorf("%w: %s 的 CLI 登录尚未迁移到 Go", errInvalidCommand, providerID)
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
	var account accountcore.Account
	if family {
		account, err = aihlogin.Run(ctx, aihlogin.Options{
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
			ProviderID:  providerID,
			Stdin:       runtime.stdin,
			Stdout:      runtime.stdout,
			Stderr:      runtime.stderr,
		})
	} else {
		account, err = clilogin.Run(ctx, clilogin.Options{
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
			ProviderID:  providerID,
			Stdin:       runtime.stdin,
			Stdout:      runtime.stdout,
			Stderr:      runtime.stderr,
		})
	}
	if err != nil {
		if errors.Is(err, aihlogin.ErrCredentialMissing) {
			return fmt.Errorf(
				"%w（CodeBuddy 浏览器登录结果不会回传 CLI；可运行 aih %s detect 导入本机已登录账号）",
				err,
				providerID,
			)
		}
		if errors.Is(err, clilogin.ErrCredentialMissing) {
			return fmt.Errorf(
				"%w（浏览器授权完成后 CLI 应写出凭据文件；可运行 aih %s ls 确认账号是否入库）",
				err,
				providerID,
			)
		}
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "登录完成: %s #%d (%s)\n",
		account.ProviderID(), account.CLIAccountID().Int64(), account.Ref())
	return nil
}

func writeProviderLoginUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "用法:\n  aih %s login\n", providerID)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  用一次性运行目录启动官方 CLI 登录；退出后把凭据注册成账号。")
}
