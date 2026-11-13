// Package agystorage 是 Antigravity（agy）的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 agy 条目与
// launch-profile/agy-strategy.js：
//   - HOME 就是账号沙箱（agy 把 OAuth 写死在 $HOME/.gemini/antigravity-cli）；
//   - XDG/AppData/设置指针重指到宿主上的 Provider 运行 home；
//   - 会话与知识类条目（brain/conversations/...）仍与宿主共享，凭据文件保持私有。
package agystorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderID 是 Antigravity 的规范 Provider ID。
const ProviderID = "agy"

// runtimeHomeSegments 是宿主上的 Provider 运行 home（XDG/设置指针的落点）。
var runtimeHomeSegments = []string{".gemini", "antigravity-cli", ".aih-runtime-home"}

// runtimeHomeTarget 返回「宿主运行 home 下再加一段路径」的映射目标。
func runtimeHomeTarget(segments ...string) []string {
	return append(append([]string{}, runtimeHomeSegments...), segments...)
}

// sharedNames 是与会话/知识相关的共享条目（与 Node 的 sharedEntries 同序）。
var sharedNames = []string{
	"brain", "conversations", "knowledge", "scratch", "implicit",
	"builtin", "cache", "log", "bin", "updater",
}

// Policy 返回 Antigravity 的投影策略。
func Policy() accountprojection.Policy {
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeFakeHome,
		NativeRoot:      []string{".gemini", "antigravity-cli"},
		RuntimeHomeRoot: runtimeHomeTarget(),
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "oauthToken",
				Path:   []string{".gemini", "antigravity-cli", "antigravity-oauth-token"},
				Format: accountprojection.FormatJSON,
			},
			{
				Field:    "email",
				Path:     []string{".gemini", "antigravity-cli", "email.cache"},
				Format:   accountprojection.FormatText,
				Optional: true,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: []string{"Library", "Keychains"}},
		},
		// 只保留启动必需的两条映射：agy 的会话/知识库在 .gemini/antigravity-cli 下
		// （与宿主共享），其余 $HOME 子项落到 Provider 运行 home 的 home/ 命名空间。
		// Node 还给 Library/.local/.cache/.config 建了同样的映射；这些在账号沙箱里
		// 首次启动会自然生成，不需要为了共享把宿主目录整个链进来。
		ProjectionRoots: []accountprojection.Mapping{
			{From: []string{".gemini", "antigravity-cli"}, To: []string{".gemini", "antigravity-cli"}},
			{From: []string{}, To: runtimeHomeTarget("home")},
		},
		SharedEntries:         append([]string{}, sharedNames...),
		SessionEntries:        []string{"brain", "conversations"},
		PrecreatedDirectories: append([]string{}, sharedNames...),
		// XDG/设置指针落在宿主上的 Provider 运行 home；EnvBaseHostHome + 完整路径
		// 才能带上 .aih-runtime-home（HostNativeRoot 只到 ~/.gemini/antigravity-cli）。
		Env: []accountprojection.EnvBinding{
			{Key: "HOME", Base: accountprojection.EnvBaseProjectionRoot},
			{Key: "USERPROFILE", Base: accountprojection.EnvBaseProjectionRoot},
			{Key: "XDG_CONFIG_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "config")},
			{Key: "XDG_DATA_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "data")},
			{Key: "XDG_STATE_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "state")},
			{Key: "XDG_CACHE_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "cache")},
			{Key: "GEMINI_CLI_SYSTEM_SETTINGS_PATH", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget(".gemini", "settings.json")},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}
