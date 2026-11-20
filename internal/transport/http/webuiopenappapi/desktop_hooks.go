package webuiopenappapi

import (
	"context"
	"strings"
	"time"
)

// desktopProviderHooks 声明一个 Provider 在桌面启动生命周期里的钩子。
//
// 之前 prepareSession / prepareProfile / prepareResolvedLaunch / afterClose 各自
// 维护一份 Provider switch；新增 Provider 要在四处分别判断。这里把四类钩子收进
// 一张表，未登记的 Provider 全部走「无额外动作」。
type desktopProviderHooks struct {
	prepareSession        func(*desktopPrepContext) *Result
	prepareProfile        func(*desktopPrepContext) *Result
	prepareResolvedLaunch func(*desktopPrepContext) *Result
	afterClose            func(context.Context, NativeLauncherDependencies, Request, AccountSnapshot, string, time.Time)
}

var desktopProviderHookTable = map[string]desktopProviderHooks{
	"kimi": {
		prepareSession: (*desktopPrepContext).prepareKimiSession,
	},
	"codex": {
		prepareProfile: (*desktopPrepContext).prepareCodexProfile,
		afterClose:     afterCloseCodexDesktop,
	},
	"claude": {
		prepareProfile: (*desktopPrepContext).prepareClaudeProfile,
	},
	"zcode": {
		prepareProfile:        (*desktopPrepContext).prepareZcodeProfile,
		prepareResolvedLaunch: (*desktopPrepContext).prepareZcodeResolvedLaunch,
		afterClose:            afterCloseZcodeDesktop,
	},
	"codebuddy": {
		prepareProfile:        (*desktopPrepContext).prepareCodebuddyKeychain,
		prepareResolvedLaunch: (*desktopPrepContext).prepareCodebuddyResolvedLaunch,
	},
	"codebuddycn": {
		prepareProfile:        (*desktopPrepContext).prepareCodebuddyKeychain,
		prepareResolvedLaunch: (*desktopPrepContext).prepareCodebuddyResolvedLaunch,
	},
	"workbuddy": {
		prepareProfile: (*desktopPrepContext).prepareCodebuddyKeychain,
	},
	"workbuddycn": {
		prepareProfile: (*desktopPrepContext).prepareCodebuddyKeychain,
	},
	"kiro": {
		prepareResolvedLaunch: (*desktopPrepContext).prepareKiroResolvedLaunch,
	},
}

// desktopProviderHook 返回 Provider 的桌面钩子；未登记返回零值。
func desktopProviderHook(provider string) desktopProviderHooks {
	return desktopProviderHookTable[normalizeDesktopProvider(provider)]
}

func normalizeDesktopProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// afterCloseCodexDesktop 清理 Codex 桌面账号绑定并重启受影响的 app-server。
func afterCloseCodexDesktop(
	_ context.Context,
	deps NativeLauncherDependencies,
	req Request,
	_ AccountSnapshot,
	_ string,
	_ time.Time,
) {
	if deps.CodexHooks == nil {
		return
	}
	res := deps.CodexHooks.ClearDesktopAccountRef(req.AccountRef)
	if res.OK && res.Changed {
		_ = deps.CodexHooks.RestartRunningAppServers()
	}
}

// afterCloseZcodeDesktop 回读投影里的最新凭据并写回数据库。
func afterCloseZcodeDesktop(
	ctx context.Context,
	deps NativeLauncherDependencies,
	_ Request,
	snapshot AccountSnapshot,
	profileDir string,
	now time.Time,
) {
	captureZcodeAuthOnClose(ctx, deps.Accounts, profileDir, snapshot, now)
}
