package main

// launchProviders 是 aih 直接拉起的 provider 家族。
//
// 这是「裸启动 aih <provider>」的判定表：裸启动的语义是网关账号池或默认账号，
// 与是否支持动作命令无关。显式命令（ls / login / delete …）由 run() 的分派表
// 逐个承接，不在这里开名单。
var launchProviders = map[string]bool{
	"codex":       true,
	"claude":      true,
	"codebuddy":   true,
	"codebuddycn": true,
	"workbuddy":   true,
	"workbuddycn": true,
	"gemini":      true,
	"qoder":       true,
	"qodercn":     true,
	"zcode":       true,
	"cline":       true,
	"kiro":        true,
	"agy":         true,
	"opencode":    true,
	"grok":        true,
	"kimi":        true,
}
