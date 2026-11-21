package providers

import "strings"

// OfficialModelCatalog 是某个 Provider 官方 CLI 支持/展示的模型清单。
//
// 这份清单是**配置取值**的候选，不表示当前有账号能路由该模型；WebUI 会与
// 账号模型目录合并，并把没有账号的条目标成“无账号”。清单随官方 CLI 版本
// 变化，VerifiedCliVersion 记录校对时的版本，数据来源见 Source。
//
// 不要用 models.dev 等元数据聚合目录充当 Provider 模型来源：它们的 provider
// 命名空间是聚合器/展示口径，不是各官方 CLI 的支持矩阵。
type OfficialModelCatalog struct {
	VerifiedCliVersion string
	Source             string
	Models             []string
}

var builtinOfficialModelCatalogs = map[string]OfficialModelCatalog{
	"claude": {
		VerifiedCliVersion: "2.1.330",
		// 从已安装的 Claude Code CLI 内置模型表提取（当前世代 4.5+ 与 Fable）。
		Source: "claude-code bundled model table",
		Models: []string{
			"claude-fable-5-2",
			"claude-fable-5-1",
			"claude-fable-5",
			"claude-opus-5-5",
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-opus-4-5",
			"claude-sonnet-5-5",
			"claude-sonnet-5",
			"claude-sonnet-4-6",
			"claude-sonnet-4-5",
			"claude-haiku-5-5",
			"claude-haiku-4-5",
		},
	},
	"codex": {
		VerifiedCliVersion: "0.170.0",
		// 从已安装的 Codex CLI 二进制内置模型名提取。
		Source: "codex bundled model slugs",
		Models: []string{
			"gpt-6.2-sol",
			"gpt-6.2-astra",
			"gpt-6.1-sol",
			"gpt-6.1-terra",
			"gpt-6-sol",
			"gpt-6-luna",
			"gpt-6-astra",
			"gpt-6-pro",
			"gpt-5.6-sol",
			"gpt-5.6-luna",
			"gpt-5.6-terra",
			"gpt-5.3-codex",
			"gpt-5.5",
			"gpt-5.2",
		},
	},
}

// OfficialModels 返回 Provider 官方 CLI 支持的模型清单；未登记时返回空。
func OfficialModels(providerID string) (OfficialModelCatalog, bool) {
	catalog, found := builtinOfficialModelCatalogs[strings.ToLower(strings.TrimSpace(providerID))]
	if !found || len(catalog.Models) == 0 {
		return OfficialModelCatalog{}, false
	}
	catalog.Models = append([]string(nil), catalog.Models...)
	return catalog, true
}
