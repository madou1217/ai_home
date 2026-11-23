// Package sessionhints 根据 Provider 合同生成“继续此会话”的命令提示。
//
// 事实来源只有 core/providers：原生命令来自 NativeSessions.Resume 模板与
// CLIConfig.BinaryName；AIH 命令使用同一份合同的会话动词（aih <provider> resume）。
// 这里不做 Provider 名分支，也不猜测未声明会话命令的 Provider。
package sessionhints

import (
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// Continue 是会话继续命令的展示契约。
type Continue struct {
	// AIH 是经 AIH 账号/网关继续会话的命令。
	AIH string `json:"aih"`
	// Native 是 Provider 原生 CLI 继续会话的命令。
	Native string `json:"native"`
	// Note 是该 Provider 使用原生命令时的注意事项；空表示没有额外约束。
	Note string `json:"note,omitempty"`
}

var (
	catalogOnce sync.Once
	catalog     *providers.Catalog
)

func builtinCatalog() *providers.Catalog {
	catalogOnce.Do(func() {
		value, err := providers.NewCatalog(providers.BuiltinManifest())
		if err == nil {
			catalog = value
		}
	})
	return catalog
}

// For 返回继续指定会话的 AIH 与原生命令；Provider 未声明恢复能力时返回 nil。
func For(providerID, sessionID string) *Continue {
	providerID = strings.TrimSpace(providerID)
	sessionID = strings.TrimSpace(sessionID)
	cat := builtinCatalog()
	if cat == nil || providerID == "" || sessionID == "" {
		return nil
	}
	definition, ok := cat.Get(providerID)
	if !ok || definition.NativeBoundary == nil {
		return nil
	}
	resume := definition.NativeBoundary.Sessions.Resume
	if resume == nil || len(resume.WithID) == 0 {
		return nil
	}
	native := nativeArgv(definition, resume.WithID, sessionID)
	if len(native) == 0 {
		return nil
	}
	return &Continue{
		AIH:    "aih " + definition.ID + " resume " + sessionID,
		Native: strings.Join(native, " "),
		Note:   note(definition.ID),
	}
}

func nativeArgv(definition providers.Definition, template []string, sessionID string) []string {
	binary := definition.ID
	if definition.CLI != nil && strings.TrimSpace(definition.CLI.BinaryName) != "" {
		binary = strings.TrimSpace(definition.CLI.BinaryName)
	}
	argv := make([]string, 0, len(template)+1)
	argv = append(argv, binary)
	replaced := false
	for _, token := range template {
		if strings.Contains(token, "{sessionId}") {
			replaced = true
			token = strings.ReplaceAll(token, "{sessionId}", sessionID)
		}
		argv = append(argv, token)
	}
	if !replaced {
		return nil
	}
	return argv
}

// note 只在合同能证明的约束上给提示，不按 Provider 猜测。
func note(providerID string) string {
	if providerID == "codex" {
		// Codex 0.171 的远程 TUI 会拒绝 /resume 与 /fork 上的会话级权限覆盖。
		return "原生恢复不要追加 -s/-a/--dangerously-bypass-approvals-and-sandbox 等权限参数；远程模式会拒绝权限覆盖，权限请写入 ~/.codex/config.toml。"
	}
	return "原生命令不包含 AIH 的账号/网关参数；需要 AIH 账号时使用 aih 命令。"
}
