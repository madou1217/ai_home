package egress

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	healthFileName        = "node-health.json"
	healthFileVersion     = 1
	maxAccountsPerNode    = 20
	defaultEventHistory   = 200
	legacyIPBlockedKind   = "ip_blocked"
	freeLimitCooldownMS   = 15 * 60 * 1000
	gateCooldownMS        = 2 * 60 * 1000
	networkCooldownMS     = 60 * 1000
	maxNodeCooldownMS     = 30 * 60 * 1000
)

var failureKindCooldowns = map[string]int64{
	"free_limit": freeLimitCooldownMS,
	"gate":       gateCooldownMS,
	"network":    networkCooldownMS,
}

// AccountUsageRecord 记录单个账号通过某节点出网的计数与最后使用时间。
type AccountUsageRecord struct {
	Uses       int64 `json:"uses"`
	LastUsedAt int64 `json:"lastUsedAt"`
}

// AccountUsageSummary 用于前端展示某节点绑定的账号使用摘要。
type AccountUsageSummary struct {
	AccountRef string `json:"accountRef"`
	Uses       int64  `json:"uses"`
	LastUsedAt int64  `json:"lastUsedAt"`
}

// NodeHealthStats 存储单个出口身份在 node-health.json 中的原始统计和状态。
type NodeHealthStats struct {
	Uses                int64                         `json:"uses"`
	Successes           int64                         `json:"successes"`
	Failures            int64                         `json:"failures"`
	FailuresByKind      map[string]int64              `json:"failuresByKind"`
	ConsecutiveFailures int64                         `json:"consecutiveFailures"`
	LastUsedAt          int64                         `json:"lastUsedAt"`
	LastSuccessAt       int64                         `json:"lastSuccessAt"`
	LastFailureAt       int64                         `json:"lastFailureAt"`
	LastFailureKind     string                        `json:"lastFailureKind"`
	CooldownUntil       int64                         `json:"cooldownUntil"`
	CooldownKind        string                        `json:"cooldownKind"`
	LegacyCooldownKind  string                        `json:"legacyCooldownKind,omitempty"`
	LegacyCooldownUntil int64                         `json:"legacyCooldownUntil,omitempty"`
	Probe               *ProbeFact                    `json:"probe"`
	Geo                 *GeoLocation                  `json:"geo"`
	Accounts            map[string]AccountUsageRecord `json:"accounts"`
}

// HealthEvent 记录切换、冷却、恢复或拦截事件流条目。
type HealthEvent struct {
	At         int64  `json:"at"`
	Type       string `json:"type"`
	Node       string `json:"node,omitempty"`
	From       string `json:"from,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Reason     string `json:"reason,omitempty"`
	CooldownMS int64  `json:"cooldownMs,omitempty"`
	LatencyMS  int64  `json:"latencyMs,omitempty"`
	AccountRef string `json:"accountRef,omitempty"`
	Model      string `json:"model,omitempty"`
}

// RuntimeNodeEntry 描述绑定进账本的一条运行节点元信息（不含凭据）。
type RuntimeNodeEntry struct {
	Name         string
	NodeID       string
	Identity     string
	Label        string
	Protocol     string
	Server       string
	Port         int
	CountryCode  string
	CountryFlag  string
	Enabled      bool
	LibraryProbe *ProbeFact
}

// NodeSnapshotView 是提供给 WebUI 出口池面板的完整单节点视图。
type NodeSnapshotView struct {
	Name                string                `json:"name"`
	NodeID              string                `json:"nodeId"`
	Identity            string                `json:"identity"`
	Label               string                `json:"label"`
	Protocol            string                `json:"protocol"`
	Server              string                `json:"server"`
	Port                int                   `json:"port"`
	CountryCode         string                `json:"countryCode"`
	CountryFlag         string                `json:"countryFlag"`
	Enabled             bool                  `json:"enabled"`
	Uses                int64                 `json:"uses"`
	Successes           int64                 `json:"successes"`
	Failures            int64                 `json:"failures"`
	FailuresByKind      map[string]int64      `json:"failuresByKind"`
	ConsecutiveFailures int64                 `json:"consecutiveFailures"`
	LastUsedAt          int64                 `json:"lastUsedAt"`
	LastSuccessAt       int64                 `json:"lastSuccessAt"`
	LastFailureAt       int64                 `json:"lastFailureAt"`
	LastFailureKind     string                `json:"lastFailureKind"`
	Cooling             bool                  `json:"cooling"`
	CooldownUntil       int64                 `json:"cooldownUntil"`
	CooldownKind        string                `json:"cooldownKind"`
	CooldownRemainingMS int64                 `json:"cooldownRemainingMs"`
	Blocked             bool                  `json:"blocked"`
	BlockedReason       string                `json:"blockedReason"`
	BlockedDetail       string                `json:"blockedDetail"`
	Probe               *ProbeFact            `json:"probe"`
	Geo                 *GeoLocation          `json:"geo"`
	Accounts            []AccountUsageSummary `json:"accounts"`
}

type nodeHealthDocument struct {
	Version int                         `json:"version"`
	Nodes   map[string]*NodeHealthStats `json:"nodes"`
	Events  []HealthEvent               `json:"events"`
}

// NodeHealthLedger 管理 <aiHomeDir>/run/egress-pool/node-health.json 账本读写与状态推演。
type NodeHealthLedger struct {
	mu         sync.Mutex
	aiHomeDir  string
	eventLimit int
	now        func() int64
	byIdentity map[string]*NodeHealthStats
	nodes      []RuntimeNodeEntry
	events     []HealthEvent
}

// NodeHealthFilePath 返回节点健康账本文件路径。
func NodeHealthFilePath(aiHomeDir string) string {
	trimmed := strings.TrimSpace(aiHomeDir)
	if trimmed == "" {
		return ""
	}
	return filepath.Join(trimmed, "run", "egress-pool", healthFileName)
}

func emptyNodeHealthStats() *NodeHealthStats {
	return &NodeHealthStats{
		FailuresByKind: map[string]int64{},
		Accounts:       map[string]AccountUsageRecord{},
	}
}

func cloneStats(src *NodeHealthStats) *NodeHealthStats {
	if src == nil {
		return emptyNodeHealthStats()
	}
	out := *src
	out.FailuresByKind = make(map[string]int64, len(src.FailuresByKind))
	for k, v := range src.FailuresByKind {
		out.FailuresByKind[k] = v
	}
	out.Accounts = make(map[string]AccountUsageRecord, len(src.Accounts))
	for k, v := range src.Accounts {
		out.Accounts[k] = v
	}
	if src.Probe != nil {
		p := *src.Probe
		out.Probe = &p
	}
	if src.Geo != nil {
		g := *src.Geo
		out.Geo = &g
	}
	return &out
}

// LoadNodeHealthLedger 从磁盘加载节点健康账本，文件缺失或损坏时安全回落为空账本。
func LoadNodeHealthLedger(aiHomeDir string, nowFn func() int64) *NodeHealthLedger {
	if nowFn == nil {
		nowFn = currentUnixMS
	}
	ledger := &NodeHealthLedger{
		aiHomeDir:  strings.TrimSpace(aiHomeDir),
		eventLimit: defaultEventHistory,
		now:        nowFn,
		byIdentity: make(map[string]*NodeHealthStats),
	}
	ledger.Reload()
	return ledger
}

// Reload 重新从 node-health.json 载入节点账本并清理已废弃的 ip_blocked 冷却类别。
func (l *NodeHealthLedger) Reload() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.byIdentity = make(map[string]*NodeHealthStats)
	l.events = nil
	filePath := NodeHealthFilePath(l.aiHomeDir)
	if filePath == "" {
		return
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return
	}
	var doc nodeHealthDocument
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Version != healthFileVersion {
		return
	}
	for identity, stats := range doc.Nodes {
		if strings.TrimSpace(identity) == "" || stats == nil {
			continue
		}
		normalized := normalizeHealthStats(stats)
		l.byIdentity[identity] = normalized
	}
	if len(doc.Events) > l.eventLimit {
		l.events = append([]HealthEvent(nil), doc.Events[len(doc.Events)-l.eventLimit:]...)
	} else {
		l.events = append([]HealthEvent(nil), doc.Events...)
	}
}

func normalizeHealthStats(stats *NodeHealthStats) *NodeHealthStats {
	out := emptyNodeHealthStats()
	if stats == nil {
		return out
	}
	*out = *stats
	if out.FailuresByKind == nil {
		out.FailuresByKind = map[string]int64{}
	}
	if out.Accounts == nil {
		out.Accounts = map[string]AccountUsageRecord{}
	}
	if out.CooldownKind == legacyIPBlockedKind {
		out.LegacyCooldownKind = legacyIPBlockedKind
		out.LegacyCooldownUntil = out.CooldownUntil
		out.CooldownKind = ""
		out.CooldownUntil = 0
	}
	return out
}

// BindNodes 绑定运行节点清单并对齐账本桶。
func (l *NodeHealthLedger) BindNodes(nodes []ProxyNode) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entries := make([]RuntimeNodeEntry, 0, len(nodes))
	for i, node := range nodes {
		name := fmt.Sprintf("node-%d", i)
		entries = append(entries, runtimeEntryFromProxy(name, node, true))
	}
	l.bindEntriesLocked(entries)
}

// BindNamedEntries 按指定节点名（例如来自 mihomo config/proxies）绑定运行节点条目。
func (l *NodeHealthLedger) BindNamedEntries(entries []RuntimeNodeEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.bindEntriesLocked(entries)
}

func (l *NodeHealthLedger) bindEntriesLocked(entries []RuntimeNodeEntry) {
	bound := make([]RuntimeNodeEntry, 0, len(entries))
	for _, entry := range entries {
		identity := strings.TrimSpace(entry.Identity)
		if identity == "" {
			identity = BuildExitIdentity(entry.Protocol, entry.Server, entry.Port)
		}
		if identity == "" && entry.Name != "" {
			identity = "name|" + entry.Name
		}
		nodeID := strings.TrimSpace(entry.NodeID)
		if nodeID == "" {
			nodeID = BuildNodeEntityID(entry.Protocol, entry.Server, entry.Port)
		}
		label := strings.TrimSpace(entry.Label)
		if label == "" {
			label = entry.Name
		}
		entry.Identity = identity
		entry.NodeID = nodeID
		entry.Label = label
		if _, exists := l.byIdentity[identity]; !exists && identity != "" {
			l.byIdentity[identity] = emptyNodeHealthStats()
		}
		bound = append(bound, entry)
	}
	l.nodes = bound
}

func runtimeEntryFromProxy(name string, node ProxyNode, enabled bool) RuntimeNodeEntry {
	var libProbe *ProbeFact
	if node.LatencyMS > 0 {
		libProbe = &ProbeFact{
			OK:        true,
			LatencyMS: node.LatencyMS,
			At:        node.LastChecked,
			Source:    "library",
		}
	}
	label := strings.TrimSpace(node.Name)
	if label == "" {
		label = name
	}
	return RuntimeNodeEntry{
		Name:         name,
		NodeID:       BuildNodeEntityID(node.Protocol, node.Server, node.Port),
		Identity:     BuildExitIdentity(node.Protocol, node.Server, node.Port),
		Label:        label,
		Protocol:     NormalizeProtocol(node.Protocol),
		Server:       strings.TrimSpace(node.Server),
		Port:         node.Port,
		CountryCode:  strings.TrimSpace(node.CountryCode),
		CountryFlag:  strings.TrimSpace(node.CountryFlag),
		Enabled:      enabled,
		LibraryProbe: libProbe,
	}
}

func (l *NodeHealthLedger) entryByNameLocked(name string) (RuntimeNodeEntry, bool) {
	for _, entry := range l.nodes {
		if entry.Name == name {
			return entry, true
		}
	}
	return RuntimeNodeEntry{}, false
}

// IdentityOf 返回节点名对应的稳定出口身份。
func (l *NodeHealthLedger) IdentityOf(name string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if entry, ok := l.entryByNameLocked(name); ok {
		return entry.Identity
	}
	return ""
}

// NodeInfo 返回节点运行信息副本。
func (l *NodeHealthLedger) NodeInfo(name string) (RuntimeNodeEntry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.entryByNameLocked(name)
}

// RecordProbe 写入单次探测结果，若网络类冷却中的节点恢复成功则自动解除冷却并写盘。
func (l *NodeHealthLedger) RecordProbe(name string, ok bool, latencyMS int64, probeErr string, reportFailure bool) {
	l.mu.Lock()
	entry, found := l.entryByNameLocked(name)
	if !found {
		l.mu.Unlock()
		return
	}
	stats := l.byIdentity[entry.Identity]
	if stats == nil {
		stats = emptyNodeHealthStats()
		l.byIdentity[entry.Identity] = stats
	}
	at := l.now()
	lat := latencyMS
	errText := strings.TrimSpace(probeErr)
	if ok {
		errText = ""
	} else {
		lat = 0
	}
	stats.Probe = &ProbeFact{
		OK:        ok,
		LatencyMS: lat,
		At:        at,
		Error:     errText,
	}
	if ok && stats.CooldownUntil > at && stats.CooldownKind == "network" {
		stats.CooldownUntil = 0
		stats.CooldownKind = ""
		stats.ConsecutiveFailures = 0
		l.pushEventLocked(HealthEvent{Type: "recovered", Node: name, Reason: "probe_ok", LatencyMS: lat})
	} else if !ok && reportFailure {
		l.pushEventLocked(HealthEvent{Type: "probe_failed", Node: name, Reason: errText})
	}
	l.mu.Unlock()
	_ = l.Save()
}

// RecordGeo 记录并持久化节点的真实出口地理位置。
func (l *NodeHealthLedger) RecordGeo(name string, geo GeoLocation) {
	if strings.TrimSpace(geo.Country) == "" {
		return
	}
	l.mu.Lock()
	entry, found := l.entryByNameLocked(name)
	if !found {
		l.mu.Unlock()
		return
	}
	stats := l.byIdentity[entry.Identity]
	if stats == nil {
		stats = emptyNodeHealthStats()
		l.byIdentity[entry.Identity] = stats
	}
	at := geo.At
	if at <= 0 {
		at = l.now()
	}
	stats.Geo = &GeoLocation{
		Country: strings.ToUpper(strings.TrimSpace(geo.Country)),
		Region:  strings.TrimSpace(geo.Region),
		City:    strings.TrimSpace(geo.City),
		ASN:     strings.TrimSpace(geo.ASN),
		Org:     strings.TrimSpace(geo.Org),
		IP:      strings.TrimSpace(geo.IP),
		Source:  strings.TrimSpace(geo.Source),
		At:      at,
	}
	l.mu.Unlock()
	_ = l.Save()
}

// GeoOf 返回节点缓存的位置信息，未查过返回 nil。
func (l *NodeHealthLedger) GeoOf(name string) *GeoLocation {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry, found := l.entryByNameLocked(name)
	if !found {
		return nil
	}
	stats := l.byIdentity[entry.Identity]
	if stats == nil || stats.Geo == nil {
		return nil
	}
	g := *stats.Geo
	return &g
}

// ClearCooldown 人工解除指定节点冷却并写盘。
func (l *NodeHealthLedger) ClearCooldown(name string) bool {
	l.mu.Lock()
	entry, found := l.entryByNameLocked(name)
	if !found {
		l.mu.Unlock()
		return false
	}
	stats := l.byIdentity[entry.Identity]
	if stats == nil {
		stats = emptyNodeHealthStats()
		l.byIdentity[entry.Identity] = stats
	}
	stats.CooldownUntil = 0
	stats.CooldownKind = ""
	stats.ConsecutiveFailures = 0
	l.pushEventLocked(HealthEvent{Type: "recovered", Node: name, Reason: "manual"})
	l.mu.Unlock()
	_ = l.Save()
	return true
}

// PushEvent 追加并持久化一条节点事件（例如 switch/blocked/unblocked）。
func (l *NodeHealthLedger) PushEvent(event HealthEvent) {
	l.mu.Lock()
	l.pushEventLocked(event)
	l.mu.Unlock()
	_ = l.Save()
}

func (l *NodeHealthLedger) pushEventLocked(event HealthEvent) {
	if event.At <= 0 {
		event.At = l.now()
	}
	l.events = append(l.events, event)
	if len(l.events) > l.eventLimit {
		l.events = append([]HealthEvent(nil), l.events[len(l.events)-l.eventLimit:]...)
	}
}

// Snapshot 生成所有运行节点的视图与逆序事件流。
func (l *NodeHealthLedger) Snapshot(policy *NodePolicy) ([]NodeSnapshotView, []HealthEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	at := l.now()
	nodes := make([]NodeSnapshotView, 0, len(l.nodes))
	for _, entry := range l.nodes {
		stats := l.byIdentity[entry.Identity]
		if stats == nil {
			stats = emptyNodeHealthStats()
		}
		cooling := stats.CooldownKind != legacyIPBlockedKind && stats.CooldownUntil > at
		cooldownUntil := int64(0)
		cooldownKind := ""
		cooldownRemaining := int64(0)
		if cooling {
			cooldownUntil = stats.CooldownUntil
			cooldownKind = stats.CooldownKind
			cooldownRemaining = stats.CooldownUntil - at
		}
		effectiveProbe := stats.Probe
		if effectiveProbe == nil {
			effectiveProbe = entry.LibraryProbe
		}
		var decision NodeDecision
		if policy != nil {
			decision = DecideNode(*policy, entry.Identity, effectiveProbe)
		}
		var outProbe *ProbeFact
		if stats.Probe != nil {
			copied := *stats.Probe
			copied.Source = "core"
			outProbe = &copied
		} else if entry.LibraryProbe != nil {
			copied := *entry.LibraryProbe
			outProbe = &copied
		}
		var outGeo *GeoLocation
		if stats.Geo != nil {
			copied := *stats.Geo
			outGeo = &copied
		}
		failMap := make(map[string]int64, len(stats.FailuresByKind))
		for k, v := range stats.FailuresByKind {
			failMap[k] = v
		}
		accounts := make([]AccountUsageSummary, 0, len(stats.Accounts))
		for ref, rec := range stats.Accounts {
			accounts = append(accounts, AccountUsageSummary{
				AccountRef: ref,
				Uses:       rec.Uses,
				LastUsedAt: rec.LastUsedAt,
			})
		}
		sort.Slice(accounts, func(i, j int) bool {
			if accounts[i].LastUsedAt != accounts[j].LastUsedAt {
				return accounts[i].LastUsedAt > accounts[j].LastUsedAt
			}
			return accounts[i].AccountRef < accounts[j].AccountRef
		})
		nodes = append(nodes, NodeSnapshotView{
			Name:                entry.Name,
			NodeID:              entry.NodeID,
			Identity:            entry.Identity,
			Label:               entry.Label,
			Protocol:            entry.Protocol,
			Server:              entry.Server,
			Port:                entry.Port,
			CountryCode:         entry.CountryCode,
			CountryFlag:         entry.CountryFlag,
			Enabled:             entry.Enabled,
			Uses:                stats.Uses,
			Successes:           stats.Successes,
			Failures:            stats.Failures,
			FailuresByKind:      failMap,
			ConsecutiveFailures: stats.ConsecutiveFailures,
			LastUsedAt:          stats.LastUsedAt,
			LastSuccessAt:       stats.LastSuccessAt,
			LastFailureAt:       stats.LastFailureAt,
			LastFailureKind:     stats.LastFailureKind,
			Cooling:             cooling,
			CooldownUntil:       cooldownUntil,
			CooldownKind:        cooldownKind,
			CooldownRemainingMS: cooldownRemaining,
			Blocked:             decision.Status == "blocked",
			BlockedReason:       blockedOrEmpty(decision),
			BlockedDetail:       blockedDetailOrEmpty(decision),
			Probe:               outProbe,
			Geo:                 outGeo,
			Accounts:            accounts,
		})
	}
	reversed := make([]HealthEvent, len(l.events))
	for i := range l.events {
		reversed[i] = l.events[len(l.events)-1-i]
	}
	return nodes, reversed
}

func blockedOrEmpty(decision NodeDecision) string {
	if decision.Status == "blocked" {
		return decision.Reason
	}
	return ""
}

func blockedDetailOrEmpty(decision NodeDecision) string {
	if decision.Status == "blocked" {
		return decision.Detail
	}
	return ""
}

// Save 原子持久化 node-health.json（目录 0700、文件 0600）。
func (l *NodeHealthLedger) Save() error {
	filePath := NodeHealthFilePath(l.aiHomeDir)
	if filePath == "" {
		return nil
	}
	l.mu.Lock()
	nodesCopy := make(map[string]*NodeHealthStats, len(l.byIdentity))
	for k, v := range l.byIdentity {
		nodesCopy[k] = cloneStats(v)
	}
	eventsCopy := append([]HealthEvent(nil), l.events...)
	if eventsCopy == nil {
		eventsCopy = []HealthEvent{}
	}
	doc := nodeHealthDocument{
		Version: healthFileVersion,
		Nodes:   nodesCopy,
		Events:  eventsCopy,
	}
	l.mu.Unlock()

	payload, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmpPath := fmt.Sprintf("%s.%d.tmp", filePath, os.Getpid())
	if err := os.WriteFile(tmpPath, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpPath, filePath)
}

// NodesVersion 计算与 Node nodesVersion 完全一致的 16 位 sha1 指纹。
func NodesVersion(nodes []NodeSnapshotView) string {
	hash := sha1.New()
	for _, node := range nodes {
		probe := ""
		if node.Probe != nil {
			probe = fmt.Sprintf("%d:%d:%d", boolDigitInt(node.Probe.OK), node.Probe.LatencyMS, node.Probe.At)
		}
		fmt.Fprintf(hash, "%s|%d|%d|%d|%d|%d|%s\n",
			node.Name,
			boolDigitInt(node.Cooling),
			node.CooldownUntil,
			boolDigitInt(node.Blocked),
			node.Uses,
			node.LastUsedAt,
			probe,
		)
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

func boolDigitInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
