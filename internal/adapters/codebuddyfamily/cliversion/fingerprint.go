package cliversion

import "runtime"

// TransportProfile 是官方 CLI 在 HTTP 层自报的 SDK/运行时画像。
//
// 这些值不是随便编的：2026-11-27 在本机 CodeBuddy CLI 2.187.0 上抓官方请求
// 得到 x-stainless-package-version=7.39.0、x-stainless-runtime-version=v26.3.0。
// 它们会随官方升级变化，所以必须按**当前观测到的 CLI 版本**取；未知版本只发
// 稳定字段（arch/os/lang/runtime），不猜包版本，避免发出一个会过期的假身份。
type TransportProfile struct {
	Arch             string
	OS               string
	Lang             string
	Runtime          string
	RuntimeVersion   string
	StainlessVersion string
}

// Transport 返回当前 CLI 版本对应的传输层画像。
func Transport(version string) TransportProfile {
	profile := TransportProfile{
		Arch:    stainlessArch(),
		OS:      stainlessOS(),
		Lang:    "js",
		Runtime: "node",
	}
	switch version {
	case "2.187.0":
		profile.RuntimeVersion = "v26.3.0"
		profile.StainlessVersion = "7.39.0"
	}
	return profile
}

func stainlessArch() string {
	switch runtime.GOARCH {
	case "arm64":
		return "arm64"
	case "amd64":
		return "x64"
	case "386":
		return "x86"
	default:
		return "other"
	}
}

func stainlessOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "MacOS"
	case "linux":
		return "Linux"
	case "windows":
		return "Windows"
	default:
		return "other"
	}
}
