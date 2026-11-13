package egress

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

var _ io.Closer = (*Manager)(nil)

const (
	// DefaultProbeIntervalMS 与 Node EGRESS_POOL_PROBE_INTERVAL_MS 对齐（60s）。
	DefaultProbeIntervalMS = 60 * 1000
)

// WatchEvent 描述向 WebUI /egress-upstreams/watch 订阅者广播的变更通知。
type WatchEvent struct {
	Type   string `json:"type"`
	Reason string `json:"reason,omitempty"`
	At     int64  `json:"at"`
}

// ManagerOptions 配置 Go 出口池与上游管理运行时。
type ManagerOptions struct {
	AIHomeDir            string
	HomeDir              string
	Now                  func() time.Time
	PIDAlive             func(int) bool
	HTTPClient           *http.Client
	ProbeURL             string
	ProbeTimeoutMS       int
	UpstreamProbeTimeout time.Duration
	NodeGeoTTLMS         int64
	DisableAutoDirectGeo bool

	Enabled             *bool
	MixedPort           int
	ControllerPort      int
	ProbePort           int
	DisableProbePort    bool
	LanePortBase        int
	LaneSlots           int
	DisableLanes        bool
	StartupTimeout      time.Duration
	StartupPollInterval time.Duration
	SwitchSettleDelay   time.Duration
	DisableSwitchSettle bool
	ReapTimeout         time.Duration
	StartRetryBackoff   time.Duration
	PlanInterval        time.Duration
	ProbeInterval       time.Duration
	DisableProbeLoop    bool
	ProbeBatchSize      int
	ProbeConcurrency    int
	GeoPerTick          int
	ProbesPerTick       int
	CorePath            string
	InterfacesFunc      func() ([]NetInterfaceEntry, error)
	SpawnCore           func(ctx context.Context, binaryPath string, args []string) (CoreProcess, error)
	KillPID             func(pid int) error
	OwnerPID            int
	Platform            string
	SystemProxyDetector func(context.Context) (agyegress.SystemProxyStatus, error)
	TUNDetector         func(context.Context) (agyegress.TUNStatus, error)
	ProxyProbeFunc      func(ctx context.Context, proxyURL string) ProxyProbeResult
	DesktopBridge       DesktopClientBridge
	Catalog             *providers.Catalog
	LocalGeoHTTPClient  *http.Client
	Logger              func(string)
}

// LaneView 描述一条活跃车道的展示状态。
type LaneView struct {
	Index        int      `json:"index"`
	Key          string   `json:"key"`
	ProxyURL     string   `json:"proxyUrl"`
	ActiveNode   string   `json:"activeNode"`
	ActiveNodeID string   `json:"activeNodeId,omitempty"`
	AllowedCount int      `json:"allowedCount"`
	Accounts     []string `json:"accounts"`
	Strategy     string   `json:"strategy"`
	Upstream     string   `json:"upstream"`
	Blocked      string   `json:"blocked"`
	SessionSlot  *int     `json:"sessionSlot,omitempty"`
}

// PoolStatusView 是出口池服务的运行时状态快照。
type PoolStatusView struct {
	Ready           bool       `json:"ready"`
	ProxyURL        string     `json:"proxyUrl"`
	NodeCount       int        `json:"nodeCount"`
	ActiveNodeIndex int        `json:"activeNodeIndex"`
	ActiveNode      string     `json:"activeNode"`
	WorkDir         string     `json:"workDir,omitempty"`
	LastError       string     `json:"lastError"`
	CoolingCount    int        `json:"coolingCount"`
	ProbeIntervalMS int64      `json:"probeIntervalMs"`
	ProbePort       int        `json:"probePort"`
	LaneSlots       int        `json:"laneSlots"`
	Lanes           []LaneView `json:"lanes"`
	LaneOverflow    []string   `json:"laneOverflow"`
}

// PoolNodeCounts 统计各类筛选标签的节点数量。
type PoolNodeCounts struct {
	All     int `json:"all"`
	Healthy int `json:"healthy"`
	Cooling int `json:"cooling"`
	Blocked int `json:"blocked"`
	Used    int `json:"used"`
}

// PoolPagination 描述分页切片元信息。
type PoolPagination struct {
	Page      int `json:"page"`
	PageSize  int `json:"pageSize"`
	Total     int `json:"total"`
	PageCount int `json:"pageCount"`
}

// PoolQueryOptions 指定 /egress-pool 的分页与筛选参数。
type PoolQueryOptions struct {
	HasPage  bool
	Page     int
	PageSize int
	Filter   string
	Query    string
}

// PoolDescribeResult 是 GET /egress-pool 的完整领域结果。
type PoolDescribeResult struct {
	Available     bool                  `json:"available"`
	Status        *PoolStatusView       `json:"status"`
	Nodes         []NodeSnapshotView    `json:"nodes"`
	Events        []HealthEvent         `json:"events"`
	NodePolicy    *NodePolicySummary    `json:"nodePolicy"`
	NodeCounts    *PoolNodeCounts       `json:"nodeCounts,omitempty"`
	Pagination    *PoolPagination       `json:"pagination,omitempty"`
	BoundAccounts []BoundAccountSummary `json:"boundAccounts"`
	ServerTime    int64                 `json:"serverTime"`
	Version       string                `json:"version"`
}

// PoolActionResult 是节点 / 策略操作返回给 HTTP 层的统一结构。
type PoolActionResult struct {
	OK         bool               `json:"ok"`
	Error      string             `json:"error,omitempty"`
	Node       string             `json:"node,omitempty"`
	Blocked    *bool              `json:"blocked,omitempty"`
	Removed    *int               `json:"removed,omitempty"`
	Results    []NodeProbeOutcome `json:"results,omitempty"`
	NodePolicy *NodePolicySummary `json:"nodePolicy,omitempty"`
}

// Manager 负责在 Go 中提供出口池查询/控制、车道规划、上游地区策略与实测探测能力。
type Manager struct {
	aiHomeDir            string
	homeDir              string
	now                  func() time.Time
	pidAlive             func(int) bool
	httpClient           *http.Client
	probeURL             string
	probeTimeoutMS       int
	upstreamProbeTimeout time.Duration
	nodeGeoTTLMS         int64
	disableAutoDirectGeo bool

	mu          sync.Mutex
	syncMu      sync.Mutex
	probeMu     sync.Mutex
	reconcileMu sync.Mutex
	health      *NodeHealthLedger
	entities    *EntityStore
	assignments *AssignmentService
	evidence    *EvidenceStore
	geoCache    *NetworkGeoCache
	supervisor  *PoolSupervisor

	platform            string
	ownerPID            int
	systemProxyDetector func(context.Context) (agyegress.SystemProxyStatus, error)
	tunDetector         func(context.Context) (agyegress.TUNStatus, error)
	proxyProbeFunc      func(ctx context.Context, proxyURL string) ProxyProbeResult
	desktopBridge       DesktopClientBridge
	catalog             *providers.Catalog
	localGeoHTTPClient  *http.Client
	planInterval        time.Duration
	geoPerTick          int
	probesPerTick       int
	logger              func(string)

	watchMu  sync.Mutex
	watchers map[chan WatchEvent]struct{}

	probeJobMu      sync.Mutex
	backgroundProbe bool

	daemonMu     sync.Mutex
	daemonActive bool
	daemonCancel context.CancelFunc
	daemonWG     sync.WaitGroup

	maintMu       sync.Mutex
	maintInFlight *maintenanceCall

	accountMutMu  sync.Mutex
	accountMutMap map[string]*sync.Mutex

	desktopOpMu  sync.Mutex
	desktopOpMap map[string]*sync.Mutex
}

// NewManager 创建一个绑定到 aiHomeDir 的出口池与上游管理器。
func NewManager(opts ManagerOptions) *Manager {
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	home := strings.TrimSpace(opts.HomeDir)
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	nowMS := func() int64 { return nowFn().UnixMilli() }
	rawPIDAlive := opts.PIDAlive
	probeURL := strings.TrimSpace(opts.ProbeURL)
	if probeURL == "" {
		probeURL = DefaultProxyProbeURL
	}
	probeTimeoutMS := opts.ProbeTimeoutMS
	if probeTimeoutMS <= 0 {
		probeTimeoutMS = DefaultProbeTimeoutMS
	}
	upTimeout := opts.UpstreamProbeTimeout
	if upTimeout <= 0 {
		upTimeout = DefaultUpstreamProbeTimeoutMS * time.Millisecond
	}
	geoTTL := opts.NodeGeoTTLMS
	if geoTTL <= 0 {
		geoTTL = NodeGeoTTLMS
	}
	planInterval := opts.PlanInterval
	if planInterval <= 0 {
		planInterval = DefaultPlanInterval
	}
	geoPerTick := opts.GeoPerTick
	if geoPerTick <= 0 {
		geoPerTick = DefaultGeoPerTick
	}
	probesPerTick := opts.ProbesPerTick
	if probesPerTick <= 0 {
		probesPerTick = DefaultProbesPerTick
	}
	ownerPID := opts.OwnerPID
	if ownerPID <= 0 {
		ownerPID = os.Getpid()
	}
	logger := opts.Logger
	if logger == nil {
		logger = func(string) {}
	}

	entityStore := NewEntityStore(aiHome, nowMS)
	assignmentSvc := NewAssignmentService(aiHome, entityStore)
	evidenceStore := NewEvidenceStore(aiHome, nowMS)
	geoCache := NewNetworkGeoCache(aiHome, home, nowMS)
	if opts.LocalGeoHTTPClient != nil {
		client := opts.LocalGeoHTTPClient
		geoCache.lookupFn = func(ctx context.Context, proxyURL string, nowMS int64) (GeoLocation, error) {
			return LookupIPGeoWithFallback(ctx, aiHome, home, proxyURL, client, nowMS)
		}
	}

	m := &Manager{
		aiHomeDir:            aiHome,
		homeDir:              home,
		now:                  nowFn,
		httpClient:           opts.HTTPClient,
		probeURL:             probeURL,
		probeTimeoutMS:       probeTimeoutMS,
		upstreamProbeTimeout: upTimeout,
		nodeGeoTTLMS:         geoTTL,
		disableAutoDirectGeo: opts.DisableAutoDirectGeo,
		health:               LoadNodeHealthLedger(aiHome, nowMS),
		entities:             entityStore,
		assignments:          assignmentSvc,
		evidence:             evidenceStore,
		geoCache:             geoCache,
		platform:             strings.TrimSpace(opts.Platform),
		ownerPID:             ownerPID,
		systemProxyDetector:  opts.SystemProxyDetector,
		tunDetector:          opts.TUNDetector,
		proxyProbeFunc:       opts.ProxyProbeFunc,
		desktopBridge:        opts.DesktopBridge,
		catalog:              opts.Catalog,
		localGeoHTTPClient:   opts.LocalGeoHTTPClient,
		planInterval:         planInterval,
		geoPerTick:           geoPerTick,
		probesPerTick:        probesPerTick,
		logger:               logger,
		watchers:             make(map[chan WatchEvent]struct{}),
		accountMutMap:        make(map[string]*sync.Mutex),
		desktopOpMap:         make(map[string]*sync.Mutex),
	}

	m.supervisor = newPoolSupervisor(m, opts)
	if rawPIDAlive != nil {
		m.pidAlive = rawPIDAlive
	} else {
		m.pidAlive = func(pid int) bool {
			if m.supervisor != nil && m.supervisor.isTrackedAlivePID(pid) {
				return true
			}
			return DefaultPIDAlive(pid)
		}
	}
	m.supervisor.pidAlive = m.pidAlive
	return m
}

// GetAssignment 返回指定账号的出口池分配投影（兼容层 + 实体存储聚合）。
func (m *Manager) GetAssignment(ctx context.Context, accountRef string) (*AccountEgressAssignment, error) {
	return m.assignments.GetAssignment(ctx, accountRef)
}

func (m *Manager) nowMS() int64 {
	return m.now().UnixMilli()
}

// SubscribeWatch 注册一条 SSE 变更监听流，返回事件通道与取消函数。
func (m *Manager) SubscribeWatch() (<-chan WatchEvent, func()) {
	ch := make(chan WatchEvent, 16)
	m.watchMu.Lock()
	m.watchers[ch] = struct{}{}
	m.watchMu.Unlock()
	cancel := func() {
		m.watchMu.Lock()
		if _, ok := m.watchers[ch]; ok {
			delete(m.watchers, ch)
			close(ch)
		}
		m.watchMu.Unlock()
	}
	return ch, cancel
}

// EmitChanged 向所有活跃的 WebUI 上游监听流广播变更事件。
func (m *Manager) EmitChanged(reason string) {
	evt := WatchEvent{
		Type:   "egress-upstreams-changed",
		Reason: strings.TrimSpace(reason),
		At:     m.nowMS(),
	}
	m.watchMu.Lock()
	defer m.watchMu.Unlock()
	for ch := range m.watchers {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (m *Manager) syncHealthBindingsLocked() error {
	m.syncMu.Lock()
	defer m.syncMu.Unlock()
	m.health.Reload()
	cfg, cfgOK := ReadPoolRuntimeConfig(m.aiHomeDir)
	nodesData, dataErr := ReadProxyPoolData(m.aiHomeDir)
	byIdentity := make(map[string]ProxyNode, len(nodesData.Nodes))
	if dataErr == nil {
		for _, n := range nodesData.Nodes {
			if n.Port <= 0 || !IsRoutableServer(n.Server) || IsInformationalNode(n.Name) {
				continue
			}
			id := BuildExitIdentity(n.Protocol, n.Server, n.Port)
			if id != "" {
				if _, exists := byIdentity[id]; !exists {
					byIdentity[id] = n
				}
			}
		}
	}

	if cfgOK && cfg != nil && len(cfg.Proxies) > 0 {
		entries := make([]RuntimeNodeEntry, 0, len(cfg.Proxies))
		for _, p := range cfg.Proxies {
			entry := RuntimeNodeEntry{
				Name:     p.Name,
				NodeID:   BuildNodeEntityID(p.Type, p.Server, p.Port),
				Identity: BuildExitIdentity(p.Type, p.Server, p.Port),
				Label:    p.Name,
				Protocol: p.Type,
				Server:   p.Server,
				Port:     p.Port,
				Enabled:  true,
			}
			if raw, ok := byIdentity[entry.Identity]; ok {
				if raw.Name != "" {
					entry.Label = raw.Name
				}
				entry.CountryCode = raw.CountryCode
				entry.CountryFlag = raw.CountryFlag
				if raw.LastChecked > 0 || raw.LatencyMS > 0 {
					entry.LibraryProbe = &ProbeFact{
						OK:        raw.LatencyMS > 0,
						LatencyMS: raw.LatencyMS,
						At:        raw.LastChecked,
						Source:    "library",
					}
					if raw.LatencyMS <= 0 {
						entry.LibraryProbe.Error = "library_probe_failed"
					}
				}
				subDisabled := nodesData.DisabledSubs[raw.SubscriptionID]
				entry.Enabled = !subDisabled
			}
			entries = append(entries, entry)
		}
		m.health.BindNamedEntries(entries)
		return nil
	}

	nodes, err := ReadProxyPoolNodes(m.aiHomeDir)
	if err != nil {
		if err.Error() == "egress_pool_no_nodes" || os.IsNotExist(err) {
			m.health.BindNamedEntries(nil)
			return nil
		}
		return err
	}
	entries := make([]RuntimeNodeEntry, 0, len(nodes))
	for _, n := range nodes {
		if n.Port <= 0 || !IsRoutableServer(n.Server) || IsInformationalNode(n.Name) {
			continue
		}
		e := runtimeEntryFromProxy(n.Name, n, true)
		entries = append(entries, e)
	}
	m.health.BindNamedEntries(entries)
	return nil
}

type runtimeSnapshot struct {
	available   bool
	ready       bool
	lastError   string
	state       *PoolStateFile
	cfg         *PoolRuntimeConfig
	proxies     map[string]ControllerProxyInfo
	activeNode  string
	policy      NodePolicy
	snapshots   []NodeSnapshotView
	events      []HealthEvent
	version     string
	plannerNode []PlannerNode
	catalog     []CatalogGroup
	lanes       []LaneView
	overflow    []string
}

func (m *Manager) loadRuntimeSnapshot(ctx context.Context) (*runtimeSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if err := m.syncHealthBindingsLocked(); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	state, liveErr := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state == nil && m.supervisor != nil {
		if supErr := m.supervisor.LastError(); supErr != "" {
			liveErr = supErr
		}
	}
	cfg, cfgOK := ReadPoolRuntimeConfig(m.aiHomeDir)
	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	snapshots, events := m.health.Snapshot(&policy)
	version := NodesVersion(snapshots)

	snap := &runtimeSnapshot{
		available: state != nil || (cfgOK && cfg != nil && len(cfg.Proxies) > 0),
		ready:     state != nil,
		lastError: liveErr,
		state:     state,
		cfg:       cfg,
		policy:    policy,
		snapshots: snapshots,
		events:    events,
		version:   version,
	}

	if snap.ready && state.ControllerPort > 0 && state.Secret != "" {
		ctrl := NewControllerClient(state.ControllerPort, state.Secret, m.httpClient)
		if proxies, err := ctrl.GetProxies(ctx); err == nil {
			snap.proxies = proxies
			if g, ok := proxies["GLOBAL"]; ok {
				snap.activeNode = strings.TrimSpace(g.Now)
			}
		}
	}
	if snap.activeNode == "" && len(snapshots) > 0 {
		snap.activeNode = snapshots[0].Name
	}

	if cat, err := ReadEgressPoolCatalog(m.aiHomeDir); err == nil {
		snap.catalog = cat.Groups
	}
	snap.plannerNode = make([]PlannerNode, 0, len(snapshots))
	for _, s := range snapshots {
		groupSet := make(map[string]bool)
		for _, g := range snap.catalog {
			for _, id := range g.Identities {
				if id == s.Identity {
					groupSet[g.ID] = true
					break
				}
			}
		}
		snap.plannerNode = append(snap.plannerNode, PlannerNode{
			Name:     s.Name,
			NodeID:   s.NodeID,
			Identity: s.Identity,
			Label:    s.Label,
			Geo:      s.Geo,
			Groups:   groupSet,
		})
	}
	snap.lanes, snap.overflow = m.buildLaneViewsLocked(ctx, snap)
	return snap, nil
}

func (m *Manager) buildLaneViewsLocked(ctx context.Context, snap *runtimeSnapshot) ([]LaneView, []string) {
	if snap == nil {
		return []LaneView{}, []string{}
	}
	accounts, _ := ListKnownAccounts(ctx, m.aiHomeDir)
	bindings, _ := ReadAccountEgressBindings(ctx, m.aiHomeDir)
	assignments := m.assignments.ListAssignments(ctx)
	overrides := ReadServerUpstreamOverrides(ctx, m.aiHomeDir)
	blocked := make(map[string]bool, len(snap.snapshots))
	for _, s := range snap.snapshots {
		if s.Blocked {
			blocked[s.Name] = true
		}
	}
	laneSlots := DefaultLaneSlots
	if snap.cfg != nil && len(snap.cfg.LanePorts) > 0 {
		laneSlots = len(snap.cfg.LanePorts)
	}
	planResult := ComputeEgressPlan(ctx, PlanInput{
		AIHomeDir:   m.aiHomeDir,
		Accounts:    accounts,
		Overrides:   overrides,
		Nodes:       snap.plannerNode,
		Catalog:     snap.catalog,
		Blocked:     blocked,
		LaneSlots:   laneSlots,
		Bindings:    bindings,
		Assignments: assignments,
		Evidence:    m.evidence,
		NowMS:       m.nowMS(),
	})

	nodeIDByName := make(map[string]string, len(snap.snapshots))
	for _, s := range snap.snapshots {
		nodeIDByName[s.Name] = s.NodeID
	}

	views := make([]LaneView, 0, len(planResult.Plan))
	var overflow []string
	for idx, spec := range planResult.Plan {
		if idx >= laneSlots {
			overflow = append(overflow, spec.Key)
			continue
		}
		active := ""
		groupName := fmt.Sprintf("LANE-%d", idx)
		if snap.proxies != nil {
			if pInfo, ok := snap.proxies[groupName]; ok {
				active = strings.TrimSpace(pInfo.Now)
			}
		}
		if active == "" && len(spec.Allowed) > 0 {
			active = spec.Allowed[0]
		}
		proxyURL := ""
		if snap.state != nil {
			for _, ref := range spec.Accounts {
				if u := strings.TrimSpace(snap.state.Lanes[ref]); u != "" {
					proxyURL = u
					break
				}
			}
		}
		if proxyURL == "" && snap.cfg != nil {
			if port := snap.cfg.LanePorts[idx]; port > 0 && snap.ready {
				proxyURL = fmt.Sprintf("http://127.0.0.1:%d", port)
			}
		}
		lv := LaneView{
			Index:        idx,
			Key:          spec.Key,
			ProxyURL:     proxyURL,
			ActiveNode:   active,
			ActiveNodeID: nodeIDByName[active],
			AllowedCount: len(spec.Allowed),
			Accounts:     append([]string{}, spec.Accounts...),
			Strategy:     spec.Strategy,
			Upstream:     spec.Upstream,
			Blocked:      spec.BlockedReason,
		}
		if spec.SessionSlot >= 0 {
			slot := spec.SessionSlot
			lv.SessionSlot = &slot
		}
		views = append(views, lv)
	}
	if overflow == nil {
		overflow = []string{}
	}
	return views, overflow
}

// DescribePool 返回 WebUI 出口池面板数据（支持全量与筛选分页两种口径）。
func (m *Manager) DescribePool(ctx context.Context, query PoolQueryOptions) (*PoolDescribeResult, string, error) {
	snap, err := m.loadRuntimeSnapshot(ctx)
	if err != nil {
		return nil, "", err
	}
	nowMS := m.nowMS()
	boundAccounts, _ := ListEgressPoolBoundAccounts(ctx, m.aiHomeDir)
	if boundAccounts == nil {
		boundAccounts = []BoundAccountSummary{}
	}

	if !snap.available {
		return &PoolDescribeResult{
			Available:     false,
			Status:        nil,
			Nodes:         []NodeSnapshotView{},
			Events:        []HealthEvent{},
			NodePolicy:    nil,
			BoundAccounts: boundAccounts,
			ServerTime:    nowMS,
			Version:       "",
		}, "", nil
	}

	activeIndex := -1
	coolingCount := 0
	for idx, n := range snap.snapshots {
		if n.Name == snap.activeNode {
			activeIndex = idx
		}
		if n.Cooling {
			coolingCount++
		}
	}
	proxyURL := ""
	probePort := 0
	if snap.state != nil {
		proxyURL = snap.state.ProxyURL
	}
	laneSlots := DefaultLaneSlots
	if snap.cfg != nil {
		if snap.cfg.ProbePort > 0 {
			probePort = snap.cfg.ProbePort
		}
		if len(snap.cfg.LanePorts) > 0 {
			laneSlots = len(snap.cfg.LanePorts)
		}
		if proxyURL == "" && snap.ready && snap.cfg.MixedPort > 0 {
			proxyURL = fmt.Sprintf("http://127.0.0.1:%d", snap.cfg.MixedPort)
		}
	}

	policySummary := DescribeNodePolicy(snap.policy)
	status := &PoolStatusView{
		Ready:           snap.ready,
		ProxyURL:        proxyURL,
		NodeCount:       len(snap.snapshots),
		ActiveNodeIndex: activeIndex,
		ActiveNode:      snap.activeNode,
		WorkDir:         filepath.Join(m.aiHomeDir, "run", "egress-pool"),
		LastError:       snap.lastError,
		CoolingCount:    coolingCount,
		ProbeIntervalMS: DefaultProbeIntervalMS,
		ProbePort:       probePort,
		LaneSlots:       laneSlots,
		Lanes:           snap.lanes,
		LaneOverflow:    snap.overflow,
	}

	etag := fmt.Sprintf(`W/"%s"`, snap.version)
	if !query.HasPage {
		return &PoolDescribeResult{
			Available:     true,
			Status:        status,
			Nodes:         snap.snapshots,
			Events:        snap.events,
			NodePolicy:    &policySummary,
			BoundAccounts: boundAccounts,
			ServerTime:    nowMS,
			Version:       snap.version,
		}, etag, nil
	}

	counts := CountPoolNodes(snap.snapshots)
	filtered := FilterPoolNodes(snap.snapshots, query.Filter, query.Query)
	sorted := SortPoolNodes(filtered, snap.activeNode)
	paged, pagination := PaginatePoolNodes(sorted, query.Page, query.PageSize)

	return &PoolDescribeResult{
		Available:     true,
		Status:        status,
		Nodes:         paged,
		Events:        snap.events,
		NodePolicy:    &policySummary,
		NodeCounts:    &counts,
		Pagination:    &pagination,
		BoundAccounts: boundAccounts,
		ServerTime:    nowMS,
		Version:       snap.version,
	}, etag, nil
}

func matchesPoolFilter(node NodeSnapshotView, filter string) bool {
	switch filter {
	case "blocked":
		return node.Blocked
	case "cooling":
		return node.Cooling
	case "healthy":
		probeFailed := node.Probe != nil && !node.Probe.OK
		return !node.Blocked && !node.Cooling && !probeFailed
	case "used":
		return node.Uses > 0
	default:
		return true
	}
}

// FilterPoolNodes 按类别和关键字筛选节点。
func FilterPoolNodes(nodes []NodeSnapshotView, filter string, query string) []NodeSnapshotView {
	needle := strings.ToLower(strings.TrimSpace(query))
	out := make([]NodeSnapshotView, 0, len(nodes))
	for _, node := range nodes {
		if !matchesPoolFilter(node, filter) {
			continue
		}
		if needle != "" {
			text := strings.ToLower(node.Name + " " + node.Label + " " + node.Server)
			if !strings.Contains(text, needle) {
				continue
			}
		}
		out = append(out, node)
	}
	return out
}

// SortPoolNodes 按与 Node/WebUI 完全一致的顺序排列：当前出口置顶 -> 冷却中 -> 冷却剩余最短 -> 最近使用。
func SortPoolNodes(nodes []NodeSnapshotView, activeNode string) []NodeSnapshotView {
	active := strings.TrimSpace(activeNode)
	out := make([]NodeSnapshotView, len(nodes))
	copy(out, nodes)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Name == active && b.Name != active {
			return true
		}
		if b.Name == active && a.Name != active {
			return false
		}
		if a.Cooling != b.Cooling {
			return a.Cooling
		}
		if a.Cooling && b.Cooling && a.CooldownRemainingMS != b.CooldownRemainingMS {
			return a.CooldownRemainingMS < b.CooldownRemainingMS
		}
		return b.LastUsedAt < a.LastUsedAt
	})
	return out
}

// CountPoolNodes 一次遍历计算各筛选分类总数。
func CountPoolNodes(nodes []NodeSnapshotView) PoolNodeCounts {
	counts := PoolNodeCounts{All: len(nodes)}
	for _, n := range nodes {
		if n.Blocked {
			counts.Blocked++
		}
		if n.Cooling {
			counts.Cooling++
		}
		if matchesPoolFilter(n, "healthy") {
			counts.Healthy++
		}
		if n.Uses > 0 {
			counts.Used++
		}
	}
	return counts
}

// PaginatePoolNodes 对节点切片执行边界保护的分页切片。
func PaginatePoolNodes(nodes []NodeSnapshotView, page int, pageSize int) ([]NodeSnapshotView, PoolPagination) {
	size := pageSize
	if size <= 0 {
		size = 50
	}
	if size > 500 {
		size = 500
	}
	total := len(nodes)
	pageCount := 1
	if total > 0 {
		pageCount = (total + size - 1) / size
	}
	safePage := page
	if safePage < 1 {
		safePage = 1
	}
	if safePage > pageCount {
		safePage = pageCount
	}
	start := (safePage - 1) * size
	if start > total {
		start = total
	}
	end := start + size
	if end > total {
		end = total
	}
	paged := make([]NodeSnapshotView, end-start)
	copy(paged, nodes[start:end])
	return paged, PoolPagination{
		Page:      safePage,
		PageSize:  size,
		Total:     total,
		PageCount: pageCount,
	}
}

// ProbePoolNodes 立即探测指定节点或全部节点。
func (m *Manager) ProbePoolNodes(ctx context.Context, nodeName string) PoolActionResult {
	target := strings.TrimSpace(nodeName)
	if _, _, err := m.resolveProbeEndpoint(ctx); err != nil {
		return PoolActionResult{OK: false, Error: "egress_pool_not_ready"}
	}
	if err := m.syncHealthBindingsLocked(); err != nil {
		return PoolActionResult{OK: false, Error: "egress_pool_not_ready"}
	}
	if target != "" {
		outcome := m.ProbeNode(ctx, target)
		if outcome.Error == "egress_pool_node_unknown" || outcome.Error == "egress_pool_not_ready" {
			return PoolActionResult{OK: false, Error: outcome.Error}
		}
		return PoolActionResult{OK: true, Results: []NodeProbeOutcome{outcome}}
	}

	entries := m.health.Nodes()
	results := make([]NodeProbeOutcome, len(entries))
	if len(entries) == 0 {
		return PoolActionResult{OK: true, Results: results}
	}
	workers := DefaultProbeConcurrency
	if len(entries) < workers {
		workers = len(entries)
	}
	jobs := make(chan int, len(entries))
	for i := range entries {
		jobs <- i
	}
	close(jobs)

	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for idx := range jobs {
				results[idx] = m.ProbeNode(ctx, entries[idx].Name)
			}
		}()
	}
	wg.Wait()
	return PoolActionResult{OK: true, Results: results}
}

// SelectPoolNode 切换 GLOBAL 组到指定节点。
func (m *Manager) SelectPoolNode(ctx context.Context, nodeName string) PoolActionResult {
	target := strings.TrimSpace(nodeName)
	ctrl, _, err := m.resolveProbeEndpoint(ctx)
	if err != nil {
		return PoolActionResult{OK: false, Error: "egress_pool_not_ready"}
	}
	if err := m.syncHealthBindingsLocked(); err != nil {
		return PoolActionResult{OK: false, Error: "egress_pool_not_ready"}
	}
	if _, ok := m.health.NodeInfo(target); !ok {
		return PoolActionResult{OK: false, Error: "egress_pool_select_failed"}
	}
	previous := ""
	if proxies, err := ctrl.GetProxies(ctx); err == nil {
		previous = strings.TrimSpace(proxies["GLOBAL"].Now)
	}
	if err := ctrl.SelectProxy(ctx, "GLOBAL", target); err != nil {
		return PoolActionResult{OK: false, Error: "egress_pool_select_failed"}
	}
	if previous != target {
		m.health.PushEvent(HealthEvent{
			At:     m.nowMS(),
			Type:   "switch",
			From:   previous,
			Node:   target,
			Reason: "select",
		})
		_ = m.health.Save()
	}
	return PoolActionResult{OK: true, Node: target}
}

// ClearPoolNodeCooldown 人工解除指定节点冷却。
func (m *Manager) ClearPoolNodeCooldown(ctx context.Context, nodeName string) PoolActionResult {
	target := strings.TrimSpace(nodeName)
	if target == "" {
		return PoolActionResult{OK: false, Error: "egress_pool_node_unknown"}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_ = m.syncHealthBindingsLocked()
	if !m.health.ClearCooldown(target) {
		return PoolActionResult{OK: false, Error: "egress_pool_node_unknown"}
	}
	_ = m.health.Save()
	return PoolActionResult{OK: true}
}

// SetPoolNodeBlocked 手动关闭或放行指定节点（按出口身份持久化，并同步重算车道）。
func (m *Manager) SetPoolNodeBlocked(ctx context.Context, nodeName string, blocked bool, reason string) PoolActionResult {
	target := strings.TrimSpace(nodeName)
	m.mu.Lock()
	_ = m.syncHealthBindingsLocked()
	info, ok := m.health.NodeInfo(target)
	if !ok {
		m.mu.Unlock()
		return PoolActionResult{OK: false, Error: "egress_pool_node_unknown"}
	}
	updated, err := SetNodeDisabled(ctx, m.aiHomeDir, info.Identity, blocked, info.Label, reason, m.nowMS())
	if err != nil {
		m.mu.Unlock()
		return PoolActionResult{OK: false, Error: err.Error()}
	}
	evtType := "node_unblocked"
	if blocked {
		evtType = "node_blocked"
	}
	m.health.PushEvent(HealthEvent{
		At:     m.nowMS(),
		Type:   evtType,
		Node:   target,
		Reason: strings.TrimSpace(reason),
	})
	_ = m.health.Save()
	m.mu.Unlock()

	_ = m.ReconcileLanes(ctx)
	m.EmitChanged("node-policy")
	summary := DescribeNodePolicy(updated)
	b := blocked
	return PoolActionResult{OK: true, Blocked: &b, NodePolicy: &summary}
}

// ReadNodePolicySummary 读取节点拦截策略摘要。
func (m *Manager) ReadNodePolicySummary(ctx context.Context) NodePolicySummary {
	return DescribeNodePolicy(ReadNodePolicy(ctx, m.aiHomeDir))
}

// UpdateNodePolicy 更新节点拦截策略。
func (m *Manager) UpdateNodePolicy(ctx context.Context, patch NodePolicyPatch) PoolActionResult {
	updated, err := WriteNodePolicy(ctx, m.aiHomeDir, patch, m.nowMS())
	if err != nil {
		return PoolActionResult{OK: false, Error: err.Error()}
	}
	_ = m.ReconcileLanes(ctx)
	m.EmitChanged("node-policy")
	summary := DescribeNodePolicy(updated)
	return PoolActionResult{OK: true, NodePolicy: &summary}
}

// ClearDisabledNodePolicy 清空手动关闭节点记录。
func (m *Manager) ClearDisabledNodePolicy(ctx context.Context) PoolActionResult {
	removed, updated, err := ClearDisabledNodes(ctx, m.aiHomeDir, m.nowMS())
	if err != nil {
		return PoolActionResult{OK: false, Error: err.Error()}
	}
	_ = m.ReconcileLanes(ctx)
	m.EmitChanged("node-policy")
	summary := DescribeNodePolicy(updated)
	return PoolActionResult{OK: true, Removed: &removed, NodePolicy: &summary}
}

// ListPoolGroupsTree 返回「节点池组 → 节点池 → 节点」三层只读视图。
func (m *Manager) ListPoolGroupsTree(ctx context.Context) []ResourceGroupView {
	snap, err := m.loadRuntimeSnapshot(ctx)
	var snapshots []NodeSnapshotView
	if err == nil && snap != nil {
		snapshots = snap.snapshots
	}
	assignments := m.assignments.ListAssignments(ctx)
	return BuildResourceTreeView(ctx, m.entities, assignments, snapshots)
}

// ListPoolsView 返回全部代理池视图。
func (m *Manager) ListPoolsView(ctx context.Context) []ResourcePoolView {
	groups := m.ListPoolGroupsTree(ctx)
	var pools []ResourcePoolView
	for _, g := range groups {
		pools = append(pools, g.Pools...)
	}
	if pools == nil {
		return []ResourcePoolView{}
	}
	return pools
}

// GetPoolView 返回单个代理池视图。
func (m *Manager) GetPoolView(ctx context.Context, poolID string) (*ResourcePoolView, bool) {
	id := strings.TrimSpace(poolID)
	for _, p := range m.ListPoolsView(ctx) {
		if p.PoolID == id {
			copyP := p
			return &copyP, true
		}
	}
	return nil, false
}

// GetNodeView 返回单个节点视图。
func (m *Manager) GetNodeView(ctx context.Context, nodeID string) (*ResourceNodeView, bool) {
	id := strings.TrimSpace(nodeID)
	for _, p := range m.ListPoolsView(ctx) {
		for _, n := range p.Nodes {
			if n.NodeID == id {
				copyN := n
				return &copyN, true
			}
		}
	}
	return nil, false
}

// BuildDiagnosticView 返回限定范围内的实测诊断视图。
func (m *Manager) BuildDiagnosticView(ctx context.Context, query AccountDiagnosticQuery) AccountDiagnosticView {
	return BuildAccountDiagnosticView(ctx, m.evidence, query)
}

// ReconcileLanes 根据最新绑定与策略重新计算车道；若本地 mihomo 控制面存活，则即时同步各车道选择与 state.json。
func (m *Manager) ReconcileLanes(ctx context.Context) error {
	m.reconcileMu.Lock()
	defer m.reconcileMu.Unlock()
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	cfg, cfgOK := ReadPoolRuntimeConfig(m.aiHomeDir)
	if state == nil || !cfgOK || cfg == nil {
		return nil
	}
	ctrl := NewControllerClient(state.ControllerPort, state.Secret, m.httpClient)
	proxies, err := ctrl.GetProxies(ctx)
	if err != nil {
		return nil
	}
	_ = m.syncHealthBindingsLocked()
	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	snapshots, _ := m.health.Snapshot(&policy)
	blocked := make(map[string]bool, len(snapshots))
	for _, s := range snapshots {
		if s.Blocked {
			blocked[s.Name] = true
		}
	}
	cat, _ := ReadEgressPoolCatalog(m.aiHomeDir)
	pNodes := make([]PlannerNode, 0, len(snapshots))
	for _, s := range snapshots {
		groupSet := make(map[string]bool)
		for _, g := range cat.Groups {
			for _, id := range g.Identities {
				if id == s.Identity {
					groupSet[g.ID] = true
					break
				}
			}
		}
		pNodes = append(pNodes, PlannerNode{
			Name:     s.Name,
			NodeID:   s.NodeID,
			Identity: s.Identity,
			Label:    s.Label,
			Geo:      s.Geo,
			Groups:   groupSet,
		})
	}
	accounts, _ := ListKnownAccounts(ctx, m.aiHomeDir)
	bindings, _ := ReadAccountEgressBindings(ctx, m.aiHomeDir)
	assignments := m.assignments.ListAssignments(ctx)
	overrides := ReadServerUpstreamOverrides(ctx, m.aiHomeDir)
	laneSlots := len(cfg.LanePorts)
	if laneSlots <= 0 {
		laneSlots = DefaultLaneSlots
	}

	planResult := ComputeEgressPlan(ctx, PlanInput{
		AIHomeDir:   m.aiHomeDir,
		Accounts:    accounts,
		Overrides:   overrides,
		Nodes:       pNodes,
		Catalog:     cat.Groups,
		Blocked:     blocked,
		LaneSlots:   laneSlots,
		Bindings:    bindings,
		Assignments: assignments,
		Evidence:    m.evidence,
		NowMS:       m.nowMS(),
	})

	nextLanes := make(map[string]string)
	nextSessionLanes := make(map[string][]string)
	selectedByAvoid := make(map[string]map[string]bool)
	atMS := m.nowMS()

	for idx, spec := range planResult.Plan {
		if idx >= laneSlots {
			break
		}
		port := cfg.LanePorts[idx]
		groupName := fmt.Sprintf("LANE-%d", idx)
		currentActive := strings.TrimSpace(proxies[groupName].Now)
		allowedSet := make(map[string]bool, len(spec.Allowed))
		for _, n := range spec.Allowed {
			allowedSet[n] = true
		}
		chosen := ""
		if currentActive != "" && allowedSet[currentActive] && !m.health.IsCooling(currentActive, atMS) && !blocked[currentActive] {
			chosen = currentActive
		} else {
			avoidSet := selectedByAvoid[spec.AvoidGroup]
			picked := m.health.PickNext(-1, allowedSet, avoidSet, &policy, atMS)
			if picked >= 0 {
				nodes := m.health.Nodes()
				if picked < len(nodes) {
					chosen = nodes[picked].Name
					_ = ctrl.SelectProxy(ctx, groupName, chosen)
				}
			}
		}
		if chosen != "" && spec.AvoidGroup != "" {
			if selectedByAvoid[spec.AvoidGroup] == nil {
				selectedByAvoid[spec.AvoidGroup] = make(map[string]bool)
			}
			selectedByAvoid[spec.AvoidGroup][chosen] = true
		}
		laneURL := ""
		if port > 0 && len(spec.Allowed) > 0 && chosen != "" {
			laneURL = fmt.Sprintf("http://127.0.0.1:%d", port)
		}
		if spec.SessionSlot >= 0 {
			for _, ref := range spec.Accounts {
				if spec.SessionSlot == 0 {
					nextLanes[ref] = laneURL
				}
				if laneURL != "" {
					nextSessionLanes[ref] = append(nextSessionLanes[ref], laneURL)
				}
			}
		} else {
			for _, ref := range spec.Accounts {
				nextLanes[ref] = laneURL
			}
		}
	}

	state.Lanes = nextLanes
	state.SessionLanes = nextSessionLanes
	if data, err := json.MarshalIndent(state, "", "  "); err == nil {
		_ = writeStateFileAtomic(m.aiHomeDir, append(data, '\n'))
	}
	return nil
}

func writeStateFileAtomic(aiHomeDir string, data []byte) error {
	p := filepath.Join(strings.TrimSpace(aiHomeDir), "run", "egress-pool", "state.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.%d.%s", p, os.Getpid(), strconv.FormatInt(time.Now().UnixNano(), 36))
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
