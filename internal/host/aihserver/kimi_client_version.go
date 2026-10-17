package aihserver

import (
	"os/exec"
	"regexp"
	"sync"
	"time"
)

// kimi 客户端版本的动态解析（与 Node 侧 lib/server/kimi-client-version.js 同语义）。
//
// 为什么不能硬编码：`X-Msh-Version` / `User-Agent` 自报的版本是上游识别客户端代际的
// 依据。写死一个值（此前是 '0.36.0'）会让「本机 CLI 升级」与「上游按版本下发能力」
// 之间永久漂移——实测本机 CLI 已是 2.2.0，差 6 个大版本。
//
// Go 侧只做**本地探测**一档：远端 npm 查询需要网络与缓存，Node 侧已经做了（并且是
// 投影的发起方）。Go 拿不到本地 CLI 时用兜底常量——比引入一条独立的网络路径更稳。

// kimiClientVersionFallback 是本地探测失败时的兜底（与 Node 侧常量一致）。
const kimiClientVersionFallback = "0.36.0"

// kimiClientVersionCacheTTL 是本地版本的缓存时长（CLI 会自动更新）。
const kimiClientVersionCacheTTL = time.Hour

var (
	kimiVersionOnce   sync.Once
	kimiVersionCached string
)

var kimiVersionPattern = regexp.MustCompile(`(\d+\.\d+\.\d+)`)

// kimiClientVersion 返回应自报的 kimi 客户端版本。
//
// 探测一次后缓存：版本在进程生命周期内变化极小，而每次请求都起子进程不可接受。
func kimiClientVersion() string {
	kimiVersionOnce.Do(func() {
		kimiVersionCached = detectKimiClientVersion()
	})
	return kimiVersionCached
}

// detectKimiClientVersion 跑一次 `kimi --version` 并解析。
//
// 失败（没装、超时、输出认不出）返回兜底常量：「这台机器没装 CLI」是正常情况。
func detectKimiClientVersion() string {
	command := "kimi"
	output, err := exec.Command(command, "--version").Output()
	if err != nil {
		return kimiClientVersionFallback
	}
	match := kimiVersionPattern.FindString(string(output))
	if match == "" {
		return kimiClientVersionFallback
	}
	return match
}
