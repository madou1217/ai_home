// Package webuiegresspoolapi 提供出口池面板的只读投影。
//
// 契约来源是 Node 的 GET /v0/webui/egress-pool（lib/server/webui-egress-pool-routes.js）：
// 服务状态 + 节点账本（冷却 / 拦截 / 最近探测）。本包只迁只读视图，probe、
// nodes/:name/select、clear-cooldown 等写动作不在范围内。
//
// 键名规则：Node 已有且本次照抄的键保持 camelCase（name / cooldownUntil / probe.latencyMs …），
// 本包新增的元数据键用 snake_case（derived_by / unavailable_sources …）。
//
// 诚实边界：节点表与账本是两份外部事实。池没起时输出 nodes:null 并标注
// unavailable_sources=["egress_pool"]；账本不可用时节点照给，但冷却与探测整块不填并标注
// node_health —— 绝不用空数组或零值冒充「已知为空」。
package webuiegresspoolapi

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Path 是出口池只读投影的管理面契约路径。
//
//	GET /v1/management/webui/egress-pool
const Path = "/v1/management/webui/egress-pool"

const (
	// derivedByGoPartial 标注响应只含 Go 能证明的字段，调用方不得把它当成 Node 全量形状。
	derivedByGoPartial = "go_partial"
	// dataSource 固定指向出口池配置 + 节点账本这两份事实。
	dataSource = "egress_pool"
	// legacyIPBlockedKind 是已废弃的冷却类别：账本加载时会被清掉，这里仍按 Node 的
	// isCooling 口径排除，避免历史文件把节点判成冷却中。
	legacyIPBlockedKind = "ip_blocked"
)

// ErrInvalidDependencies 表示 Handler 缺少数据源或鉴权策略。
var ErrInvalidDependencies = errors.New("出口池 WebUI 只读投影依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总出口池只读投影的依赖。
//
// Health 与 Now 可选：不接线时冷却与探测整块不填，时间取 time.Now。
type Dependencies struct {
	Authorizer Authorizer
	Source     Source
	// Health 读节点账本（冷却 / 拦截 / 最近探测）。
	Health Health
	// Now 是判定冷却是否生效的时钟；零值时用 time.Now。
	Now func() time.Time
}

// Handler 是出口池只读投影的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	source     Source
	health     Health
	now        func() time.Time
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Source == nil {
		return nil, ErrInvalidDependencies
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		source:     dependencies.Source,
		health:     dependencies.Health,
		now:        now,
	}, nil
}

// response 是成功响应。
//
// nodes 用指针承载：nil 序列化成 null（= 不知道有哪些节点），空切片序列化成 []
// （= 确实没有节点）。两者不能混成同一个值。
type response struct {
	OK         bool        `json:"ok"`
	DerivedBy  string      `json:"derived_by"`
	DataSource string      `json:"data_source"`
	Available  bool        `json:"available"`
	Status     *statusView `json:"status"`
	Nodes      *[]nodeView `json:"nodes"`
	// ServerTime 沿用 Node 的键名与语义：毫秒时间戳。
	ServerTime int64 `json:"serverTime"`
	// Version 是节点表指纹（Node 用它做 ETag）。节点表未知时留空。
	Version            string   `json:"version"`
	UnavailableSources []string `json:"unavailable_sources"`
	FilledFields       []string `json:"filled_fields"`
	UnfilledFields     []string `json:"unfilled_fields"`
}

// statusView 对应 Node 的 status，只保留标量字段。
type statusView struct {
	Ready           bool   `json:"ready"`
	ProxyURL        string `json:"proxyUrl"`
	NodeCount       int    `json:"nodeCount"`
	ActiveNodeIndex int    `json:"activeNodeIndex"`
	ActiveNode      string `json:"activeNode"`
	LastError       string `json:"lastError"`
	CoolingCount    int    `json:"coolingCount"`
	ProbeIntervalMS int64  `json:"probeIntervalMs"`
	ProbePort       int    `json:"probePort"`
	LaneSlots       int    `json:"laneSlots"`
}

// nodeView 是节点账本里的一条展示记录。
//
// 默认值与 Node 一致：cooling=false、cooldownUntil=0、cooldownKind=""、blocked=false、probe=null。
// active 不单独出键：当前选择由 status.activeNode 表达（Node 前端也是这么比对的）。
type nodeView struct {
	Name                string     `json:"name"`
	NodeID              string     `json:"nodeId"`
	Label               string     `json:"label"`
	Protocol            string     `json:"protocol"`
	Server              string     `json:"server"`
	Port                int        `json:"port"`
	CountryCode         string     `json:"countryCode"`
	CountryFlag         string     `json:"countryFlag"`
	Enabled             bool       `json:"enabled"`
	Cooling             bool       `json:"cooling"`
	CooldownUntil       int64      `json:"cooldownUntil"`
	CooldownKind        string     `json:"cooldownKind"`
	CooldownRemainingMS int64      `json:"cooldownRemainingMs"`
	Blocked             bool       `json:"blocked"`
	BlockedReason       string     `json:"blockedReason"`
	BlockedDetail       string     `json:"blockedDetail"`
	Probe               *probeView `json:"probe"`
}

// probeView 对应 Node 的 probe 对象。
type probeView struct {
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latencyMs"`
	AtMS      int64  `json:"at"`
	Error     string `json:"error"`
	Source    string `json:"source"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.source == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "egress_pool_unavailable", "出口池投影不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取出口池投影")
		return
	}
	// 分页 / 筛选尚未迁移：静默忽略 page 会让调用方以为拿到了某一页，实际是全量。
	// 显式 400 比返回一份「看起来分过页」的数据更容易排查。
	if strings.TrimSpace(request.URL.RawQuery) != "" {
		writeError(responseWriter, http.StatusBadRequest, "invalid_query", "出口池投影暂不支持查询参数（分页与筛选待迁移）")
		return
	}
	pool, err := handler.source.ReadEgressPool(request.Context())
	if err != nil {
		// 配置读不出来是硬失败：没有节点表就没有可标注的视图。
		writeError(responseWriter, http.StatusServiceUnavailable, "egress_pool_unavailable", "出口池配置读取失败")
		return
	}
	writeJSON(responseWriter, http.StatusOK, handler.newResponse(request, pool))
}

// newResponse 把出口池配置与节点账本合成只读视图。
func (handler *Handler) newResponse(request *http.Request, pool Pool) response {
	nowMS := handler.now().UnixMilli()
	view := response{
		OK:           true,
		DerivedBy:    derivedByGoPartial,
		DataSource:   dataSource,
		Available:    pool.Available,
		ServerTime:   nowMS,
		FilledFields: []string{"available", "serverTime"},
		UnfilledFields: []string{
			"events",
			"nodePolicy",
			"boundAccounts",
			"pagination",
			"status.workDir",
			"status.dnsProbe",
			"status.lanes",
			"nodes[].uses",
			"nodes[].geo",
			"nodes[].accounts",
		},
	}
	// 缺失来源一律输出数组（可能是空数组），不用 null 表示「什么都不缺」。
	view.UnavailableSources = make([]string, 0, 2)
	if !pool.Available {
		// 没有出口池服务：nodes 保持 null（不是空数组），状态整块不填。
		view.UnavailableSources = append(view.UnavailableSources, "egress_pool")
		return view
	}

	ledger, healthKnown := handler.readLedger(request)
	if !healthKnown {
		view.UnavailableSources = append(view.UnavailableSources, "node_health")
		view.UnfilledFields = append(view.UnfilledFields,
			"nodes[].cooling", "nodes[].cooldownUntil", "nodes[].probe", "status.coolingCount")
	} else {
		view.FilledFields = append(view.FilledFields,
			"nodes[].cooling", "nodes[].cooldownUntil", "nodes[].probe", "status.coolingCount")
	}

	activeNode := strings.TrimSpace(pool.Status.ActiveNode)
	nodes := make([]nodeView, 0, len(pool.Nodes))
	coolingCount := 0
	activeIndex := -1
	for index, node := range pool.Nodes {
		row := newNodeView(node, ledger[node.Name], nowMS)
		if row.Cooling {
			coolingCount++
		}
		if activeNode != "" && node.Name == activeNode {
			activeIndex = index
		}
		nodes = append(nodes, row)
	}
	view.Nodes = &nodes
	view.Version = nodesVersion(nodes)
	view.FilledFields = append(view.FilledFields, "status", "nodes", "version")
	view.Status = &statusView{
		Ready:           pool.Status.Ready,
		ProxyURL:        pool.Status.ProxyURL,
		NodeCount:       len(nodes),
		ActiveNodeIndex: activeIndex,
		ActiveNode:      activeNode,
		LastError:       pool.Status.LastError,
		CoolingCount:    coolingCount,
		ProbeIntervalMS: pool.Status.ProbeIntervalMS,
		ProbePort:       pool.Status.ProbePort,
		LaneSlots:       pool.Status.LaneSlots,
	}
	return view
}

// readLedger 读节点账本。未接线或读失败都返回 healthKnown=false，由调用方标注缺失，
// 不让可选事实源把整份视图拖成错误。
func (handler *Handler) readLedger(request *http.Request) (map[string]NodeHealth, bool) {
	if handler.health == nil {
		return nil, false
	}
	ledger, err := handler.health.SnapshotNodeHealth(request.Context())
	if err != nil {
		return nil, false
	}
	return ledger, true
}

// newNodeView 把配置节点与账本事实合成一条展示记录。
func newNodeView(node Node, health NodeHealth, nowMS int64) nodeView {
	view := nodeView{
		Name:        node.Name,
		NodeID:      node.NodeID,
		Label:       node.Label,
		Protocol:    node.Protocol,
		Server:      node.Server,
		Port:        node.Port,
		CountryCode: node.CountryCode,
		CountryFlag: node.CountryFlag,
		Enabled:     node.Enabled,
		Blocked:     health.Blocked,
	}
	if view.Label == "" {
		view.Label = node.Name
	}
	// 冷却判定与 Node 的 isCooling 同口径：截止时间在未来、且不是已废弃的类别。
	if health.CooldownKind != "" && health.CooldownKind != legacyIPBlockedKind && health.CooldownUntilMS > nowMS {
		view.Cooling = true
		view.CooldownUntil = health.CooldownUntilMS
		view.CooldownKind = health.CooldownKind
		view.CooldownRemainingMS = health.CooldownUntilMS - nowMS
	}
	if health.Blocked {
		view.BlockedReason = health.BlockedReason
		view.BlockedDetail = health.BlockedDetail
	}
	view.Probe = newProbeView(health.Probe)
	return view
}

// newProbeView 翻译探测结果；没有探测过时返回 nil（JSON 里的 null）。
func newProbeView(probe *Probe) *probeView {
	if probe == nil {
		return nil
	}
	return &probeView{
		OK:        probe.OK,
		LatencyMS: probe.LatencyMS,
		AtMS:      probe.AtMS,
		Error:     probe.Error,
		Source:    probe.Source,
	}
}

// nodesVersion 复刻 Node 的 nodesVersion（sha1 前 16 位），只喂会影响展示的字段。
//
// 与 Node 的差异：uses / lastUsedAt 属于使用统计，本次没有来源，固定按 0 计入。
// 因此本指纹只覆盖节点身份、冷却、拦截与探测，不承诺与 Node 算出同一个值。
func nodesVersion(nodes []nodeView) string {
	hash := sha1.New()
	for _, node := range nodes {
		probe := ""
		if node.Probe != nil {
			probe = fmt.Sprintf("%d:%d:%d", boolDigit(node.Probe.OK), node.Probe.LatencyMS, node.Probe.AtMS)
		}
		fmt.Fprintf(hash, "%s|%d|%d|%d|%d|%d|%s\n",
			node.Name,
			boolDigit(node.Cooling),
			node.CooldownUntil,
			boolDigit(node.Blocked),
			0,
			0,
			probe,
		)
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

func boolDigit(value bool) int {
	if value {
		return 1
	}
	return 0
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
