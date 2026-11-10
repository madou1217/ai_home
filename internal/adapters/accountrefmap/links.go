// Package accountrefmap 提供 Node(app-state.db) 与 Go(aih.db) 账号引用的双向映射。
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
package accountrefmap

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
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

// Load 读取 aiHomeDir 下 app-state.db 的同步链接表。
//
// 数据库或键不存在返回空表（调用方按恒等回落）；只有读库失败才返回错误。
func Load(ctx context.Context, aiHomeDir string) (Table, error) {
	empty := Table{byNode: map[string]string{}, byGo: map[string]string{}}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return Table{}, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, SyncStateKey)
	if err != nil {
		return Table{}, err
	}
	if !found {
		return empty, nil
	}
	table, err := Parse(raw)
	if err != nil {
		// Node 的 readJsonValue 在解析失败时返回 null，随后整表退化为恒等。
		return empty, nil
	}
	return table, nil
}
