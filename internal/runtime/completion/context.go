package completion

import "time"

// accountRow 是 `account_cli_aliases` 的一行（用户可见的 CLI 编号）。
type accountRow struct {
	Provider     string
	CLIAccountID string
	AccountRef   string
}

// modelRequest 描述一次模型候选查询的定位信息。
type modelRequest struct {
	Provider     string
	AccountRef   string
	AccountToken string
	Current      string
	Mode         string
}

// modelChoice 是一条模型/别名候选。Group 决定协议里的分组列：
// zsh 按组名分节显示，组的出现顺序就是优先级顺序。
type modelChoice struct {
	Value       string
	Description string
	Group       string
}

// sessionChoice 是一条 provider 会话候选（updatedAt 保持字符串以对齐 Node 缓存）。
type sessionChoice struct {
	ID        string
	Title     string
	UpdatedAt string
	Live      bool
}

// resumeChoice 是跨 provider 的最近会话候选。
type resumeChoice struct {
	ID          string
	Title       string
	UpdatedAt   int64
	Provider    string
	ProjectPath string
}

// persistentChoice 是一条持久会话候选。
type persistentChoice struct {
	Name      string
	Title     string
	Provider  string
	CreatedAt int64
	UpdatedAt int64
	Here      bool
	Live      bool
	MatchText string
}

// peerChoice 是 peer 收件人/消息候选（Detail 已压平）。
type peerChoice struct {
	Value  string
	Detail string
}

// proxyChoice 是代理节点候选。
type proxyChoice struct {
	Value       string
	Description string
}

// resolverContext 注入所有动态候选来源；每项都允许为空，解析器按位置惰性调用。
type resolverContext struct {
	historyEntries     []historyEntry
	historyLimit       int
	accountLister      func(provider string) []accountRow
	proxyLister        func() []proxyChoice
	sessionLister      func(provider, accountRef, current string) []sessionChoice
	resumeLister       func(current string) []resumeChoice
	persistentLister   func(current string) []persistentChoice
	peerLister         func(current string) []peerChoice
	peerMessageLister  func(current string) []peerChoice
	modelLister        func(request modelRequest) []modelChoice
	aihServerProfileID string
	now                time.Time
}

// aihServerProfileID 是内置网关档的稳定标识。
const aihServerProfileID = ".aih-server"
