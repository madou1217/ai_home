package subaggregator

import "encoding/json"

const managedSSHSourceID = "aih-managed-ssh"

func isManagedSource(source Subscription) bool {
	return source.ID == managedSSHSourceID || source.Kind == "managed"
}

func isManagedSSHNode(node ProxyNode) bool {
	return node.Str("managedBy") == "sshproxy" || node.Str("subscriptionId") == managedSSHSourceID
}

// SubscriptionUserInfo 表示订阅流量与过期时间元数据。
type SubscriptionUserInfo struct {
	Upload   *float64 `json:"upload,omitempty"`
	Download *float64 `json:"download,omitempty"`
	Total    *float64 `json:"total,omitempty"`
	Expire   *float64 `json:"expire,omitempty"`
}

// Subscription 表示一个订阅源（远程、本地导入文本或运行时受管来源）。
type Subscription struct {
	ID           string                `json:"id"`
	Name         string                `json:"name"`
	Kind         string                `json:"kind"` // remote | local | managed
	URL          *string               `json:"url"`
	Content      string                `json:"content,omitempty"`
	UserAgent    *string               `json:"userAgent,omitempty"`
	NodeCount    int                   `json:"nodeCount"`
	LastSyncedAt *int64                `json:"lastSyncedAt"`
	UserInfo     *SubscriptionUserInfo `json:"userInfo"`
	Enabled      bool                  `json:"enabled"`
}

// ProxyPoolStoreData 对应 ~/.ai_home/proxy-pool.json 结构。
type ProxyPoolStoreData struct {
	Version       int            `json:"version"`
	Subscriptions []Subscription `json:"subscriptions"`
	Nodes         []ProxyNode    `json:"nodes"`
	UpdatedAt     int64          `json:"updatedAt,omitempty"`
	Extra         map[string]any `json:"-"`
}

// RenameRule 表示节点重命名规则。
type RenameRule struct {
	Pattern string `json:"pattern"`
	Replace string `json:"replace"`
}

func (r *RenameRule) UnmarshalJSON(data []byte) error {
	var raw struct {
		Pattern     string `json:"pattern"`
		Replace     string `json:"replace"`
		Replacement string `json:"replacement"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	r.Pattern = raw.Pattern
	r.Replace = raw.Replace
	if r.Replace == "" {
		r.Replace = raw.Replacement
	}
	return nil
}

// ProfileSources 表示聚合配置的数据源筛选。
type ProfileSources struct {
	All                bool     `json:"all"`
	SubscriptionIds    []string `json:"subscriptionIds"`
	IncludeManualNodes bool     `json:"includeManualNodes"`
}

// ProfileFilter 表示节点过滤条件。
type ProfileFilter struct {
	Include   string   `json:"include"`
	Exclude   string   `json:"exclude"`
	Protocols []string `json:"protocols"`
}

// ProfileNaming 表示节点命名规则。
type ProfileNaming struct {
	SourcePrefix bool         `json:"sourcePrefix"`
	Renames      []RenameRule `json:"renames"`
}

// CustomGroupNodes 描述自建策略组按名称筛选或勾选的节点。
type CustomGroupNodes struct {
	Include string   `json:"include"`
	Exclude string   `json:"exclude"`
	Names   []string `json:"names"`
}

// CustomGroup 表示自定义策略组。
type CustomGroup struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Type      string           `json:"type"`
	Members   []string         `json:"members"`
	Nodes     CustomGroupNodes `json:"nodes"`
	TestURL   string           `json:"testUrl,omitempty"`
	Interval  int              `json:"interval,omitempty"`
	Tolerance *int             `json:"tolerance,omitempty"`
	Strategy  string           `json:"strategy,omitempty"`
}

func (g *CustomGroup) UnmarshalJSON(data []byte) error {
	type alias struct {
		ID              string            `json:"id"`
		Name            string            `json:"name"`
		Type            string            `json:"type"`
		Members         []string          `json:"members"`
		Nodes           *CustomGroupNodes `json:"nodes"`
		NodeNames       []string          `json:"nodeNames"`
		TestURL         string            `json:"testUrl"`
		Interval        int               `json:"interval"`
		TestIntervalSec int               `json:"testIntervalSec"`
		Tolerance       *int              `json:"tolerance"`
		Strategy        string            `json:"strategy"`
	}
	var raw alias
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	g.ID = raw.ID
	g.Name = raw.Name
	g.Type = raw.Type
	g.Members = raw.Members
	if raw.Nodes != nil {
		g.Nodes = *raw.Nodes
	} else if len(raw.NodeNames) > 0 {
		g.Nodes.Names = raw.NodeNames
	}
	if g.Nodes.Names == nil {
		g.Nodes.Names = []string{}
	}
	g.TestURL = raw.TestURL
	g.Interval = raw.Interval
	if g.Interval == 0 {
		g.Interval = raw.TestIntervalSec
	}
	g.Tolerance = raw.Tolerance
	g.Strategy = raw.Strategy
	return nil
}

// ProfileGroups 表示策略组配置。
type ProfileGroups struct {
	Regions         []string      `json:"regions"`
	PerSource       bool          `json:"perSource"`
	TestURL         string        `json:"testUrl"`
	TestIntervalSec int           `json:"testIntervalSec"`
	Custom          []CustomGroup `json:"custom"`
}

// PresetRule 表示预设分流开关。
type PresetRule struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
	Policy  string `json:"policy"`
}

// CustomRule 表示自定义分流规则。
type CustomRule struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	Policy    string `json:"policy"`
	NoResolve bool   `json:"noResolve,omitempty"`
}

// ProfileRules 表示分流规则配置。
type ProfileRules struct {
	Presets     []PresetRule `json:"presets"`
	Custom      []CustomRule `json:"custom"`
	FinalPolicy string       `json:"finalPolicy"`
}

// AggregatorProfile 表示订阅聚合配置文件。
type AggregatorProfile struct {
	ID               string         `json:"id"`
	Name             string         `json:"name"`
	Token            string         `json:"token"`
	Sources          ProfileSources `json:"sources"`
	Filter           ProfileFilter  `json:"filter"`
	Naming           ProfileNaming  `json:"naming"`
	Dedupe           bool           `json:"dedupe"`
	Groups           ProfileGroups  `json:"groups"`
	Rules            ProfileRules   `json:"rules"`
	RefreshHours     int            `json:"refreshHours"`
	CreatedAt        int64          `json:"createdAt"`
	UpdatedAt        int64          `json:"updatedAt"`
	SubscriptionPath string         `json:"subscriptionPath,omitempty"`
}

// AggregatorStoreData 对应 ~/.ai_home/subscription-aggregator.json。
type AggregatorStoreData struct {
	Version  int                 `json:"version"`
	Profiles []AggregatorProfile `json:"profiles"`
}

// RuleSetRef 表示一个 geosite/geoip 规则集引用。
type RuleSetRef struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	NoResolve bool   `json:"noResolve,omitempty"`
	Tag       string `json:"tag,omitempty"`
}

// RulePresetDef 描述预设分流分类。
type RulePresetDef struct {
	ID               string       `json:"id"`
	Name             string       `json:"name"`
	Description      string       `json:"description"`
	DefaultPolicy    string       `json:"defaultPolicy"`
	EnabledByDefault bool         `json:"enabledByDefault"`
	RuleSets         []RuleSetRef `json:"ruleSets,omitempty"`
}

// RegionDef 描述地区分组定义。
type RegionDef struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
	Flag string `json:"flag"`
}

// FormatDef 描述输出订阅格式。
type FormatDef struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Extension string `json:"extension"`
	Groups    bool   `json:"groups"`
	Note      string `json:"note,omitempty"`
}

// ClientDef 描述客户端与默认格式映射。
type ClientDef struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Format string `json:"format"`
}

// GroupTypeDef 描述策略组类型元数据。
type GroupTypeDef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// LoadBalanceStrategyDef 描述负载均衡策略。
type LoadBalanceStrategyDef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Catalog 表示聚合器前端目录元数据。
type Catalog struct {
	Presets               []RulePresetDef          `json:"presets"`
	Regions               []RegionDef              `json:"regions"`
	Formats               []FormatDef              `json:"formats"`
	Clients               []ClientDef              `json:"clients"`
	Protocols             []string                 `json:"protocols"`
	DefaultUserAgent      string                   `json:"defaultUserAgent"`
	RuleTypes             []string                 `json:"ruleTypes"`
	GroupTypes            []GroupTypeDef           `json:"groupTypes"`
	LoadBalanceStrategies []LoadBalanceStrategyDef `json:"loadBalanceStrategies"`
	ReservedGroupNames    []string                 `json:"reservedGroupNames"`
	ProtocolForms         []ProtocolFormDef        `json:"protocolForms"`
	DefaultProfile        DefaultProfileTemplate   `json:"defaultProfile"`
}

// DefaultProfileTemplate 描述 getOverview().catalog.defaultProfile 结构（无 id/token/时间戳）。
type DefaultProfileTemplate struct {
	Name         string         `json:"name"`
	Sources      ProfileSources `json:"sources"`
	Filter       ProfileFilter  `json:"filter"`
	Naming       ProfileNaming  `json:"naming"`
	Dedupe       bool           `json:"dedupe"`
	Groups       ProfileGroups  `json:"groups"`
	Rules        ProfileRules   `json:"rules"`
	RefreshHours int            `json:"refreshHours"`
}
