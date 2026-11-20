// Package accountrefs 提供 Node 与 Go 账号引用的双向映射（纯领域逻辑）。
//
// 两侧账号引用不是同一个值：Node 是账号写入口，账号经 go-account-sync 推给 Go 后，
// Go 会派生自己的 account_ref（静态账号的身份是密钥 + base_url）。映射表只由 Node 维护，
// 存在 app-state.db 的 go-account-sync:state 里：
//
//	{"links": {"<nodeRef>": {"goRef": "<goRef>", "print": "..."}}, "validatorVersion": 3}
//
// 语义与 Node 的 goAccountRefFor / nodeAccountRefFor 保持一致：有链接按链接走，
// **没有链接按恒等**（两边引用本来就是同一份内容寻址 hash，只是该账号还没走进链接表）。
// 把「无链接」当成「未映射」会让调用方把同一个账号判成另一个账号。
//
// 解析与翻译是纯函数，因此放在应用层：存储读取（app-state.db 的 KV）留在
// internal/adapters/accountrefmap，运行时只依赖本契约的类型与语义。
package accountrefs

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// SyncStateKey 是 Node go-account-sync 在 app-state.db 中保存同步状态的键。
const SyncStateKey = "go-account-sync:state"

// Link 是单个账号的同步链接。Print 是凭据指纹，映射本身只需要 GoRef。
type Link struct {
	NodeRef string
	GoRef   string
	Print   string
}

type stateDocument struct {
	Links map[string]*struct {
		GoRef string `json:"goRef"`
		Print string `json:"print"`
	} `json:"links"`
}

// Table 是一份不可变（构造后不再修改）的 Node→Go 映射表。
//
// 只有非空 goRef 的链接会入表：空 goRef 在 Node 侧走恒等回落，等价于没有链接。
// 零值可用：所有方法对 nil 内部映射按空表处理。
type Table struct {
	byNode map[string]string
	byGo   map[string]string
}

// Parse 解析 go-account-sync:state 的原始 JSON。
//
// 空串或 "null" 视为空表（不报错）；JSON 结构损坏返回错误，由调用方决定是否降级。
func Parse(raw string) (Table, error) {
	table := Table{byNode: map[string]string{}, byGo: map[string]string{}}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return table, nil
	}
	var document stateDocument
	if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
		return Table{}, fmt.Errorf("解析 %s 失败: %w", SyncStateKey, err)
	}
	nodes := make([]string, 0, len(document.Links))
	for nodeRef := range document.Links {
		nodes = append(nodes, nodeRef)
	}
	// 排序后建表：同一条 goRef 被多个 nodeRef 指向时，反向查找必须可得且稳定。
	sort.Strings(nodes)
	for _, nodeRef := range nodes {
		link := document.Links[nodeRef]
		normalizedNode := strings.TrimSpace(nodeRef)
		if link == nil || normalizedNode == "" {
			continue
		}
		goRef := strings.TrimSpace(link.GoRef)
		if goRef == "" {
			continue
		}
		table.byNode[normalizedNode] = goRef
		if _, exists := table.byGo[goRef]; !exists {
			table.byGo[goRef] = normalizedNode
		}
	}
	return table, nil
}

// Links 返回 Node→Go 的链接快照；空表返回空 map（不是 nil）。
func (table Table) Links() map[string]string {
	links := make(map[string]string, len(table.byNode))
	for nodeRef, goRef := range table.byNode {
		links[nodeRef] = goRef
	}
	return links
}

// Len 返回链接条数。
func (table Table) Len() int {
	return len(table.byNode)
}

// GoRef 把 Node 引用翻译成 Go 引用；无链接或空引用按恒等处理。
func (table Table) GoRef(nodeRef string) string {
	normalized := strings.TrimSpace(nodeRef)
	if normalized == "" {
		return ""
	}
	if goRef, ok := table.byNode[normalized]; ok {
		return goRef
	}
	return normalized
}

// NodeRef 把 Go 引用翻译回 Node 引用；无链接或空引用按恒等处理。
func (table Table) NodeRef(goRef string) string {
	normalized := strings.TrimSpace(goRef)
	if normalized == "" {
		return ""
	}
	if nodeRef, ok := table.byGo[normalized]; ok {
		return nodeRef
	}
	return normalized
}

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
