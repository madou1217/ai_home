// Package agystorage 是 Antigravity（agy）的账号投影策略与凭据物化适配器。
//
// 策略对齐 Node lib/runtime/provider-storage-policy.js 的 agy 条目与
// launch-profile/agy-strategy.js：
//   - HOME 就是账号沙箱（agy 把 OAuth 写死在 $HOME/.gemini/antigravity-cli）；
//   - XDG/AppData/设置指针重指到宿主上的 Provider 运行 home；
//   - 会话与知识类条目（brain/conversations/...）仍与宿主共享，凭据文件保持私有。
package agystorage

import (
	"github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

// ProviderID 是 Antigravity 的规范 Provider ID。
const ProviderID = "agy"

// runtimeHomeTarget 返回「宿主运行 home 下再加一段路径」的映射目标。
func runtimeHomeTarget(segments ...string) []string {
	return append(providerroot.RuntimeHome(ProviderID), segments...)
}

// sharedNames 是与会话/知识相关的共享条目（与 Node 的 sharedEntries 同序）。
var sharedNames = []string{
	"brain", "conversations", "knowledge", "scratch", "implicit",
	"builtin", "cache", "log", "bin", "updater",
}

// Policy 返回 Antigravity 的投影策略。
func Policy() accountprojection.Policy {
	root := providerroot.NativeRoot(ProviderID)
	return accountprojection.Policy{
		Provider:        ProviderID,
		Mode:            accountprojection.ModeFakeHome,
		NativeRoot:      root,
		RuntimeHomeRoot: runtimeHomeTarget(),
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "oauthToken",
				Path:   providerroot.NativePath(ProviderID, "antigravity-oauth-token"),
				Format: accountprojection.FormatJSON,
			},
			{
				Field:    "email",
				Path:     providerroot.NativePath(ProviderID, "email.cache"),
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
		// 工具链缓存（.cache/go/.npm）例外：它们与账号无关，必须链回宿主，
		// 否则 fake HOME 会让每个账号各存一份并迅速堆满磁盘。
		ProjectionRoots: []accountprojection.Mapping{
			{From: append([]string{}, root...), To: append([]string{}, root...)},
			{From: []string{}, To: runtimeHomeTarget("home")},
		},
		SharedEntries:         append([]string{}, sharedNames...),
		SessionEntries:        []string{"brain", "conversations"},
		PrecreatedDirectories: append([]string{}, sharedNames...),
		// 工具链缓存与账号无关，必须链接回宿主；fake HOME 下每个账号各存一份
		// 会迅速堆满磁盘（2026-11-26 实测：单个 agy 账号 .cache/go-build 4.7G、
		// .npm 635M、go/pkg 621M）。与 CodeBuddy 家族的 HOST_TOOLCHAIN_CACHES 同口径。
		SharedHostCaches: []accountprojection.SharedLink{
			{Projection: []string{".cache"}, Host: []string{".cache"}},
			{Projection: []string{"go"}, Host: []string{"go"}},
			{Projection: []string{".npm"}, Host: []string{".npm"}},
			{
				Projection: []string{"Library", "Caches", "go-build"},
				Host:       []string{"Library", "Caches", "go-build"},
				Platforms:  []string{"darwin"},
			},
		},
		// XDG/设置指针落在宿主上的 Provider 运行 home；EnvBaseHostHome + 完整路径
		// 才能带上 .aih-runtime-home（HostNativeRoot 只到 ~/.gemini/antigravity-cli）。
		Env: []accountprojection.EnvBinding{
			{Key: "HOME", Base: accountprojection.EnvBaseProjectionRoot},
			{Key: "USERPROFILE", Base: accountprojection.EnvBaseProjectionRoot},
			{Key: "XDG_CONFIG_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "config")},
			{Key: "XDG_DATA_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "data")},
			{Key: "XDG_STATE_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "state")},
			{Key: "XDG_CACHE_HOME", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget("xdg", "cache")},
			// 链接之外的兜底：已启动的会话不会重新建链，但子进程继承这里的
			// 缓存路径，Windows 等默认位置不在 fake HOME 下的平台也能共享宿主缓存。
			{Key: "GOCACHE", Base: accountprojection.EnvBaseHostHome, Path: []string{".cache", "go-build"}},
			{Key: "GOMODCACHE", Base: accountprojection.EnvBaseHostHome, Path: []string{"go", "pkg", "mod"}},
			{Key: "GOPATH", Base: accountprojection.EnvBaseHostHome, Path: []string{"go"}},
			{Key: "npm_config_cache", Base: accountprojection.EnvBaseHostHome, Path: []string{".npm"}},
			{Key: "GEMINI_CLI_SYSTEM_SETTINGS_PATH", Base: accountprojection.EnvBaseHostHome, Path: runtimeHomeTarget(providerroot.ConfigPath(ProviderID, "settings.json")...)},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}
}
