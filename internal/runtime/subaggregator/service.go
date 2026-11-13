package subaggregator

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	defaultRefreshConcurrency = 4
	defaultRefreshDeadline    = 25 * time.Second
	maxRecentPulls            = 20
	maxParsedNodesLimit       = 50
)

// RecentPull 记录最近一次外部客户端拉取摘要（仅内存保留）。
type RecentPull struct {
	At         int64  `json:"at"`
	ClientID   string `json:"clientId"`
	ClientName string `json:"clientName"`
	Format     string `json:"format"`
	View       string `json:"view"`
	Nodes      int    `json:"nodes"`
	RelayNodes int    `json:"relayNodes"`
	RelayError string `json:"relayError"`
}

// PublicSourceView 对外返回给管理面的订阅源脱敏视图。
type PublicSourceView struct {
	ID           string                `json:"id"`
	Name         string                `json:"name"`
	Kind         string                `json:"kind"`
	URL          *string               `json:"url"`
	Content      *string               `json:"content,omitempty"`
	UserAgent    *string               `json:"userAgent,omitempty"`
	NodeCount    int                   `json:"nodeCount"`
	LastSyncedAt *int64                `json:"lastSyncedAt"`
	UserInfo     *SubscriptionUserInfo `json:"userInfo"`
	Enabled      bool                  `json:"enabled"`
}

// OverviewProfileView 描述概览接口返回的聚合配置条目。
type OverviewProfileView struct {
	AggregatorProfile
	NodeCount   int          `json:"nodeCount"`
	RecentPulls []RecentPull `json:"recentPulls"`
}

// OverviewResult 对应 GET /subscription-aggregator 返回结构。
type OverviewResult struct {
	OK              bool                  `json:"ok"`
	Profiles        []OverviewProfileView `json:"profiles"`
	Sources         []PublicSourceView    `json:"sources"`
	ManualNodeCount int                   `json:"manualNodeCount"`
	Catalog         Catalog               `json:"catalog"`
}

// PreviewNodeItem 描述未保存草稿节点筛选预览项。
type PreviewNodeItem struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Region   string `json:"region"`
	Source   string `json:"source"`
	Chain    string `json:"chain"`
}

// SkippedNodeView 描述被跳过节点的信息（预览用）。
type SkippedNodeView struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// SourcePreviewNode 描述导入预览解析出的单节点摘要。
type SourcePreviewNode struct {
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
	Flag     string `json:"flag"`
}

// PreviewRequest 描述管理面预览配置渲染的请求参数。
type PreviewRequest struct {
	Client        string
	View          string
	Origin        string
	Relay         bool
	RemoteAddress string
}

// PreviewResult 对应 GET /profiles/{id}/preview 返回结构。
type PreviewResult struct {
	OK           bool                  `json:"ok"`
	Content      string                `json:"content"`
	Format       string                `json:"format"`
	ContentType  string                `json:"contentType"`
	Stats        PlanStats             `json:"stats"`
	SkippedNodes []SkippedNodeInfo     `json:"skippedNodes"`
	Warnings     []string              `json:"warnings"`
	UserInfo     *SubscriptionUserInfo `json:"userInfo"`
	Client       *ClientRefView        `json:"client"`
	View         string                `json:"view"`
	Relay        *RelayRenderStatus    `json:"relay"`
}

// ClientRefView 描述预览时命中的客户端摘要。
type ClientRefView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ServeRequest 描述公开 /sub/<token> 或规则集订阅拉取参数。
type ServeRequest struct {
	Target        string
	View          string
	UserAgent     string
	Origin        string
	RemoteAddress string
	Relay         *bool
}

// ServeResponse 描述公开订阅或规则集的 HTTP 响应内容。
type ServeResponse struct {
	Status  int
	Headers map[string]string
	Body    string
	Stats   PlanStats
}

// ImportSourceSkipped 记录导入本机客户端订阅源时跳过的条目。
type ImportSourceSkipped struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// ImportedSourceItem 记录成功导入本机订阅源的条目。
type ImportedSourceItem struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	ClientID   string `json:"clientId"`
	ClientName string `json:"clientName"`
}

// ServiceOptions 允许在测试中注入时钟、宿主路径或测试抓取器。
type ServiceOptions struct {
	Now          func() time.Time
	Fetcher      *Fetcher
	RuleSets     *RuleSetConverter
	Probe        *NodeProbe
	Latency      *NodeLatencyMeter
	LocalClients *LocalClientDetector
	HostHomeDir  string
	Platform     string
	Env          map[string]string
}

type inFlightSyncCall struct {
	done chan struct{}
	res  SourceSyncResult
}

// Service 统一编排订阅聚合、节点工具、异步同步与本机边车中转。
type Service struct {
	store              *Store
	fetcher            *Fetcher
	ruleSets           *RuleSetConverter
	probe              *NodeProbe
	latency            *NodeLatencyMeter
	localClients       *LocalClientDetector
	relay              *LocalRelay
	syncRunner         *SourceSyncRunner
	now                func() time.Time
	refreshConcurrency int
	refreshDeadline    time.Duration
	hostHomeDir        string
	platform           string
	env                map[string]string

	mu            sync.Mutex
	recentPulls   map[string][]RecentPull
	inFlightSyncs map[string]*inFlightSyncCall
}

// NewService 构建订阅聚合全功能业务服务实例。
func NewService(aiHomeDir string, opts ServiceOptions) *Service {
	env := opts.Env
	if env == nil {
		env = readProcessEnvMap()
	}
	platform := opts.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	hostHome := opts.HostHomeDir
	if hostHome == "" {
		if h := strings.TrimSpace(env["AIH_HOST_HOME"]); h != "" {
			hostHome = h
		} else if h, err := os.UserHomeDir(); err == nil {
			hostHome = h
		}
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	fetcher := opts.Fetcher
	if fetcher == nil {
		fetcher = NewFetcher()
	}
	ruleSets := opts.RuleSets
	if ruleSets == nil {
		ruleSets = NewRuleSetConverter(nil)
	}
	probe := opts.Probe
	if probe == nil {
		probe = NewNodeProbe()
	}
	latency := opts.Latency
	if latency == nil {
		latency = NewNodeLatencyMeter()
	}
	localClients := opts.LocalClients
	if localClients == nil {
		localClients = NewLocalClientDetector()
	}
	store := NewStore(aiHomeDir)
	relay := NewLocalRelay(store.AIHomeDir(), env)

	svc := &Service{
		store:              store,
		fetcher:            fetcher,
		ruleSets:           ruleSets,
		probe:              probe,
		latency:            latency,
		localClients:       localClients,
		relay:              relay,
		now:                nowFn,
		refreshConcurrency: defaultRefreshConcurrency,
		refreshDeadline:    defaultRefreshDeadline,
		hostHomeDir:        hostHome,
		platform:           platform,
		env:                env,
		recentPulls:        make(map[string][]RecentPull),
		inFlightSyncs:      make(map[string]*inFlightSyncCall),
	}
	svc.syncRunner = NewSourceSyncRunner(func(sourceID string) SourceSyncResult {
		return svc.SyncSource(context.Background(), sourceID)
	})
	svc.syncRunner.now = nowFn
	return svc
}

func readProcessEnvMap() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		if idx := strings.IndexByte(kv, '='); idx > 0 {
			out[kv[:idx]] = kv[idx+1:]
		}
	}
	return out
}

func toPublicSource(s Subscription) PublicSourceView {
	isLocal := s.Kind == "local"
	kind := "remote"
	if isLocal {
		kind = "local"
	}
	v := PublicSourceView{
		ID:           s.ID,
		Name:         s.Name,
		Kind:         kind,
		URL:          s.URL,
		NodeCount:    s.NodeCount,
		LastSyncedAt: s.LastSyncedAt,
		UserInfo:     s.UserInfo,
		Enabled:      s.Enabled,
	}
	if isLocal {
		v.URL = nil
		contentCopy := s.Content
		v.Content = &contentCopy
	} else {
		v.UserAgent = s.UserAgent
	}
	return v
}

func (s *Service) recordPull(profileID string, pull RecentPull) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.recentPulls[profileID]
	next := make([]RecentPull, 0, minInt(len(prev)+1, maxRecentPulls))
	next = append(next, pull)
	for i := 0; i < len(prev) && len(next) < maxRecentPulls; i++ {
		next = append(next, prev[i])
	}
	s.recentPulls[profileID] = next
}

func (s *Service) getRecentPulls(profileID string) []RecentPull {
	s.mu.Lock()
	defer s.mu.Unlock()
	src := s.recentPulls[profileID]
	if len(src) == 0 {
		return []RecentPull{}
	}
	cp := make([]RecentPull, len(src))
	copy(cp, src)
	return cp
}

// Relay 返回本机中转控制器的内部引用（用于服务端启动绑定 UDP 入口或关闭清理）。
func (s *Service) Relay() *LocalRelay {
	return s.relay
}

// GetOverview 返回聚合器管理首页所需的配置、订阅源、手动节点数与字典。
func (s *Service) GetOverview() (OverviewResult, error) {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return OverviewResult{}, err
	}
	agg, err := s.store.ReadAggregatorStore()
	if err != nil {
		return OverviewResult{}, err
	}
	profiles := make([]OverviewProfileView, 0, len(agg.Profiles))
	for _, p := range agg.Profiles {
		sel := SelectAggregatedNodes(p, pool.Subscriptions, pool.Nodes)
		profiles = append(profiles, OverviewProfileView{
			AggregatorProfile: PublicProfile(p),
			NodeCount:         sel.Stats.Selected,
			RecentPulls:       s.getRecentPulls(p.ID),
		})
	}
	sources := make([]PublicSourceView, 0, len(pool.Subscriptions))
	for _, sub := range pool.Subscriptions {
		sources = append(sources, toPublicSource(sub))
	}
	manualCount := 0
	for _, n := range pool.Nodes {
		if n.Str("subscriptionId") == "" {
			manualCount++
		}
	}
	return OverviewResult{
		OK:              true,
		Profiles:        profiles,
		Sources:         sources,
		ManualNodeCount: manualCount,
		Catalog:         BuildCatalog(ProtocolForms()),
	}, nil
}

// PreviewNodes 对未保存草稿执行选点、过滤、改名与去重预览。
func (s *Service) PreviewNodes(raw map[string]any) ([]PreviewNodeItem, error) {
	draft := map[string]any{}
	for _, key := range []string{"sources", "filter", "naming", "dedupe"} {
		if v, exists := raw[key]; exists {
			draft[key] = v
		}
	}
	profile, err := NormalizeProfileFromMap(draft, nil, s.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return nil, err
	}
	sel := SelectAggregatedNodes(profile, pool.Subscriptions, pool.Nodes)
	out := make([]PreviewNodeItem, 0, len(sel.Entries))
	for _, e := range sel.Entries {
		out = append(out, PreviewNodeItem{
			ID:       e.Node.Str("id"),
			Name:     e.Name,
			Protocol: strings.ToLower(e.Node.Str("protocol")),
			Region:   e.RegionID,
			Source:   e.SourceName,
			Chain:    e.Node.Str("chain"),
		})
	}
	return out, nil
}

// SaveProfile 创建或更新聚合配置方案。
func (s *Service) SaveProfile(raw map[string]any) (AggregatorProfile, error) {
	if raw == nil {
		raw = map[string]any{}
	}
	var saved AggregatorProfile
	nowMs := s.now().UnixMilli()
	_, err := s.store.MutateAggregatorStore(func(data *AggregatorStoreData) error {
		reqID := stringField(raw, "id")
		idx := -1
		if reqID != "" {
			for i := range data.Profiles {
				if data.Profiles[i].ID == reqID {
					idx = i
					break
				}
			}
			if idx == -1 {
				return errInvalid("aggregator_profile_not_found")
			}
		}
		var existing *AggregatorProfile
		if idx == -1 {
			created := AggregatorProfile{
				ID:        GenerateRandomID("agg"),
				Token:     GenerateProfileToken(),
				CreatedAt: nowMs,
			}
			existing = &created
		} else {
			cp := data.Profiles[idx]
			existing = &cp
		}
		norm, err := NormalizeProfileFromMap(raw, existing, nowMs)
		if err != nil {
			return err
		}
		if idx == -1 {
			data.Profiles = append(data.Profiles, norm)
		} else {
			data.Profiles[idx] = norm
		}
		saved = norm
		return nil
	})
	if err != nil {
		return AggregatorProfile{}, err
	}
	return PublicProfile(saved), nil
}

// DeleteProfile 删除指定聚合配置并清理最近拉取记录。
func (s *Service) DeleteProfile(profileID string) error {
	deleted := false
	_, err := s.store.MutateAggregatorStore(func(data *AggregatorStoreData) error {
		next := make([]AggregatorProfile, 0, len(data.Profiles))
		for _, p := range data.Profiles {
			if p.ID == profileID {
				deleted = true
				continue
			}
			next = append(next, p)
		}
		if !deleted {
			return errInvalid("aggregator_profile_not_found")
		}
		data.Profiles = next
		return nil
	})
	if err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.recentPulls, profileID)
	s.mu.Unlock()
	return nil
}

// RotateToken 重新签发指定聚合配置的公开订阅令牌。
func (s *Service) RotateToken(profileID string) (AggregatorProfile, error) {
	var updated AggregatorProfile
	nowMs := s.now().UnixMilli()
	_, err := s.store.MutateAggregatorStore(func(data *AggregatorStoreData) error {
		for i := range data.Profiles {
			if data.Profiles[i].ID == profileID {
				data.Profiles[i].Token = GenerateProfileToken()
				data.Profiles[i].UpdatedAt = nowMs
				updated = data.Profiles[i]
				return nil
			}
		}
		return errInvalid("aggregator_profile_not_found")
	})
	if err != nil {
		return AggregatorProfile{}, err
	}
	return PublicProfile(updated), nil
}

// ImportLinks 生成各代理客户端的深链接与通用订阅地址。
func (s *Service) ImportLinks(profileID, origin string) (ImportLinksResult, error) {
	agg, err := s.store.ReadAggregatorStore()
	if err != nil {
		return ImportLinksResult{}, err
	}
	for _, p := range agg.Profiles {
		if p.ID == profileID {
			res, ok := BuildImportLinks(origin, p.Token, p.Name)
			if !ok {
				return ImportLinksResult{}, errInvalid("invalid_aggregator_origin")
			}
			return res, nil
		}
	}
	return ImportLinksResult{}, errInvalid("aggregator_profile_not_found")
}

// DetectLocalClients 检测本机安装的代理客户端 URL Scheme 处理器。
func (s *Service) DetectLocalClients(ctx context.Context, local bool) map[string]any {
	if !local {
		return map[string]any{"ok": true, "local": false, "handlers": map[string]any{}}
	}
	handlers := s.localClients.Detect(ctx, ImportSchemes())
	return map[string]any{"ok": true, "local": true, "handlers": handlers}
}

// ScanLocalSources 只读扫描本机客户端配置并对照已有订阅源标出是否已导入。
func (s *Service) ScanLocalSources() (LocalScanResult, error) {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return LocalScanResult{}, err
	}
	scan := ScanLocalSources(s.platform, s.hostHomeDir, s.env)
	scan.Candidates = MarkImportedSources(scan.Candidates, pool.Subscriptions)
	return scan, nil
}

// ImportLocalSources 导入选中的本机客户端订阅并在后台启动同步任务。
func (s *Service) ImportLocalSources(ids []string) (map[string]any, error) {
	wanted := map[string]bool{}
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed != "" {
			wanted[trimmed] = true
		}
	}
	if len(wanted) == 0 {
		return nil, errInvalid("invalid_local_source_selection")
	}
	scan, err := s.ScanLocalSources()
	if err != nil {
		return nil, err
	}
	var candidates []LocalSourceCandidate
	for _, c := range scan.Candidates {
		if wanted[c.ID] {
			candidates = append(candidates, c)
		}
	}
	if len(candidates) == 0 {
		return nil, errInvalid("local_source_candidate_not_found")
	}

	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, src := range pool.Subscriptions {
		names[src.Name] = true
	}

	imported := make([]ImportedSourceItem, 0, len(candidates))
	skipped := make([]ImportSourceSkipped, 0)
	var jobEntries []SyncJobEntry

	for _, c := range candidates {
		if c.Imported {
			skipped = append(skipped, ImportSourceSkipped{ID: c.ID, Name: c.Name, Reason: "already_imported"})
			continue
		}
		baseName := strings.TrimSpace(c.Name)
		if baseName == "" {
			baseName = strings.TrimSpace(c.ClientName)
		}
		if baseName == "" {
			baseName = "本机订阅"
		}
		name := baseName
		for counter := 2; names[name]; counter++ {
			name = fmt.Sprintf("%s %d", baseName, counter)
		}
		names[name] = true

		saved, saveErr := s.SaveSourceRecord(map[string]any{
			"name": name,
			"kind": "remote",
			"url":  c.URL,
		})
		if saveErr != nil {
			skipped = append(skipped, ImportSourceSkipped{ID: c.ID, Name: name, Reason: errorCodeOf(saveErr)})
			continue
		}
		imported = append(imported, ImportedSourceItem{
			ID:         saved.ID,
			Name:       name,
			URL:        c.URL,
			ClientID:   c.ClientID,
			ClientName: c.ClientName,
		})
		jobEntries = append(jobEntries, SyncJobEntry{ID: saved.ID, Name: name})
	}

	var job *SyncJobView
	if len(jobEntries) > 0 {
		j, _, jErr := s.syncRunner.Start(jobEntries, "同步导入的订阅源")
		if jErr == nil {
			job = &j
		}
	}
	return map[string]any{
		"ok":       true,
		"imported": imported,
		"skipped":  skipped,
		"job":      job,
	}, nil
}

// StartSourceSync 为指定（或全部已启用）订阅源创建异步同步任务。
func (s *Service) StartSourceSync(ids []string) (SyncJobView, error) {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return SyncJobView{}, err
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed != "" {
			wanted[trimmed] = true
		}
	}
	var entries []SyncJobEntry
	for _, src := range pool.Subscriptions {
		if !src.Enabled {
			continue
		}
		if len(wanted) > 0 && !wanted[src.ID] {
			continue
		}
		entries = append(entries, SyncJobEntry{ID: src.ID, Name: src.Name})
	}
	taskName := "同步订阅源"
	if len(wanted) == 1 && len(entries) > 0 {
		taskName = "同步 " + entries[0].Name
	}
	job, _, err := s.syncRunner.Start(entries, taskName)
	return job, err
}

// StartSourceSyncOne 发起单个订阅源同步（若已在执行则复用任务）。
func (s *Service) StartSourceSyncOne(subscriptionID string) (map[string]any, error) {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return nil, err
	}
	var found *Subscription
	for i := range pool.Subscriptions {
		if pool.Subscriptions[i].ID == subscriptionID {
			found = &pool.Subscriptions[i]
			break
		}
	}
	if found == nil {
		return nil, errInvalid("subscription_not_found")
	}
	if !found.Enabled {
		return nil, errInvalid("subscription_disabled")
	}
	job, reused, err := s.syncRunner.StartOne(SyncJobEntry{ID: found.ID, Name: found.Name})
	if err != nil {
		return nil, err
	}
	res := map[string]any{"ok": true, "job": job}
	if reused {
		res["reused"] = true
	}
	return res, nil
}

// ListSourceSyncJobs 返回同步任务快照（用于 SSE 首包与恢复）。
func (s *Service) ListSourceSyncJobs() SyncSnapshot {
	return s.syncRunner.Snapshot()
}

// OnSourceSyncChange 订阅同步任务事件流。
func (s *Service) OnSourceSyncChange(fn func(SyncEvent)) func() {
	return s.syncRunner.OnChange(fn)
}

// SetSourceEnabled 启用或停用指定订阅源。
func (s *Service) SetSourceEnabled(subscriptionID string, enabled bool) (PublicSourceView, error) {
	var updated Subscription
	found := false
	_, err := s.store.MutateProxyPool(func(data *ProxyPoolStoreData) error {
		for i := range data.Subscriptions {
			if data.Subscriptions[i].ID == subscriptionID {
				found = true
				data.Subscriptions[i].Enabled = enabled
				updated = data.Subscriptions[i]
				return nil
			}
		}
		return errInvalid("subscription_not_found")
	})
	if err != nil {
		return PublicSourceView{}, err
	}
	if !found {
		return PublicSourceView{}, errInvalid("subscription_not_found")
	}
	return toPublicSource(updated), nil
}

func deterministicSubID(rawURL, name string) string {
	sum := sha256.Sum256([]byte(rawURL + ":" + name))
	return "sub_" + hex.EncodeToString(sum[:])[:12]
}

func sourceSignatureKey(sub Subscription) string {
	u := ""
	if sub.URL != nil {
		u = *sub.URL
	}
	ua := ""
	if sub.UserAgent != nil {
		ua = *sub.UserAgent
	}
	raw, _ := json.Marshal([]any{sub.Kind, u, ua, sub.Content})
	return string(raw)
}

// SaveSourceRecord 仅持久化订阅源元数据，不触发同步。
func (s *Service) SaveSourceRecord(raw map[string]any) (Subscription, error) {
	if raw == nil {
		return Subscription{}, errInvalid("invalid_subscription")
	}
	reqID := strings.TrimSpace(stringField(raw, "id"))
	rawKind := strings.TrimSpace(stringField(raw, "kind"))
	rawURL := strings.TrimSpace(stringField(raw, "url"))
	rawContent, hasContent := raw["content"].(string)
	rawUA := strings.TrimSpace(stringField(raw, "userAgent"))
	name := strings.TrimSpace(stringField(raw, "name"))

	var saved Subscription
	_, err := s.store.MutateProxyPool(func(data *ProxyPoolStoreData) error {
		var existing *Subscription
		existingIdx := -1
		if reqID != "" {
			for i := range data.Subscriptions {
				if data.Subscriptions[i].ID == reqID {
					existing = &data.Subscriptions[i]
					existingIdx = i
					break
				}
			}
			if existing == nil {
				return errInvalid("subscription_not_found")
			}
		}

		kind := rawKind
		if kind == "" && existing != nil {
			kind = existing.Kind
		}
		urlInput := rawURL
		if _, hasURL := raw["url"]; !hasURL && existing != nil && existing.URL != nil {
			urlInput = *existing.URL
		}
		contentInput := rawContent
		if !hasContent && existing != nil {
			contentInput = existing.Content
		}
		uaInput := rawUA
		if _, hasUA := raw["userAgent"]; !hasUA && existing != nil && existing.UserAgent != nil {
			uaInput = *existing.UserAgent
		}
		if name == "" {
			if kind != "local" && urlInput != "" {
				name = DisplayNameFromURL(urlInput)
			} else if existing != nil && existing.Name != "" {
				name = existing.Name
			} else {
				name = "我的订阅"
			}
		}

		cleanKind, cleanURL, cleanContent, cleanUA, vErr := ValidateSubscriptionSourceInput(kind, urlInput, contentInput, uaInput)
		if vErr != nil {
			return vErr
		}
		enabled := true
		if existing != nil {
			enabled = existing.Enabled
		}
		if rawEnabled, hasEnabled := raw["enabled"]; hasEnabled {
			if b, ok := toBool(rawEnabled); ok {
				enabled = b
			}
		}

		id := reqID
		if id == "" {
			if cleanKind == "local" {
				id = GenerateRandomID("sub")
			} else {
				id = deterministicSubID(*cleanURL, name)
			}
		}
		rec := Subscription{
			ID:        id,
			Name:      name,
			Kind:      cleanKind,
			URL:       cleanURL,
			Content:   cleanContent,
			UserAgent: cleanUA,
			Enabled:   enabled,
		}
		if existing != nil {
			rec.NodeCount = existing.NodeCount
			rec.LastSyncedAt = existing.LastSyncedAt
			rec.UserInfo = existing.UserInfo
			data.Subscriptions[existingIdx] = rec
		} else {
			matchIdx := -1
			for i := range data.Subscriptions {
				if data.Subscriptions[i].ID == id {
					matchIdx = i
					break
				}
			}
			if matchIdx >= 0 {
				rec.NodeCount = data.Subscriptions[matchIdx].NodeCount
				rec.LastSyncedAt = data.Subscriptions[matchIdx].LastSyncedAt
				rec.UserInfo = data.Subscriptions[matchIdx].UserInfo
				data.Subscriptions[matchIdx] = rec
			} else {
				data.Subscriptions = append(data.Subscriptions, rec)
			}
		}
		saved = rec
		return nil
	})
	return saved, err
}

// SaveSource 保存订阅源并根据类型触发本地解析或远端异步同步。
func (s *Service) SaveSource(ctx context.Context, raw map[string]any) (map[string]any, error) {
	if raw == nil {
		return nil, errInvalid("invalid_subscription")
	}
	reqID := strings.TrimSpace(stringField(raw, "id"))
	var previous *Subscription
	if reqID != "" {
		pool, err := s.store.ReadProxyPool()
		if err != nil {
			return nil, err
		}
		for i := range pool.Subscriptions {
			if pool.Subscriptions[i].ID == reqID {
				cp := pool.Subscriptions[i]
				previous = &cp
				break
			}
		}
	}

	saved, err := s.SaveSourceRecord(raw)
	if err != nil {
		return nil, err
	}
	pub := toPublicSource(saved)
	if previous != nil && sourceSignatureKey(*previous) == sourceSignatureKey(saved) {
		return map[string]any{"ok": true, "applied": true, "subscription": pub}, nil
	}
	if saved.Kind == "local" {
		syncRes := s.SyncSource(ctx, saved.ID)
		return map[string]any{"ok": true, "applied": true, "subscription": pub, "sync": syncRes}, nil
	}
	job, _, jErr := s.syncRunner.StartOne(SyncJobEntry{ID: saved.ID, Name: saved.Name})
	if jErr != nil {
		return map[string]any{
			"ok":           true,
			"applied":      true,
			"subscription": pub,
			"sync":         map[string]any{"ok": false, "error": errorCodeOf(jErr)},
			"job":          nil,
		}, nil
	}
	return map[string]any{
		"ok":           true,
		"applied":      true,
		"subscription": pub,
		"sync":         map[string]any{"ok": true, "pending": true},
		"job":          job,
	}, nil
}

// DeleteSource 删除订阅源及其下属全部节点。
func (s *Service) DeleteSource(subscriptionID string) (map[string]any, error) {
	removedNodes := 0
	found := false
	_, err := s.store.MutateProxyPool(func(data *ProxyPoolStoreData) error {
		nextSubs := make([]Subscription, 0, len(data.Subscriptions))
		for _, sub := range data.Subscriptions {
			if sub.ID == subscriptionID {
				found = true
				continue
			}
			nextSubs = append(nextSubs, sub)
		}
		if !found {
			return errInvalid("subscription_not_found")
		}
		nextNodes := make([]ProxyNode, 0, len(data.Nodes))
		for _, n := range data.Nodes {
			if n.Str("subscriptionId") == subscriptionID {
				removedNodes++
				continue
			}
			nextNodes = append(nextNodes, n)
		}
		data.Subscriptions = nextSubs
		data.Nodes = nextNodes
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "applied": true, "removedNodeCount": removedNodes}, nil
}

// PreviewSource 仅解析本地粘贴订阅内容而不落库。
func (s *Service) PreviewSource(content string) (map[string]any, error) {
	if strings.TrimSpace(content) == "" {
		return nil, errInvalid("invalid_subscription_content")
	}
	if len(content) > MaxLocalSubscriptionBytes {
		return nil, errInvalid("subscription_content_too_large")
	}
	parsed, err := ParseImportContent(content)
	if err != nil {
		return nil, err
	}
	nodes := make([]SourcePreviewNode, 0, len(parsed.Nodes))
	for _, n := range parsed.Nodes {
		port, _ := n.Int("port")
		name := n.Str("name")
		nodes = append(nodes, SourcePreviewNode{
			Name:     name,
			Protocol: NormalizeProtocolAlias(n.Str("protocol")),
			Server:   n.Str("server"),
			Port:     port,
			Flag:     DetectFlag(name),
		})
	}
	skipped := parsed.SkippedNodes
	if skipped == nil {
		skipped = []SkippedNodeInfo{}
	}
	return map[string]any{
		"ok":           true,
		"format":       parsed.Format,
		"nodes":        nodes,
		"skippedNodes": skipped,
		"warnings":     []string{},
	}, nil
}

// SyncSource 同步单个订阅源（并发去重，拉取后落库）。
func (s *Service) SyncSource(ctx context.Context, subscriptionID string) SourceSyncResult {
	s.mu.Lock()
	if existing, ok := s.inFlightSyncs[subscriptionID]; ok {
		s.mu.Unlock()
		<-existing.done
		return existing.res
	}
	call := &inFlightSyncCall{done: make(chan struct{})}
	s.inFlightSyncs[subscriptionID] = call
	s.mu.Unlock()

	res := s.doSyncSource(ctx, subscriptionID)

	s.mu.Lock()
	delete(s.inFlightSyncs, subscriptionID)
	call.res = res
	close(call.done)
	s.mu.Unlock()
	return res
}

func (s *Service) doSyncSource(ctx context.Context, subscriptionID string) SourceSyncResult {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return SourceSyncResult{OK: false, Error: errorCodeOf(err)}
	}
	var sub *Subscription
	for i := range pool.Subscriptions {
		if pool.Subscriptions[i].ID == subscriptionID {
			cp := pool.Subscriptions[i]
			sub = &cp
			break
		}
	}
	if sub == nil {
		return SourceSyncResult{OK: false, Error: "subscription_not_found"}
	}
	if !sub.Enabled {
		return SourceSyncResult{OK: false, Error: "subscription_disabled"}
	}

	var content string
	var fetchedURL string
	var userInfo *SubscriptionUserInfo
	if sub.Kind == "local" {
		content = sub.Content
	} else {
		rawURL := ""
		if sub.URL != nil {
			rawURL = *sub.URL
		}
		ua := ""
		if sub.UserAgent != nil {
			ua = *sub.UserAgent
		}
		fetched, fErr := s.fetcher.Fetch(ctx, rawURL, ua)
		if fErr != nil {
			return SourceSyncResult{OK: false, Error: errorCodeOf(fErr), Message: fErr.Error()}
		}
		content = fetched.Content
		fetchedURL = fetched.FinalURL
		userInfo = fetched.UserInfo
	}

	parsed, pErr := ParseImportContent(content)
	if pErr != nil {
		return SourceSyncResult{OK: false, Error: errorCodeOf(pErr), Message: pErr.Error()}
	}
	if len(parsed.Nodes) == 0 {
		return SourceSyncResult{OK: false, Error: "no_valid_proxy_nodes_found", Count: 0}
	}

	syncedAt := s.now().UnixMilli()
	var insertedCount int
	_, mErr := s.store.MutateProxyPool(func(data *ProxyPoolStoreData) error {
		var curIdx = -1
		for i := range data.Subscriptions {
			if data.Subscriptions[i].ID == sub.ID {
				curIdx = i
				break
			}
		}
		if curIdx == -1 {
			return errInvalid("subscription_not_found")
		}
		curURL := ""
		if data.Subscriptions[curIdx].URL != nil {
			curURL = *data.Subscriptions[curIdx].URL
		}
		prevURL := ""
		if sub.URL != nil {
			prevURL = *sub.URL
		}
		if curURL != prevURL {
			return errInvalid("subscription_changed_during_sync")
		}
		insertedCount = ReconcileSubscriptionNodes(data, sub.ID, parsed.Nodes, syncedAt)
		if sub.Kind != "local" {
			if fetchedURL != "" {
				// 保留原订阅 URL 不篡改重定向后的地址（与 JS store.replaceSubscriptionNodes 行为一致），仅写 userInfo。
			}
			if userInfo != nil {
				data.Subscriptions[curIdx].UserInfo = userInfo
			}
		}
		return nil
	})
	if mErr != nil {
		return SourceSyncResult{OK: false, Error: errorCodeOf(mErr), Message: mErr.Error()}
	}
	return SourceSyncResult{
		OK:      true,
		Applied: true,
		Count:   insertedCount,
	}
}

// SyncSources 并发同步多个订阅源（客户端拉取按 refreshHours 触发）。
func (s *Service) SyncSources(ctx context.Context, ids []string) {
	if len(ids) == 0 {
		return
	}
	sem := make(chan struct{}, s.refreshConcurrency)
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(subID string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			s.SyncSource(ctx, subID)
		}(id)
	}
	wg.Wait()
}

// SourceNodes 返回单个订阅源下的节点详情（含凭据与分享链接，仅供管理面）。
func (s *Service) SourceNodes(subID string) ([]map[string]any, error) {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return nil, err
	}
	found := false
	for _, sub := range pool.Subscriptions {
		if sub.ID == subID {
			found = true
			break
		}
	}
	if !found {
		return nil, errInvalid("subscription_not_found")
	}
	out := make([]map[string]any, 0)
	for _, n := range pool.Nodes {
		if n.Str("subscriptionId") == subID {
			out = append(out, FormatNodeSummary(n, subID))
		}
	}
	return out, nil
}

// AllNodes 返回全部节点轻量清单（选链式前置节点用，不含凭据）。
func (s *Service) AllNodes() ([]map[string]any, error) {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(pool.Nodes))
	for _, n := range pool.Nodes {
		out = append(out, map[string]any{
			"id":       n.Str("id"),
			"name":     n.Str("name"),
			"protocol": NormalizeProtocolAlias(n.Str("protocol")),
			"sourceId": n.Str("subscriptionId"),
			"chain":    n.Str("chain"),
		})
	}
	return out, nil
}

// SetNodeChain 设置或清除某个节点的链式前置节点。
func (s *Service) SetNodeChain(nodeID, chainRef string) (map[string]any, error) {
	id := strings.TrimSpace(nodeID)
	if id == "" {
		return nil, errInvalid("invalid_proxy_node")
	}
	ref := strings.TrimSpace(chainRef)
	var updated map[string]any
	_, err := s.store.MutateProxyPool(func(data *ProxyPoolStoreData) error {
		idx := -1
		for i, n := range data.Nodes {
			if n.Str("id") == id {
				idx = i
				break
			}
		}
		if idx == -1 {
			return errInvalid("proxy_node_not_found")
		}
		if failCode := ValidateChainRef(data.Nodes, id, ref); failCode != "" {
			return errInvalid(failCode)
		}
		if ref != "" {
			data.Nodes[idx]["chain"] = ref
		} else {
			delete(data.Nodes[idx], "chain")
		}
		data.Nodes[idx]["updatedAt"] = s.now().UnixMilli()
		updated = map[string]any{
			"id":    id,
			"name":  data.Nodes[idx].Str("name"),
			"chain": ref,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

// MeasureLatency 并发测量订阅源全部节点的 TCP 建连耗时并将结果写回 proxy-pool.json。
func (s *Service) MeasureLatency(ctx context.Context, subID string, fresh bool) (map[string]LatencyResult, error) {
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return nil, err
	}
	found := false
	for _, sub := range pool.Subscriptions {
		if sub.ID == subID {
			found = true
			break
		}
	}
	if !found {
		return nil, errInvalid("subscription_not_found")
	}
	var targets []LatencyTarget
	for _, n := range pool.Nodes {
		if n.Str("subscriptionId") != subID {
			continue
		}
		key := BuildProxyNodeConnectionKey(n)
		if key == "" {
			key = n.Str("id")
		}
		port, _ := n.Int("port")
		targets = append(targets, LatencyTarget{
			Key:    key,
			Server: n.Str("server"),
			Port:   port,
		})
	}
	results := s.latency.Measure(ctx, targets, fresh, nil)
	if len(results) > 0 {
		_, _ = s.store.MutateProxyPool(func(data *ProxyPoolStoreData) error {
			byConn := make(map[string]int, len(data.Nodes))
			byID := make(map[string]int, len(data.Nodes))
			for i, n := range data.Nodes {
				ck := BuildProxyNodeConnectionKey(n)
				if _, ok := byConn[ck]; !ok && ck != "" {
					byConn[ck] = i
				}
				if id := n.Str("id"); id != "" {
					byID[id] = i
				}
			}
			for key, res := range results {
				idx, ok := byConn[key]
				if !ok {
					idx, ok = byID[key]
				}
				if !ok {
					continue
				}
				if res.MS != nil && *res.MS > 0 {
					data.Nodes[idx]["latencyMs"] = *res.MS
				} else {
					data.Nodes[idx]["latencyMs"] = nil
				}
				data.Nodes[idx]["latencyAt"] = res.MeasuredAt
				data.Nodes[idx]["lastChecked"] = res.MeasuredAt
			}
			return nil
		})
	}
	return results, nil
}

// Probe 执行节点地址/端口协议探测。
func (s *Service) Probe(ctx context.Context, input ProbeInput) (ProbeResult, error) {
	return s.probe.Probe(ctx, input)
}

// ParseNodes 解析分享链接或配置为手动节点表单所需协议字段（最多 50 条）。
func (s *Service) ParseNodes(content string) (map[string]any, error) {
	if strings.TrimSpace(content) == "" {
		return nil, errInvalid("invalid_subscription_content")
	}
	parsed, err := ParseImportContent(content)
	if err != nil {
		return nil, err
	}
	forms := ProtocolForms()
	allowedByProto := make(map[string][]string, len(forms))
	for _, f := range forms {
		keys := make([]string, 0, len(f.Fields))
		for _, field := range f.Fields {
			keys = append(keys, field.Key)
		}
		allowedByProto[f.Protocol] = keys
	}

	limit := minInt(len(parsed.Nodes), maxParsedNodesLimit)
	outNodes := make([]map[string]any, 0, limit)
	for i := 0; i < limit; i++ {
		n := parsed.Nodes[i]
		proto := NormalizeProtocolAlias(n.Str("protocol"))
		port, _ := n.Int("port")
		item := map[string]any{
			"protocol": proto,
			"name":     n.Str("name"),
			"server":   n.Str("server"),
			"port":     port,
		}
		for _, fk := range allowedByProto[pluginKeyFor(proto)] {
			if val, exists := n[fk]; exists && val != nil && val != "" {
				item[fk] = val
			}
		}
		outNodes = append(outNodes, item)
	}
	skipped := parsed.SkippedNodes
	if skipped == nil {
		skipped = []SkippedNodeInfo{}
	}
	return map[string]any{
		"ok":           true,
		"format":       parsed.Format,
		"nodes":        outNodes,
		"skippedNodes": skipped,
	}, nil
}

func effectiveCoreProtocols(renderer Renderer, client DetectedClient) []string {
	if !renderer.Capabilities.RelayFallback {
		return nil
	}
	if len(client.ClassicProtocols) > 0 {
		return client.ClassicProtocols
	}
	return renderer.Capabilities.CoreProtocols
}

type relayPlan struct {
	status         RelayRenderStatus
	candidateNodes []ProxyNode
	wantedIDs      map[string]bool
	hasCandidates  bool
}

func (s *Service) buildRelayPlan(profile AggregatorProfile, renderer Renderer, subs []Subscription, rawNodes []ProxyNode, requested bool, remoteAddr, origin string, client DetectedClient) relayPlan {
	remote := !IsLoopbackRemoteAddress(remoteAddr)
	serverMode := s.relay.ServerPortMode()
	portModeStr := "dedicated"
	if serverMode {
		portModeStr = "server"
	}
	status := RelayRenderStatus{
		Requested: requested,
		Local:     !remote,
		Remote:    remote,
		PortMode:  portModeStr,
		Skipped:   []RelaySkippedItem{},
	}
	if !renderer.Capabilities.RelayFallback {
		return relayPlan{status: status}
	}
	originHost := HostOfOrigin(origin)
	if serverMode {
		status.AdvertiseHost = originHost
		if status.AdvertiseHost == "" && !remote {
			status.AdvertiseHost = "127.0.0.1"
		}
		status.ServerPort = PortOfOrigin(origin)
		if status.AdvertiseHost == "" || status.ServerPort == 0 {
			status.Error = "relay_origin_unknown"
			return relayPlan{status: status}
		}
	} else {
		if remote {
			status.AdvertiseHost = originHost
		} else {
			status.AdvertiseHost = "127.0.0.1"
		}
		if status.AdvertiseHost == "" {
			status.Error = "relay_origin_unknown"
			return relayPlan{status: status}
		}
	}

	coreProtos := effectiveCoreProtocols(renderer, client)
	coreSet := map[string]bool{}
	for _, cp := range coreProtos {
		coreSet[cp] = true
	}

	sel := SelectAggregatedNodes(profile, subs, rawNodes)
	chains := resolveProxyChains(sel.Entries)
	var nodes []ProxyNode
	wanted := map[string]bool{}
	seen := map[int]bool{}

	for _, idx := range orderEntriesByChain(sel.Entries, chains.Targets) {
		e := sel.Entries[idx]
		_, probeErr := renderer.CompileNode(e, "", RenderContext{})
		proto := NormalizeProtocolAlias(e.Node.Str("protocol"))
		unsupported := probeErr != nil || (len(coreSet) > 0 && !coreSet[proto])
		upIdx, hasUp := chains.Targets[idx]
		if !unsupported && !(hasUp && seen[upIdx]) {
			continue
		}
		if !seen[idx] {
			seen[idx] = true
			nodes = append(nodes, e.Node)
		}
		if unsupported {
			if id := e.Node.Str("id"); id != "" {
				wanted[id] = true
			}
		}
		if hasUp && !seen[upIdx] {
			seen[upIdx] = true
			nodes = append(nodes, sel.Entries[upIdx].Node)
		}
	}

	if len(wanted) == 0 {
		return relayPlan{status: status}
	}
	status.Candidates = len(wanted)
	avail := s.relay.Availability()
	status.Available = avail.Available
	status.Binary = avail.Binary
	status.Source = avail.Source
	status.Version = avail.Version
	status.PortRange = avail.PortRange
	if !status.Available {
		status.Error = avail.Error
		if status.Error == "" {
			status.Error = "relay_unavailable"
		}
	}
	return relayPlan{
		status:         status,
		candidateNodes: nodes,
		wantedIDs:      wanted,
		hasCandidates:  true,
	}
}

func (s *Service) mapRelayEndpoints(endpoints map[string]RelayEndpoint, status *RelayRenderStatus) map[string]RelayEndpoint {
	mapped := make(map[string]RelayEndpoint, len(endpoints))
	if len(endpoints) == 0 {
		return mapped
	}
	if status.PortMode == "server" {
		creds, _ := s.relay.Credentials()
		udpReady := s.relay.UDPEndpoint() != nil
		for nodeID := range endpoints {
			mapped[nodeID] = RelayEndpoint{
				Host:     status.AdvertiseHost,
				Port:     status.ServerPort,
				Username: UserNameForNode(nodeID),
				Password: creds.Password,
				UDP:      udpReady,
			}
		}
		status.AuthRequired = true
		status.UDPReady = udpReady
		return mapped
	}
	for nodeID, ep := range endpoints {
		if ep.Username != "" {
			status.AuthRequired = true
		}
		out := ep
		if status.AdvertiseHost != "" {
			out.Host = status.AdvertiseHost
		}
		mapped[nodeID] = out
	}
	return mapped
}

func (s *Service) relaySnapshot(plan relayPlan) *RelayContext {
	status := plan.status
	if !plan.hasCandidates || !status.Available {
		return &RelayContext{Endpoints: map[string]RelayEndpoint{}, Status: &status}
	}
	endpoints := s.relay.ActiveEndpoints()
	listenHost := s.relay.ActiveListenHost()
	status.ListenHost = listenHost
	if status.PortMode != "server" && status.Remote && (listenHost == "" || IsLoopbackHost(listenHost)) {
		if status.Error == "" {
			if len(endpoints) > 0 {
				status.Error = "relay_not_exposed"
			} else {
				status.Error = "relay_not_running"
			}
		}
		return &RelayContext{Endpoints: map[string]RelayEndpoint{}, Status: &status}
	}
	status.Nodes = len(endpoints)
	status.Active = len(endpoints) > 0
	if !status.Active && status.Requested && status.Error == "" {
		status.Error = "relay_not_running"
	}
	return &RelayContext{
		Endpoints: s.mapRelayEndpoints(endpoints, &status),
		Status:    &status,
	}
}

func (s *Service) ensureRelay(ctx context.Context, plan relayPlan) *RelayContext {
	status := plan.status
	if !plan.hasCandidates || !status.Available {
		return &RelayContext{Endpoints: map[string]RelayEndpoint{}, Status: &status}
	}
	res := s.relay.Ensure(ctx, plan.candidateNodes, plan.wantedIDs, status.Remote)
	status.Nodes = len(res.Endpoints)
	status.Active = status.Nodes > 0
	status.Detail = res.Detail
	if len(res.Skipped) > 0 {
		status.Skipped = res.Skipped
	}
	status.ListenHost = s.relay.ActiveListenHost()
	if res.Error != "" {
		status.Error = res.Error
	}
	if status.PortMode != "server" && status.Remote && IsLoopbackHost(status.ListenHost) {
		status.Active = false
		if status.Error == "" {
			status.Error = "relay_not_exposed"
		}
		return &RelayContext{Endpoints: map[string]RelayEndpoint{}, Status: &status}
	}
	return &RelayContext{
		Endpoints: s.mapRelayEndpoints(res.Endpoints, &status),
		Status:    &status,
	}
}

// RelayAvailability 返回本机中转子系统能力与运行状态（只读，不启进程）。
func (s *Service) RelayAvailability() RelayAvailability {
	return s.relay.Availability()
}

// StartRelay 按指定聚合配置与目标格式拉起所需本机边车进程。
func (s *Service) StartRelay(ctx context.Context, profileID, target, clientID, remoteAddr, origin string) (RelayRenderStatus, error) {
	agg, err := s.store.ReadAggregatorStore()
	if err != nil {
		return RelayRenderStatus{}, err
	}
	var profile *AggregatorProfile
	for i := range agg.Profiles {
		if agg.Profiles[i].ID == profileID {
			cp := agg.Profiles[i]
			profile = &cp
			break
		}
	}
	if profile == nil {
		return RelayRenderStatus{}, errInvalid("aggregator_profile_not_found")
	}
	var client DetectedClient
	if clientID != "" {
		var ok bool
		client, ok = ClientByID(clientID)
		if !ok {
			return RelayRenderStatus{}, errInvalid("unsupported_aggregator_client")
		}
	}
	fmtTarget := target
	if fmtTarget == "" {
		fmtTarget = client.Target
	}
	if fmtTarget == "" {
		fmtTarget = "mihomo"
	}
	renderer, ok := GetRenderer(fmtTarget)
	if !ok {
		return RelayRenderStatus{}, errInvalid("unsupported_aggregator_format")
	}
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return RelayRenderStatus{}, err
	}
	plan := s.buildRelayPlan(*profile, renderer, pool.Subscriptions, pool.Nodes, true, remoteAddr, origin, client)
	if !plan.hasCandidates {
		return plan.status, nil
	}
	relayCtx := s.ensureRelay(ctx, plan)
	return *relayCtx.Status, nil
}

// StopRelay 停掉全部运行中的本机中转边车。
func (s *Service) StopRelay() {
	s.relay.Stop()
}

// Preview 同步渲染聚合订阅内容供 WebUI 预览。
func (s *Service) Preview(profileID, target string, req PreviewRequest) (PreviewResult, error) {
	agg, err := s.store.ReadAggregatorStore()
	if err != nil {
		return PreviewResult{}, err
	}
	var profile *AggregatorProfile
	for i := range agg.Profiles {
		if agg.Profiles[i].ID == profileID {
			cp := agg.Profiles[i]
			profile = &cp
			break
		}
	}
	if profile == nil {
		return PreviewResult{}, errInvalid("aggregator_profile_not_found")
	}
	var client DetectedClient
	var hasClient bool
	if req.Client != "" {
		client, hasClient = ClientByID(req.Client)
		if !hasClient {
			return PreviewResult{}, errInvalid("unsupported_aggregator_client")
		}
	}
	fmtTarget := target
	if fmtTarget == "" && hasClient {
		fmtTarget = client.Target
	}
	if fmtTarget == "" {
		fmtTarget = "mihomo"
	}
	renderer, ok := GetRenderer(fmtTarget)
	if !ok {
		return PreviewResult{}, errInvalid("unsupported_aggregator_format")
	}
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return PreviewResult{}, err
	}
	plan := s.buildRelayPlan(*profile, renderer, pool.Subscriptions, pool.Nodes, req.Relay, req.RemoteAddress, req.Origin, client)
	relayCtx := s.relaySnapshot(plan)
	view := NormalizeView(req.View)
	if view == "" && hasClient {
		view = client.View
	}
	renderCtx := BuildRenderContext(req.Origin, profile.Token, renderer.ID, *profile, client, view, relayCtx)
	rendered := RenderWithPlan(*profile, renderer, pool.Subscriptions, pool.Nodes, renderCtx)

	var clientRef *ClientRefView
	if hasClient {
		clientRef = &ClientRefView{ID: client.ID, Name: client.Name}
	}
	return PreviewResult{
		OK:           true,
		Content:      rendered.Content,
		Format:       rendered.Format,
		ContentType:  rendered.ContentType,
		Stats:        rendered.Stats,
		SkippedNodes: rendered.SkippedNodes,
		Warnings:     rendered.Warnings,
		UserInfo:     rendered.UserInfo,
		Client:       clientRef,
		View:         renderCtx.View,
		Relay:        relayCtx.Status,
	}, nil
}

func (s *Service) refreshStaleSources(ctx context.Context, profile AggregatorProfile, subs []Subscription) {
	if profile.RefreshHours <= 0 {
		return
	}
	cutoff := s.now().UnixMilli() - int64(profile.RefreshHours)*int64(time.Hour/time.Millisecond)
	scoped := scopedSubscriptions(profile, subs)
	var stale []string
	for _, src := range scoped {
		if src.Kind == "local" {
			continue
		}
		if src.LastSyncedAt == nil || *src.LastSyncedAt < cutoff {
			stale = append(stale, src.ID)
		}
	}
	if len(stale) == 0 {
		return
	}
	dCtx, cancel := context.WithTimeout(ctx, s.refreshDeadline)
	defer cancel()
	s.SyncSources(dCtx, stale)
}

// ServeSubscription 处理外部代理客户端对 /sub/<token> 的订阅拉取请求。
func (s *Service) ServeSubscription(ctx context.Context, token string, req ServeRequest) (ServeResponse, error) {
	agg, err := s.store.ReadAggregatorStore()
	if err != nil {
		return ServeResponse{}, err
	}
	var profile *AggregatorProfile
	for i := range agg.Profiles {
		if TokenEqual(agg.Profiles[i].Token, token) {
			cp := agg.Profiles[i]
			profile = &cp
			break
		}
	}
	if profile == nil {
		return ServeResponse{}, errInvalid("aggregator_subscription_not_found")
	}
	client := DetectClient(req.UserAgent)
	fmtTarget := req.Target
	if fmtTarget == "" {
		fmtTarget = client.Target
	}
	renderer, ok := GetRenderer(fmtTarget)
	if !ok {
		return ServeResponse{}, errInvalid("unsupported_aggregator_format")
	}
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return ServeResponse{}, err
	}
	s.refreshStaleSources(ctx, *profile, pool.Subscriptions)
	// 若刷新落库后节点变化，重新读取最新节点库。
	if profile.RefreshHours > 0 {
		if latest, rErr := s.store.ReadProxyPool(); rErr == nil {
			pool = latest
		}
	}

	canAdvertise := IsLoopbackRemoteAddress(req.RemoteAddress) || HostOfOrigin(req.Origin) != ""
	relayRequested := false
	if req.Relay != nil {
		relayRequested = *req.Relay
	} else {
		relayRequested = canAdvertise
	}
	plan := s.buildRelayPlan(*profile, renderer, pool.Subscriptions, pool.Nodes, relayRequested, req.RemoteAddress, req.Origin, client)
	var relayCtx *RelayContext
	if plan.hasCandidates && plan.status.Requested && plan.status.Available {
		relayCtx = s.ensureRelay(ctx, plan)
	} else {
		relayCtx = s.relaySnapshot(plan)
	}

	view := NormalizeView(req.View)
	if view == "" {
		view = client.View
	}
	renderCtx := BuildRenderContext(req.Origin, token, renderer.ID, *profile, client, view, relayCtx)
	rendered := RenderWithPlan(*profile, renderer, pool.Subscriptions, pool.Nodes, renderCtx)

	relayNodes := 0
	relayErr := ""
	if relayCtx.Status.Active {
		relayNodes = relayCtx.Status.Nodes
	} else {
		relayErr = relayCtx.Status.Error
	}
	s.recordPull(profile.ID, RecentPull{
		At:         s.now().UnixMilli(),
		ClientID:   client.ID,
		ClientName: client.Name,
		Format:     renderer.ID,
		View:       renderCtx.View,
		Nodes:      rendered.Stats.Selected,
		RelayNodes: relayNodes,
		RelayError: relayErr,
	})

	fileName := fmt.Sprintf("%s.%s", profile.Name, renderer.Extension)
	hours := profile.RefreshHours
	if hours <= 0 {
		hours = 24
	}
	headers := map[string]string{
		"Content-Type":            renderer.ContentType,
		"Content-Disposition":     "attachment; filename*=UTF-8''" + url.PathEscape(fileName),
		"Cache-Control":           "no-store",
		"profile-title":           "base64:" + base64.StdEncoding.EncodeToString([]byte(profile.Name)),
		"profile-update-interval": fmt.Sprintf("%d", hours),
	}
	if ui := FormatSubscriptionUserInfoHeader(rendered.UserInfo); ui != "" {
		headers["subscription-userinfo"] = ui
	}
	return ServeResponse{
		Status:  200,
		Headers: headers,
		Body:    rendered.Content,
		Stats:   rendered.Stats,
	}, nil
}

// TestRoute 执行分流规则路由测试。
func (s *Service) TestRoute(ctx context.Context, raw map[string]any) (RouteTraceResult, error) {
	if raw == nil {
		raw = map[string]any{}
	}
	profileMap, _ := raw["profile"].(map[string]any)
	targetInput := stringField(raw, "target")
	profile, err := NormalizeProfileFromMap(profileMap, nil, s.now().UnixMilli())
	if err != nil {
		return RouteTraceResult{}, err
	}
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return RouteTraceResult{}, err
	}
	plan := BuildAggregationPlan(profile, pool)
	return TraceRoute(ctx, plan, targetInput, s.ruleSets.LoadEntries)
}

// ServeRuleSet 转换并输出某个聚合配置允许暴露的远端规则集内容。
func (s *Service) ServeRuleSet(ctx context.Context, token, tag, target string) (ServeResponse, error) {
	agg, err := s.store.ReadAggregatorStore()
	if err != nil {
		return ServeResponse{}, err
	}
	var profile *AggregatorProfile
	for i := range agg.Profiles {
		if TokenEqual(agg.Profiles[i].Token, token) {
			cp := agg.Profiles[i]
			profile = &cp
			break
		}
	}
	if profile == nil {
		return ServeResponse{}, errInvalid("aggregator_subscription_not_found")
	}
	renderer, ok := GetRenderer(target)
	if !ok || renderer.Capabilities.RuleSetFormat == "" {
		return ServeResponse{}, errInvalid("unsupported_aggregator_format")
	}
	pool, err := s.store.ReadProxyPool()
	if err != nil {
		return ServeResponse{}, err
	}
	plan := BuildPlanWithCapabilities(*profile, ProxyPoolStoreData{Subscriptions: pool.Subscriptions}, renderer.Capabilities)
	var foundRS *RuleSetRef
	for i := range plan.RuleSets {
		if plan.RuleSets[i].Tag == tag {
			foundRS = &plan.RuleSets[i]
			break
		}
	}
	if foundRS == nil {
		return ServeResponse{}, errInvalid("aggregator_rule_set_not_found")
	}
	body, err := s.ruleSets.Render(ctx, *foundRS, renderer.Capabilities.RuleSetFormat)
	if err != nil {
		return ServeResponse{}, errInvalid("aggregator_rule_set_fetch_failed")
	}
	return ServeResponse{
		Status: 200,
		Headers: map[string]string{
			"Content-Type":  "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
		Body: body,
	}, nil
}
