package accountsapi

import "strings"

// 账号导出格式注册表（Registry + Strategy）。
//
// 为什么要有它：导出格式原来是硬编码分派 —— 枚举一个 memberResourceXxxExport、
// 在 parseMemberResource 里加一条 case、在 ServeHTTP 里再加一条 case、
// 在 Dependencies 里��一个字段。加一种格式要改四处，删一种也要改四处（本仓库
// 2026-10-23 删除 sub2api 时正是如此）。
//
// 改成注册表后：**格式 = 一条注册项**（路径后缀 + 下载文件名 + 导出策略），
// 新增/删除格式只动这个表，解析与分派都不改。策略本身仍是 AccountExporter 接口
// （各格式自己的实现），注册表只负责「哪个路径用哪个策略」。
//
// 删除 sub2api 之后表里只剩 cliproxyapi —— 保留注册表而不是退回硬编码，
// 是因为「格式」这件事天然会继续增加（后续会有原生导出），
// 而硬编码分派正是让上次删除变得啰嗦的原因。

// exportFormat 是一种账号导出格式。
type exportFormat struct {
	// PathSuffix 是成员路径里 `export/` 之后的后缀；空串表示 `export` 本身。
	PathSuffix string
	// FileName 是下载时的文件名（Content-Disposition）。
	FileName string
	// Resolve 从 Handler 已解构的字段里取该格式的导出策略
	// （Handler 不持有 Dependencies，构造时就 fail-closed 校验过，所以这里直接取字段）。
	Resolve func(*Handler) AccountExporter
}

// exportFormats 是全部已注册的导出格式，**顺序即匹配优先级**（更长的后缀优先）。
//
// 2026-10-23：sub2api 已移除（用户要求废弃该格式；账号迁移改走原生静态凭据路径）。
// 它的注册项连同 internal/adapters/accounts/sub2api 的 exporter 一起删除。
var exportFormats = []exportFormat{
	{
		PathSuffix: "cliproxyapi",
		FileName:   "cliproxyapi-auth.json",
		Resolve: func(handler *Handler) AccountExporter { return handler.cliProxyAPIExporter },
	},
}

// matchExportFormat 按路径后缀找格式（长后缀优先，避免前缀互相遮蔽）。
func matchExportFormat(suffix string) (exportFormat, bool) {
	best := exportFormat{}
	found := false
	for _, format := range exportFormats {
		if format.PathSuffix != suffix {
			continue
		}
		if !found || len(format.PathSuffix) > len(best.PathSuffix) {
			best = format
			found = true
		}
	}
	return best, found
}

// exportPathSuffixes 供路径解析使用：`export` 之后允许的后缀集合。
func exportPathSuffixes() []string {
	suffixes := make([]string, 0, len(exportFormats))
	for _, format := range exportFormats {
		suffixes = append(suffixes, format.PathSuffix)
	}
	return suffixes
}

// normalizeExportSuffix 去掉空白，便于比较。
func normalizeExportSuffix(value string) string {
	return strings.TrimSpace(value)
}
