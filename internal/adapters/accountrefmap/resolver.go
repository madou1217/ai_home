package accountrefmap

import "strings"

// Resolver 把「同步是否启用」和映射表合成一个翻译器。
//
// 未启用同步时两侧引用本来就相同（Node 不写链接表），所以一律恒等；
// 这与 Node 的 goAccountRefFor 在 accountSync=false 时的分支一致。
type Resolver struct {
	enabled bool
	table   Table
}

// NewResolver 构造翻译器；table 为零值时按空表处理。
func NewResolver(enabled bool, table Table) Resolver {
	if table.byNode == nil {
		table = Table{byNode: map[string]string{}, byGo: map[string]string{}}
	}
	return Resolver{enabled: enabled, table: table}
}

// Enabled 报告同步链接是否参与翻译。
func (resolver Resolver) Enabled() bool { return resolver.enabled }

// GoRef 返回 Node 引用对应的 Go 引用。
func (resolver Resolver) GoRef(nodeRef string) string {
	if !resolver.enabled {
		return strings.TrimSpace(nodeRef)
	}
	return resolver.table.GoRef(nodeRef)
}

// NodeRef 返回 Go 引用对应的 Node 引用。
func (resolver Resolver) NodeRef(goRef string) string {
	if !resolver.enabled {
		return strings.TrimSpace(goRef)
	}
	return resolver.table.NodeRef(goRef)
}

// Links 返回整张 Node→Go 表供批量投影；未启用同步时返回 nil（两边相同，无需翻译）。
func (resolver Resolver) Links() map[string]string {
	if !resolver.enabled {
		return nil
	}
	return resolver.table.Links()
}
