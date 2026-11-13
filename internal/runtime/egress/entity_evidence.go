package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

const (
	entityNodePrefix       = "egress:entity:node:"
	entityPoolPrefix       = "egress:entity:pool:"
	entityPoolGroupPrefix  = "egress:entity:pool-group:"
	entityAssignmentPrefix = "egress:entity:assignment:"
	scopedEvidencePrefix   = "egress:evidence:"
	maxScopeItems          = 500
	defaultMaxEvidence     = 4000
)

// ContractError 携带与 Node egress-domain-contract.js 对齐的稳定错误码。
type ContractError struct {
	Code string
}

func (e *ContractError) Error() string {
	return e.Code
}

func newContractError(code string) error {
	return &ContractError{Code: code}
}

// NodeEntity 描述去敏后的持久节点资源实体（不包含凭据或运行序号）。
type NodeEntity struct {
	NodeID       string         `json:"nodeId"`
	Protocol     string         `json:"protocol"`
	Server       string         `json:"server"`
	Port         int            `json:"port"`
	ExitIdentity string         `json:"exitIdentity"`
	Name         string         `json:"name"`
	RuntimeName  string         `json:"runtimeName,omitempty"`
	Location     map[string]any `json:"location"`
	Source       string         `json:"source"`
	Lifecycle    string         `json:"lifecycle"`
	Tags         []string       `json:"tags"`
}

// PoolGroupEntity 描述出口池分组实体。
type PoolGroupEntity struct {
	PoolGroupID string   `json:"poolGroupId"`
	Name        string   `json:"name"`
	PoolIDs     []string `json:"poolIds"`
	Description string   `json:"description"`
	Enabled     bool     `json:"enabled"`
}

// ProxyPoolEntity 描述出口池实体。
type ProxyPoolEntity struct {
	PoolID                      string         `json:"poolId"`
	PoolGroupID                 string         `json:"poolGroupId"`
	Name                        string         `json:"name"`
	NodeIDs                     []string       `json:"nodeIds"`
	SelectionModeDefault        string         `json:"selectionModeDefault"`
	RotationPolicy              string         `json:"rotationPolicy"`
	HealthPolicy                map[string]any `json:"healthPolicy"`
	UpstreamCompatibilityPolicy map[string]any `json:"upstreamCompatibilityPolicy"`
	Enabled                     bool           `json:"enabled"`
}

// AccountEgressAssignment 描述账号级的持久出口分配记录。
type AccountEgressAssignment struct {
	AccountRef     string              `json:"accountRef"`
	PoolGroupID    string              `json:"poolGroupId"`
	PoolID         string              `json:"poolId"`
	SelectionMode  string              `json:"selectionMode"`
	PinnedNodeID   string              `json:"pinnedNodeId,omitempty"`
	Strategy       string              `json:"strategy"`
	Scope          agyegress.PoolScope `json:"scope"`
	FallbackPolicy string              `json:"fallbackPolicy"`
	UpdatedAt      int64               `json:"updatedAt"`
}

// ResourceMembership 描述节点在池中的从属关系。
type ResourceMembership struct {
	PoolID      string   `json:"poolId"`
	NodeID      string   `json:"nodeId"`
	Enabled     bool     `json:"enabled"`
	Priority    *int     `json:"priority,omitempty"`
	Weight      *int     `json:"weight,omitempty"`
	AccountRefs []string `json:"-"`
	SessionIDs  []string `json:"-"`
}

// ResourceReferenceCounts 汇总单个节点的池/账号/会话引用计数（不含账号列表本身）。
type ResourceReferenceCounts struct {
	Pools    int `json:"pools"`
	Accounts int `json:"accounts"`
	Sessions int `json:"sessions"`
}

// ResourceNodeView 是出口资源树里的节点展示行（不携带任何账号级证据）。
type ResourceNodeView struct {
	NodeID          string                   `json:"nodeId"`
	Name            string                   `json:"name"`
	Protocol        string                   `json:"protocol"`
	Server          string                   `json:"server"`
	Port            int                      `json:"port"`
	ExitIdentity    string                   `json:"exitIdentity"`
	Location        map[string]any           `json:"location,omitempty"`
	Source          string                   `json:"source,omitempty"`
	Lifecycle       string                   `json:"lifecycle,omitempty"`
	Tags            []string                 `json:"tags,omitempty"`
	RuntimeName     string                   `json:"runtimeName,omitempty"`
	Membership      *ResourceMembership      `json:"membership,omitempty"`
	NodeHealth      map[string]any           `json:"nodeHealth,omitempty"`
	NodePolicy      map[string]any           `json:"nodePolicy,omitempty"`
	ReferenceCounts *ResourceReferenceCounts `json:"referenceCounts,omitempty"`
}

// ResourcePoolView 是资源树中的单池视图。
type ResourcePoolView struct {
	PoolID                      string             `json:"poolId"`
	PoolGroupID                 string             `json:"poolGroupId"`
	Name                        string             `json:"name"`
	SelectionModeDefault        string             `json:"selectionModeDefault,omitempty"`
	RotationPolicy              string             `json:"rotationPolicy,omitempty"`
	HealthPolicy                map[string]any     `json:"healthPolicy,omitempty"`
	UpstreamCompatibilityPolicy map[string]any     `json:"upstreamCompatibilityPolicy,omitempty"`
	Enabled                     bool               `json:"enabled"`
	Nodes                       []ResourceNodeView `json:"nodes"`
}

// ResourceGroupView 是资源树中的池分组视图。
type ResourceGroupView struct {
	PoolGroupID string             `json:"poolGroupId"`
	Name        string             `json:"name"`
	Description string             `json:"description,omitempty"`
	Enabled     bool               `json:"enabled"`
	Pools       []ResourcePoolView `json:"pools"`
}

// DiagnosticSummary 统计账号级诊断视角中的命中条数。
type DiagnosticSummary struct {
	Total   int `json:"total"`
	Denied  int `json:"denied"`
	Allowed int `json:"allowed"`
}

// AccountDiagnosticQuery 描述 /egress-evidence 接口接收并规范化后的查询条件。
type AccountDiagnosticQuery struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	UpstreamID string `json:"upstreamId"`
	NodeID     string `json:"nodeId"`
}

// AccountDiagnosticView 返回给 UI 解释账号/上游阻断原因，绝不输出全局禁用标记。
type AccountDiagnosticView struct {
	Scope          string                  `json:"scope"`
	Query          AccountDiagnosticQuery  `json:"query"`
	Evidence       []UpstreamEvidenceEntry `json:"evidence"`
	Summary        DiagnosticSummary       `json:"summary"`
	GlobalBlocking bool                    `json:"globalBlocking"`
}

func extractScopeList(raw any) ([]string, error) {
	items, ok := raw.([]any)
	if !ok {
		return []string{}, nil
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		var val string
		switch typed := item.(type) {
		case string:
			val = strings.TrimSpace(typed)
		case map[string]any:
			found := false
			for _, field := range []string{"nodeId", "groupId", "poolGroupId", "id", "identity"} {
				if candidate, exists := typed[field]; exists {
					found = true
					val = strings.TrimSpace(stringField(candidate))
					if val != "" {
						break
					}
				}
			}
			if !found {
				return nil, newContractError("invalid_scope_list_entry")
			}
		case nil:
			val = ""
		default:
			val = strings.TrimSpace(fmt.Sprint(typed))
		}
		if val == "" {
			continue
		}
		if _, dup := seen[val]; dup {
			continue
		}
		seen[val] = struct{}{}
		out = append(out, val)
		if len(out) >= maxScopeItems {
			break
		}
	}
	return out, nil
}

// NormalizePoolScopeMap 从任意 JSON 对象提取并校验 PoolScope。
func NormalizePoolScopeMap(raw map[string]any) (agyegress.PoolScope, error) {
	src := raw
	if sub, ok := raw["scope"].(map[string]any); ok && sub != nil {
		src = sub
	}
	var rawGroups any
	if g, ok := src["groups"]; ok && g != nil {
		rawGroups = g
	} else {
		rawGroups = src["groupIds"]
	}
	var rawNodes any
	if n, ok := src["nodes"]; ok && n != nil {
		rawNodes = n
	} else {
		rawNodes = src["nodeIds"]
	}
	groups, err := extractScopeList(rawGroups)
	if err != nil {
		return agyegress.PoolScope{}, err
	}
	nodes, err := extractScopeList(rawNodes)
	if err != nil {
		return agyegress.PoolScope{}, err
	}
	for _, n := range nodes {
		if IsRuntimeNodeName(n) {
			return agyegress.PoolScope{}, newContractError("invalid_persistent_node_id")
		}
	}
	kind := strings.ToLower(strings.TrimSpace(stringField(src["kind"])))
	switch kind {
	case "all", "groups", "nodes":
	default:
		switch {
		case len(groups) > 0:
			kind = "groups"
		case len(nodes) > 0:
			kind = "nodes"
		default:
			kind = "all"
		}
	}
	if (kind == "groups" && len(groups) == 0) || (kind == "nodes" && len(nodes) == 0) {
		kind = "all"
	}
	outGroups := []string{}
	outNodes := []string{}
	if kind == "groups" {
		outGroups = groups
	}
	if kind == "nodes" {
		outNodes = nodes
	}
	return agyegress.PoolScope{Kind: kind, Groups: outGroups, Nodes: outNodes}, nil
}

// NormalizeAccountEgressAssignmentFromMap 解析并校验 PUT /egress-assignment 负载。
func NormalizeAccountEgressAssignmentFromMap(raw map[string]any) (AccountEgressAssignment, error) {
	if raw == nil {
		return AccountEgressAssignment{}, newContractError("invalid_account_egress_assignment")
	}
	ref := strings.TrimSpace(stringField(raw["accountRef"]))
	if _, err := accountcore.ParseAccountRef(ref); err != nil {
		return AccountEgressAssignment{}, newContractError("invalid_account_ref")
	}
	selMode := "auto"
	if strings.EqualFold(strings.TrimSpace(stringField(raw["selectionMode"])), "pinned") {
		selMode = "pinned"
	}
	pinnedNodeID := strings.TrimSpace(firstNonEmpty(stringField(raw["pinnedNodeId"]), stringField(raw["nodeId"])))
	if selMode == "pinned" {
		if pinnedNodeID == "" {
			return AccountEgressAssignment{}, newContractError("pinned_node_id_required")
		}
		if IsRuntimeNodeName(pinnedNodeID) {
			return AccountEgressAssignment{}, newContractError("invalid_persistent_node_id")
		}
	} else {
		pinnedNodeID = ""
	}
	strategy := strings.ToLower(strings.TrimSpace(stringField(raw["strategy"])))
	switch strategy {
	case "shared", "sticky", "session":
	default:
		strategy = "shared"
	}
	scope, err := NormalizePoolScopeMap(raw)
	if err != nil {
		return AccountEgressAssignment{}, err
	}
	fallbackPolicy := strings.TrimSpace(stringField(raw["fallbackPolicy"]))
	if fallbackPolicy == "" {
		fallbackPolicy = "none"
	}
	updatedAt := maxInt64(0, int64Field(raw["updatedAt"]))
	return AccountEgressAssignment{
		AccountRef:     ref,
		PoolGroupID:    strings.TrimSpace(stringField(raw["poolGroupId"])),
		PoolID:         strings.TrimSpace(stringField(raw["poolId"])),
		SelectionMode:  selMode,
		PinnedNodeID:   pinnedNodeID,
		Strategy:       strategy,
		Scope:          scope,
		FallbackPolicy: fallbackPolicy,
		UpdatedAt:      updatedAt,
	}, nil
}

// NormalizeNodeEntity 校验并生成去敏 NodeEntity。
func NormalizeNodeEntity(raw map[string]any) (NodeEntity, error) {
	if raw == nil {
		return NodeEntity{}, newContractError("invalid_node_entity")
	}
	proto := NormalizeProtocol(stringField(raw["protocol"]))
	server := NormalizeServer(stringField(raw["server"]))
	port := ParsePortAny(raw["port"])
	if proto == "" || server == "" || port == 0 {
		return NodeEntity{}, newContractError("invalid_stable_node_fields")
	}
	nodeID := BuildNodeEntityID(proto, server, port)
	name := strings.TrimSpace(firstNonEmpty(stringField(raw["name"]), stringField(raw["label"])))
	if name == "" {
		name = nodeID
	}
	var loc map[string]any
	if m, ok := raw["location"].(map[string]any); ok && m != nil {
		loc = make(map[string]any, len(m))
		for k, v := range m {
			loc[k] = v
		}
	}
	tags, _ := extractScopeList(raw["tags"])
	lifecycle := strings.TrimSpace(stringField(raw["lifecycle"]))
	if lifecycle == "" {
		lifecycle = "active"
	}
	return NodeEntity{
		NodeID:       nodeID,
		Protocol:     proto,
		Server:       server,
		Port:         port,
		ExitIdentity: BuildExitIdentity(proto, server, port),
		Name:         name,
		RuntimeName:  strings.TrimSpace(firstNonEmpty(stringField(raw["runtimeName"]), stringField(raw["runtimeNode"]))),
		Location:     loc,
		Source:       strings.TrimSpace(firstNonEmpty(stringField(raw["source"]), stringField(raw["subscriptionId"]))),
		Lifecycle:    lifecycle,
		Tags:         tags,
	}, nil
}

// NormalizePoolGroup 校验并规范化 PoolGroupEntity。
func NormalizePoolGroup(raw map[string]any) (PoolGroupEntity, error) {
	if raw == nil {
		return PoolGroupEntity{}, newContractError("invalid_pool_group")
	}
	id := strings.TrimSpace(firstNonEmpty(stringField(raw["poolGroupId"]), stringField(raw["groupId"]), stringField(raw["id"])))
	if id == "" {
		return PoolGroupEntity{}, newContractError("invalid_pool_group_id")
	}
	if IsRuntimeNodeName(id) {
		return PoolGroupEntity{}, newContractError("invalid_persistent_pool_group_id")
	}
	var rawPools any
	if p, ok := raw["poolIds"]; ok && p != nil {
		rawPools = p
	} else {
		rawPools = raw["pools"]
	}
	poolIDs, err := extractScopeList(rawPools)
	if err != nil {
		return PoolGroupEntity{}, err
	}
	enabled := true
	if b, ok := raw["enabled"].(bool); ok {
		enabled = b
	}
	name := strings.TrimSpace(firstNonEmpty(stringField(raw["name"]), stringField(raw["label"])))
	if name == "" {
		name = id
	}
	return PoolGroupEntity{
		PoolGroupID: id,
		Name:        name,
		PoolIDs:     poolIDs,
		Description: strings.TrimSpace(stringField(raw["description"])),
		Enabled:     enabled,
	}, nil
}

// NormalizeProxyPool 校验并规范化 ProxyPoolEntity。
func NormalizeProxyPool(raw map[string]any) (ProxyPoolEntity, error) {
	if raw == nil {
		return ProxyPoolEntity{}, newContractError("invalid_proxy_pool")
	}
	id := strings.TrimSpace(firstNonEmpty(stringField(raw["poolId"]), stringField(raw["id"])))
	if id == "" {
		return ProxyPoolEntity{}, newContractError("invalid_proxy_pool_id")
	}
	if IsRuntimeNodeName(id) {
		return ProxyPoolEntity{}, newContractError("invalid_persistent_pool_id")
	}
	var rawNodes any
	if n, ok := raw["nodeIds"]; ok && n != nil {
		rawNodes = n
	} else {
		rawNodes = raw["nodes"]
	}
	nodeIDs, err := extractScopeList(rawNodes)
	if err != nil {
		return ProxyPoolEntity{}, err
	}
	for _, nid := range nodeIDs {
		if IsRuntimeNodeName(nid) {
			return ProxyPoolEntity{}, newContractError("invalid_persistent_node_id")
		}
	}
	selDefault := "auto"
	if strings.EqualFold(strings.TrimSpace(stringField(raw["selectionModeDefault"])), "pinned") {
		selDefault = "pinned"
	}
	rotPolicy := strings.TrimSpace(stringField(raw["rotationPolicy"]))
	if rotPolicy == "" {
		rotPolicy = "shared"
	}
	enabled := true
	if b, ok := raw["enabled"].(bool); ok {
		enabled = b
	}
	name := strings.TrimSpace(firstNonEmpty(stringField(raw["name"]), stringField(raw["label"])))
	if name == "" {
		name = id
	}
	var hp, ucp map[string]any
	if m, ok := raw["healthPolicy"].(map[string]any); ok {
		hp = m
	}
	if m, ok := raw["upstreamCompatibilityPolicy"].(map[string]any); ok {
		ucp = m
	}
	return ProxyPoolEntity{
		PoolID:                      id,
		PoolGroupID:                 strings.TrimSpace(firstNonEmpty(stringField(raw["poolGroupId"]), stringField(raw["groupId"]))),
		Name:                        name,
		NodeIDs:                     nodeIDs,
		SelectionModeDefault:        selDefault,
		RotationPolicy:              rotPolicy,
		HealthPolicy:                hp,
		UpstreamCompatibilityPolicy: ucp,
		Enabled:                     enabled,
	}, nil
}

// EntityStore 从 app_kv 读写出口领域持久化实体映射。
type EntityStore struct {
	aiHomeDir string
	now       func() int64
}

// NewEntityStore 构造领域实体存储。
func NewEntityStore(aiHomeDir string, nowFn func() int64) *EntityStore {
	if nowFn == nil {
		nowFn = currentUnixMS
	}
	return &EntityStore{
		aiHomeDir: strings.TrimSpace(aiHomeDir),
		now:       nowFn,
	}
}

// ListNodes 读取 egress:entity:node:* 下的有效节点实体。
func (s *EntityStore) ListNodes(ctx context.Context) []NodeEntity {
	kv, err := readKVPrefix(ctx, s.aiHomeDir, entityNodePrefix)
	if err != nil {
		return nil
	}
	var out []NodeEntity
	for key, val := range kv {
		id := strings.TrimPrefix(key, entityNodePrefix)
		var m map[string]any
		if json.Unmarshal([]byte(val), &m) != nil {
			continue
		}
		if ent, err := NormalizeNodeEntity(m); err == nil && ent.NodeID == id {
			out = append(out, ent)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].NodeID < out[j].NodeID })
	return out
}

// ListPools 读取 egress:entity:pool:* 下的有效池实体。
func (s *EntityStore) ListPools(ctx context.Context) []ProxyPoolEntity {
	kv, err := readKVPrefix(ctx, s.aiHomeDir, entityPoolPrefix)
	if err != nil {
		return nil
	}
	var out []ProxyPoolEntity
	for key, val := range kv {
		id := strings.TrimPrefix(key, entityPoolPrefix)
		var m map[string]any
		if json.Unmarshal([]byte(val), &m) != nil {
			continue
		}
		if ent, err := NormalizeProxyPool(m); err == nil && ent.PoolID == id {
			out = append(out, ent)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PoolID < out[j].PoolID })
	return out
}

// ListPoolGroups 读取 egress:entity:pool-group:* 下的有效池分组实体。
func (s *EntityStore) ListPoolGroups(ctx context.Context) []PoolGroupEntity {
	kv, err := readKVPrefix(ctx, s.aiHomeDir, entityPoolGroupPrefix)
	if err != nil {
		return nil
	}
	var out []PoolGroupEntity
	for key, val := range kv {
		id := strings.TrimPrefix(key, entityPoolGroupPrefix)
		var m map[string]any
		if json.Unmarshal([]byte(val), &m) != nil {
			continue
		}
		if ent, err := NormalizePoolGroup(m); err == nil && ent.PoolGroupID == id {
			out = append(out, ent)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PoolGroupID < out[j].PoolGroupID })
	return out
}

// GetAssignment 读取单账号分配投影。
func (s *EntityStore) GetAssignment(ctx context.Context, accountRef string) (AccountEgressAssignment, bool) {
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return AccountEgressAssignment{}, false
	}
	var m map[string]any
	found, err := readJSONKV(ctx, s.aiHomeDir, entityAssignmentPrefix+ref, &m)
	if err != nil || !found {
		return AccountEgressAssignment{}, false
	}
	ent, err := NormalizeAccountEgressAssignmentFromMap(m)
	if err != nil || ent.AccountRef != ref {
		return AccountEgressAssignment{}, false
	}
	return ent, true
}

// ListAssignments 读取全部账号分配投影。
func (s *EntityStore) ListAssignments(ctx context.Context) []AccountEgressAssignment {
	kv, err := readKVPrefix(ctx, s.aiHomeDir, entityAssignmentPrefix)
	if err != nil {
		return nil
	}
	var out []AccountEgressAssignment
	for key, val := range kv {
		id := strings.TrimPrefix(key, entityAssignmentPrefix)
		var m map[string]any
		if json.Unmarshal([]byte(val), &m) != nil {
			continue
		}
		if ent, err := NormalizeAccountEgressAssignmentFromMap(m); err == nil && ent.AccountRef == id {
			out = append(out, ent)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AccountRef < out[j].AccountRef })
	return out
}

// PutAssignment 写入单账号分配投影。
func (s *EntityStore) PutAssignment(ctx context.Context, assignment AccountEgressAssignment) error {
	nowMS := s.now()
	assignment.UpdatedAt = nowMS
	return writeJSONKV(ctx, s.aiHomeDir, entityAssignmentPrefix+assignment.AccountRef, assignment, nowMS)
}

// AssignmentService 对齐 Node egress-assignment-service.js：
// 以 legacy account:egress:* 为兼容主事实，叠加 egress:entity:assignment:* 投影。
type AssignmentService struct {
	aiHomeDir   string
	entityStore *EntityStore
}

// NewAssignmentService 构造账号出口分配读取服务。
func NewAssignmentService(aiHomeDir string, entityStore *EntityStore) *AssignmentService {
	return &AssignmentService{
		aiHomeDir:   strings.TrimSpace(aiHomeDir),
		entityStore: entityStore,
	}
}

// AssignmentFromLegacyBinding 将 mode=pool 的有效遗留绑定转换为 AccountEgressAssignment。
func AssignmentFromLegacyBinding(accountRef string, binding agyegress.Binding) (AccountEgressAssignment, bool) {
	if binding.Retired || binding.Mode != agyegress.ModePool {
		return AccountEgressAssignment{}, false
	}
	scope := agyegress.PoolScope{Kind: "all", Groups: []string{}, Nodes: []string{}}
	if binding.PoolScope != nil {
		scope = *binding.PoolScope
		if scope.Groups == nil {
			scope.Groups = []string{}
		}
		if scope.Nodes == nil {
			scope.Nodes = []string{}
		}
	}
	strategy := strings.ToLower(strings.TrimSpace(binding.PoolStrategy))
	if strategy != "sticky" && strategy != "session" {
		strategy = "shared"
	}
	return AccountEgressAssignment{
		AccountRef:     accountRef,
		SelectionMode:  "auto",
		Strategy:       strategy,
		Scope:          scope,
		FallbackPolicy: "none",
		UpdatedAt:      binding.UpdatedAtMS,
	}, true
}

// GetAssignment 读取指定账号的有效出口池分配（按 legacy 优先 + entity 投影回退）。
func (s *AssignmentService) GetAssignment(ctx context.Context, accountRef string) (*AccountEgressAssignment, error) {
	ref := strings.TrimSpace(accountRef)
	if _, err := accountcore.ParseAccountRef(ref); err != nil {
		return nil, nil
	}
	store := agyegress.NewStore(s.aiHomeDir)
	binding, found, err := store.Read(ctx, ref)
	if err != nil {
		return nil, err
	}
	if found {
		if a, ok := AssignmentFromLegacyBinding(ref, binding); ok {
			if s.entityStore != nil {
				if proj, okProj := s.entityStore.GetAssignment(ctx, ref); okProj && proj.SelectionMode == "pinned" && proj.PinnedNodeID != "" {
					a.SelectionMode = "pinned"
					a.PinnedNodeID = proj.PinnedNodeID
				}
			}
			return &a, nil
		}
		return nil, nil
	}
	if s.entityStore != nil {
		if proj, ok := s.entityStore.GetAssignment(ctx, ref); ok {
			return &proj, nil
		}
	}
	return nil, nil
}

// ListAssignments 返回全量有效的出口池账号分配列表。
func (s *AssignmentService) ListAssignments(ctx context.Context) []AccountEgressAssignment {
	seen := make(map[string]AccountEgressAssignment)
	if s.entityStore != nil {
		for _, proj := range s.entityStore.ListAssignments(ctx) {
			current, err := s.GetAssignment(ctx, proj.AccountRef)
			if err == nil && current != nil {
				seen[proj.AccountRef] = *current
			}
		}
	}
	legacyBindings, err := ReadAccountEgressBindings(ctx, s.aiHomeDir)
	if err == nil {
		for _, item := range legacyBindings {
			if _, exists := seen[item.AccountRef]; exists {
				continue
			}
			if a, ok := AssignmentFromLegacyBinding(item.AccountRef, item.Binding); ok {
				seen[item.AccountRef] = a
			}
		}
	}
	out := make([]AccountEgressAssignment, 0, len(seen))
	for _, a := range seen {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AccountRef < out[j].AccountRef })
	return out
}

// ScopedEvidenceQuery 描述针对 scoped 实测仓的过滤条件。
type ScopedEvidenceQuery struct {
	IncludeLegacy        bool
	Scope                string
	AccountRef           string
	Provider             string
	UpstreamID           string
	NodeID               string
	ExitIP               string
	ModelFamily          string
	CredentialGeneration string
}

// EvidenceStore 管理 app_kv egress:evidence:* 中的带作用域出口实测记录。
type EvidenceStore struct {
	aiHomeDir  string
	maxRecords int
	now        func() int64
}

// NewEvidenceStore 构造带作用域的出口实测仓储。
func NewEvidenceStore(aiHomeDir string, nowFn func() int64) *EvidenceStore {
	if nowFn == nil {
		nowFn = currentUnixMS
	}
	return &EvidenceStore{
		aiHomeDir:  strings.TrimSpace(aiHomeDir),
		maxRecords: defaultMaxEvidence,
		now:        nowFn,
	}
}

// BuildProviderExitEvidenceKey 生成与 Node egress-evidence-scope.js 完全一致的 provider_exit 键。
func BuildProviderExitEvidenceKey(entry UpstreamEvidenceEntry) string {
	parts := []string{
		"provider", strings.ToLower(strings.TrimSpace(entry.Provider)),
		"upstream", strings.ToLower(strings.TrimSpace(entry.UpstreamID)),
		"node", strings.TrimSpace(entry.NodeID),
		"ip", strings.TrimSpace(entry.ExitIP),
		"model", strings.ToLower(strings.TrimSpace(entry.ModelFamily)),
	}
	for i := range parts {
		parts[i] = jsEncodeURIComponent(parts[i])
	}
	return strings.Join(parts, "|")
}

// BuildAccountUpstreamEvidenceKey 生成与 Node egress-evidence-scope.js 完全一致的 account_upstream 键。
func BuildAccountUpstreamEvidenceKey(entry UpstreamEvidenceEntry) string {
	parts := []string{
		"account", strings.TrimSpace(entry.AccountRef),
		"provider", strings.ToLower(strings.TrimSpace(entry.Provider)),
		"upstream", strings.ToLower(strings.TrimSpace(entry.UpstreamID)),
		"node", strings.TrimSpace(entry.NodeID),
		"ip", strings.TrimSpace(entry.ExitIP),
		"model", strings.ToLower(strings.TrimSpace(entry.ModelFamily)),
		"credential", strings.TrimSpace(entry.CredentialGeneration),
	}
	for i := range parts {
		parts[i] = jsEncodeURIComponent(parts[i])
	}
	return strings.Join(parts, "|")
}

func jsEncodeURIComponent(s string) string {
	escaped := url.QueryEscape(s)
	escaped = strings.ReplaceAll(escaped, "+", "%20")
	escaped = strings.ReplaceAll(escaped, "%21", "!")
	escaped = strings.ReplaceAll(escaped, "%27", "'")
	escaped = strings.ReplaceAll(escaped, "%28", "(")
	escaped = strings.ReplaceAll(escaped, "%29", ")")
	escaped = strings.ReplaceAll(escaped, "%2A", "*")
	return escaped
}

func evidenceKeyFor(entry UpstreamEvidenceEntry) string {
	switch entry.Scope {
	case ScopeAccountUpstream:
		return BuildAccountUpstreamEvidenceKey(entry)
	case ScopeProviderExit:
		return BuildProviderExitEvidenceKey(entry)
	default:
		return strings.TrimSpace(entry.ExitKey)
	}
}

// RecordEvidence 校验并持久化一条带作用域的实测记录。
func (s *EvidenceStore) RecordEvidence(ctx context.Context, raw UpstreamEvidenceEntry) (bool, string, *UpstreamEvidenceEntry) {
	if raw.At <= 0 {
		raw.At = s.now()
	}
	norm, ok := normalizeScopedEvidenceEntry(raw)
	if !ok {
		return false, "invalid_scoped_evidence", nil
	}
	key := evidenceKeyFor(norm)
	if key == "" {
		existing := s.ListEvidence(ctx, ScopedEvidenceQuery{IncludeLegacy: true})
		key = fmt.Sprintf("legacy:%d:%d", norm.At, len(existing))
	}
	norm.ExitKey = key
	if err := writeJSONKV(ctx, s.aiHomeDir, scopedEvidencePrefix+key, norm, s.now()); err != nil {
		return false, "evidence_write_failed", nil
	}
	s.trimExcess(ctx)
	reason := "recorded"
	if norm.Scope == ScopeLegacy {
		reason = ScopeLegacy
	}
	copied := norm
	return true, reason, &copied
}

func (s *EvidenceStore) trimExcess(ctx context.Context) {
	kv, err := readKVPrefix(ctx, s.aiHomeDir, scopedEvidencePrefix)
	if err != nil || len(kv) <= s.maxRecords {
		return
	}
	type item struct {
		key string
		at  int64
	}
	items := make([]item, 0, len(kv))
	for fullKey, raw := range kv {
		var entry UpstreamEvidenceEntry
		if json.Unmarshal([]byte(raw), &entry) == nil {
			items = append(items, item{key: fullKey, at: maxInt64(entry.At, entry.Timestamp)})
		} else {
			items = append(items, item{key: fullKey, at: 0})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].at < items[j].at })
	for _, victim := range items[:len(items)-s.maxRecords] {
		_ = deleteKV(ctx, s.aiHomeDir, victim.key)
	}
}

// ListEvidence 读取并按多维过滤条件检索实测记录。
func (s *EvidenceStore) ListEvidence(ctx context.Context, query ScopedEvidenceQuery) []UpstreamEvidenceEntry {
	kv, err := readKVPrefix(ctx, s.aiHomeDir, scopedEvidencePrefix)
	if err != nil {
		return []UpstreamEvidenceEntry{}
	}
	scopeFilter := strings.ToLower(strings.TrimSpace(query.Scope))
	out := make([]UpstreamEvidenceEntry, 0)
	for _, raw := range kv {
		var parsed UpstreamEvidenceEntry
		if json.Unmarshal([]byte(raw), &parsed) != nil {
			continue
		}
		entry, ok := normalizeScopedEvidenceEntry(parsed)
		if !ok {
			continue
		}
		if !query.IncludeLegacy && entry.Scope == ScopeLegacy {
			continue
		}
		if scopeFilter != "" && entry.Scope != scopeFilter {
			continue
		}
		if !equalCI(query.AccountRef, entry.AccountRef) ||
			!equalCI(query.Provider, entry.Provider) ||
			!equalCI(query.UpstreamID, entry.UpstreamID) ||
			!equalCI(query.NodeID, entry.NodeID) ||
			!equalCI(query.ExitIP, entry.ExitIP) ||
			!equalCI(query.ModelFamily, entry.ModelFamily) ||
			!equalCI(query.CredentialGeneration, entry.CredentialGeneration) {
			continue
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out
}

func equalCI(want, actual string) bool {
	w := strings.TrimSpace(want)
	if w == "" {
		return true
	}
	return strings.EqualFold(w, strings.TrimSpace(actual))
}

// BuildResourceTreeView 构建以共享资源为核心的三层投影（不含任何账号维度证据）。
func BuildResourceTreeView(
	ctx context.Context,
	entityStore *EntityStore,
	assignments []AccountEgressAssignment,
	snapshots []NodeSnapshotView,
) []ResourceGroupView {
	var entities []NodeEntity
	if entityStore != nil {
		entities = entityStore.ListNodes(ctx)
	}
	if len(entities) == 0 {
		entities = entitiesFromSnapshots(snapshots)
	}
	if len(entities) == 0 {
		return []ResourceGroupView{}
	}

	nodesByID := make(map[string]NodeEntity, len(entities))
	for _, n := range entities {
		nodesByID[n.NodeID] = n
	}

	var pools []ProxyPoolEntity
	if entityStore != nil {
		pools = entityStore.ListPools(ctx)
	}
	if len(pools) == 0 {
		nodeIDs := make([]string, 0, len(entities))
		for _, n := range entities {
			nodeIDs = append(nodeIDs, n.NodeID)
		}
		pools = []ProxyPoolEntity{{
			PoolID:      "default",
			PoolGroupID: "default",
			Name:        "出口池",
			NodeIDs:     nodeIDs,
			Enabled:     true,
		}}
	}

	var groups []PoolGroupEntity
	if entityStore != nil {
		groups = entityStore.ListPoolGroups(ctx)
	}
	if len(groups) == 0 {
		seenGroup := make(map[string]struct{})
		var groupIDs []string
		byGroup := make(map[string][]string)
		for _, p := range pools {
			gid := strings.TrimSpace(p.PoolGroupID)
			if gid == "" {
				continue
			}
			if _, ok := seenGroup[gid]; !ok {
				seenGroup[gid] = struct{}{}
				groupIDs = append(groupIDs, gid)
			}
			byGroup[gid] = append(byGroup[gid], p.PoolID)
		}
		for _, gid := range groupIDs {
			groups = append(groups, PoolGroupEntity{
				PoolGroupID: gid,
				Name:        gid,
				PoolIDs:     byGroup[gid],
				Enabled:     true,
			})
		}
	}

	snapByNodeID := make(map[string]NodeSnapshotView, len(snapshots))
	runtimeNames := make(map[string]string, len(snapshots))
	for _, n := range entities {
		if n.RuntimeName != "" {
			runtimeNames[n.NodeID] = n.RuntimeName
		}
	}
	for _, s := range snapshots {
		id := resolveStableSnapshotNodeID(s, entities)
		snapByNodeID[id] = s
		if s.Name != "" {
			runtimeNames[id] = s.Name
		}
	}

	memberships := deriveResourceMemberships(pools, assignments, snapByNodeID)
	healthMap, policyMap := deriveSharedHealthAndPolicy(snapshots, entities)

	poolsByID := make(map[string]ProxyPoolEntity, len(pools))
	for _, p := range pools {
		poolsByID[p.PoolID] = p
	}
	groupedPoolIDs := make(map[string]bool)
	result := make([]ResourceGroupView, 0, len(groups)+2)

	for _, grp := range groups {
		var grpPools []ProxyPoolEntity
		seenPool := make(map[string]bool)
		for _, pid := range grp.PoolIDs {
			if p, ok := poolsByID[pid]; ok && !seenPool[pid] {
				seenPool[pid] = true
				grpPools = append(grpPools, p)
			}
		}
		for _, p := range pools {
			if p.PoolGroupID == grp.PoolGroupID && !seenPool[p.PoolID] {
				seenPool[p.PoolID] = true
				grpPools = append(grpPools, p)
			}
		}
		poolViews := make([]ResourcePoolView, 0, len(grpPools))
		for _, p := range grpPools {
			groupedPoolIDs[p.PoolID] = true
			poolViews = append(poolViews, buildResourcePoolView(p, nodesByID, memberships, healthMap, policyMap, runtimeNames))
		}
		result = append(result, ResourceGroupView{
			PoolGroupID: grp.PoolGroupID,
			Name:        firstNonEmpty(grp.Name, grp.PoolGroupID),
			Description: grp.Description,
			Enabled:     grp.Enabled,
			Pools:       poolViews,
		})
	}

	var ungrouped []ResourcePoolView
	for _, p := range pools {
		if !groupedPoolIDs[p.PoolID] {
			ungrouped = append(ungrouped, buildResourcePoolView(p, nodesByID, memberships, healthMap, policyMap, runtimeNames))
		}
	}
	if len(ungrouped) > 0 {
		result = append(result, ResourceGroupView{
			PoolGroupID: "ungrouped",
			Name:        "未分组池",
			Enabled:     true,
			Pools:       ungrouped,
		})
	}

	referenced := make(map[string]bool)
	for _, g := range result {
		for _, p := range g.Pools {
			for _, n := range p.Nodes {
				referenced[n.NodeID] = true
			}
		}
	}
	var unassigned []ResourceNodeView
	for _, ent := range entities {
		if !referenced[ent.NodeID] {
			row := safeResourceNodeView(ent)
			if rn := runtimeNames[ent.NodeID]; rn != "" {
				row.RuntimeName = rn
			}
			unassigned = append(unassigned, row)
		}
	}
	if len(unassigned) > 0 {
		result = append(result, ResourceGroupView{
			PoolGroupID: "unassigned",
			Name:        "未分配节点",
			Enabled:     true,
			Pools: []ResourcePoolView{{
				PoolID:      "unassigned",
				PoolGroupID: "unassigned",
				Name:        "未分配节点",
				Enabled:     true,
				Nodes:       unassigned,
			}},
		})
	}

	return result
}

func entitiesFromSnapshots(snapshots []NodeSnapshotView) []NodeEntity {
	out := make([]NodeEntity, 0, len(snapshots))
	for _, s := range snapshots {
		id := strings.TrimSpace(s.NodeID)
		if id == "" {
			id = BuildNodeEntityID(s.Protocol, s.Server, s.Port)
		}
		if id == "" {
			continue
		}
		var loc map[string]any
		if s.CountryCode != "" {
			loc = map[string]any{
				"countryCode": s.CountryCode,
				"countryFlag": s.CountryFlag,
			}
		}
		name := firstNonEmpty(s.Label, s.Name, id, s.Identity)
		out = append(out, NodeEntity{
			NodeID:       id,
			Name:         name,
			RuntimeName:  s.Name,
			Protocol:     s.Protocol,
			Server:       s.Server,
			Port:         s.Port,
			ExitIdentity: firstNonEmpty(s.Identity, BuildExitIdentity(s.Protocol, s.Server, s.Port)),
			Location:     loc,
			Lifecycle:    "active",
		})
	}
	return out
}

func resolveStableSnapshotNodeID(s NodeSnapshotView, entities []NodeEntity) string {
	candidates := []string{s.NodeID, s.Identity, s.Name, s.Label}
	for _, c := range candidates {
		trimmed := strings.TrimSpace(c)
		if trimmed == "" {
			continue
		}
		for _, ent := range entities {
			if ent.NodeID == trimmed || ent.RuntimeName == trimmed || ent.Name == trimmed || ent.ExitIdentity == trimmed {
				return ent.NodeID
			}
		}
	}
	return firstNonEmpty(s.NodeID, s.Identity, s.Name)
}

func deriveResourceMemberships(
	pools []ProxyPoolEntity,
	assignments []AccountEgressAssignment,
	snapByNodeID map[string]NodeSnapshotView,
) []ResourceMembership {
	var rows []ResourceMembership
	if len(assignments) > 0 {
		for _, a := range assignments {
			pid := strings.TrimSpace(a.PoolID)
			if pid == "" {
				continue
			}
			for _, p := range pools {
				if p.PoolID != pid {
					continue
				}
				for _, nid := range p.NodeIDs {
					rows = append(rows, ResourceMembership{
						PoolID:      pid,
						NodeID:      nid,
						Enabled:     true,
						AccountRefs: []string{a.AccountRef},
					})
				}
			}
		}
	}
	if len(rows) > 0 {
		return rows
	}
	for _, p := range pools {
		for _, nid := range p.NodeIDs {
			var refs []string
			if snap, ok := snapByNodeID[nid]; ok {
				for _, acct := range snap.Accounts {
					if strings.TrimSpace(acct.AccountRef) != "" {
						refs = append(refs, strings.TrimSpace(acct.AccountRef))
					}
				}
			}
			rows = append(rows, ResourceMembership{
				PoolID:      p.PoolID,
				NodeID:      nid,
				Enabled:     true,
				AccountRefs: refs,
			})
		}
	}
	return rows
}

func deriveSharedHealthAndPolicy(
	snapshots []NodeSnapshotView,
	entities []NodeEntity,
) (map[string]map[string]any, map[string]map[string]any) {
	healthMap := make(map[string]map[string]any, len(snapshots))
	policyMap := make(map[string]map[string]any)
	for _, s := range snapshots {
		id := resolveStableSnapshotNodeID(s, entities)
		if id == "" {
			continue
		}
		status := "unknown"
		switch {
		case s.Blocked:
			status = "blocked"
		case s.Cooling:
			status = "cooling"
		case s.Probe != nil && !s.Probe.OK:
			status = "unreachable"
		case s.Probe != nil && s.Probe.OK:
			status = "healthy"
		}
		h := map[string]any{"status": status}
		if s.Probe != nil {
			h["latencyMs"] = s.Probe.LatencyMS
			h["at"] = s.Probe.At
		}
		healthMap[id] = h
		if s.Blocked {
			policyMap[id] = map[string]any{
				"disabled": true,
				"reason":   firstNonEmpty(s.BlockedReason, s.BlockedDetail),
			}
		}
	}
	return healthMap, policyMap
}

func safeResourceNodeView(n NodeEntity) ResourceNodeView {
	return ResourceNodeView{
		NodeID:       n.NodeID,
		Name:         n.Name,
		Protocol:     n.Protocol,
		Server:       n.Server,
		Port:         n.Port,
		ExitIdentity: n.ExitIdentity,
		Location:     n.Location,
		Source:       n.Source,
		Lifecycle:    n.Lifecycle,
		Tags:         n.Tags,
	}
}

func buildResourcePoolView(
	pool ProxyPoolEntity,
	nodesByID map[string]NodeEntity,
	memberships []ResourceMembership,
	healthMap map[string]map[string]any,
	policyMap map[string]map[string]any,
	runtimeNames map[string]string,
) ResourcePoolView {
	seenIDs := make(map[string]struct{})
	var nodeIDs []string
	for _, nid := range pool.NodeIDs {
		trimmed := strings.TrimSpace(nid)
		if trimmed != "" {
			if _, ok := seenIDs[trimmed]; !ok {
				seenIDs[trimmed] = struct{}{}
				nodeIDs = append(nodeIDs, trimmed)
			}
		}
	}
	for _, m := range memberships {
		if m.PoolID == pool.PoolID && m.NodeID != "" {
			if _, ok := seenIDs[m.NodeID]; !ok {
				seenIDs[m.NodeID] = struct{}{}
				nodeIDs = append(nodeIDs, m.NodeID)
			}
		}
	}

	nodeRows := make([]ResourceNodeView, 0, len(nodeIDs))
	for _, nid := range nodeIDs {
		ent, exists := nodesByID[nid]
		if !exists {
			continue
		}
		row := safeResourceNodeView(ent)
		if rn := runtimeNames[nid]; rn != "" {
			row.RuntimeName = rn
		}
		var mem *ResourceMembership
		for _, m := range memberships {
			if m.PoolID == pool.PoolID && m.NodeID == nid {
				copied := m
				mem = &copied
				break
			}
		}
		if mem != nil {
			row.Membership = &ResourceMembership{
				PoolID:   pool.PoolID,
				NodeID:   nid,
				Enabled:  mem.Enabled,
				Priority: mem.Priority,
				Weight:   mem.Weight,
			}
		}
		if h, ok := healthMap[nid]; ok {
			row.NodeHealth = h
		}
		if p, ok := policyMap[nid]; ok {
			row.NodePolicy = p
		}
		row.ReferenceCounts = computeReferenceCounts(memberships, pool.PoolID, nid, mem == nil)
		nodeRows = append(nodeRows, row)
	}

	return ResourcePoolView{
		PoolID:                      pool.PoolID,
		PoolGroupID:                 pool.PoolGroupID,
		Name:                        firstNonEmpty(pool.Name, pool.PoolID),
		SelectionModeDefault:        pool.SelectionModeDefault,
		RotationPolicy:              pool.RotationPolicy,
		HealthPolicy:                pool.HealthPolicy,
		UpstreamCompatibilityPolicy: pool.UpstreamCompatibilityPolicy,
		Enabled:                     pool.Enabled,
		Nodes:                       nodeRows,
	}
}

func computeReferenceCounts(memberships []ResourceMembership, poolID, nodeID string, fallback bool) *ResourceReferenceCounts {
	poolSet := make(map[string]struct{})
	acctSet := make(map[string]struct{})
	sessSet := make(map[string]struct{})
	if fallback && poolID != "" {
		poolSet[poolID] = struct{}{}
	}
	for _, m := range memberships {
		if m.NodeID != nodeID {
			continue
		}
		if strings.TrimSpace(m.PoolID) != "" {
			poolSet[strings.TrimSpace(m.PoolID)] = struct{}{}
		}
		for _, a := range m.AccountRefs {
			if strings.TrimSpace(a) != "" {
				acctSet[strings.TrimSpace(a)] = struct{}{}
			}
		}
		for _, s := range m.SessionIDs {
			if strings.TrimSpace(s) != "" {
				sessSet[strings.TrimSpace(s)] = struct{}{}
			}
		}
	}
	return &ResourceReferenceCounts{
		Pools:    len(poolSet),
		Accounts: len(acctSet),
		Sessions: len(sessSet),
	}
}

// BuildAccountDiagnosticView 查询并返回账号/上游/节点维度的诊断证据（不作全局阻断）。
func BuildAccountDiagnosticView(ctx context.Context, store *EvidenceStore, query AccountDiagnosticQuery) AccountDiagnosticView {
	norm := AccountDiagnosticQuery{
		Provider:   strings.ToLower(strings.TrimSpace(query.Provider)),
		AccountRef: strings.TrimSpace(query.AccountRef),
		UpstreamID: strings.ToLower(strings.TrimSpace(query.UpstreamID)),
		NodeID:     strings.TrimSpace(query.NodeID),
	}
	var evidence []UpstreamEvidenceEntry
	if store != nil {
		evidence = store.ListEvidence(ctx, ScopedEvidenceQuery{
			IncludeLegacy: false,
			Provider:      norm.Provider,
			AccountRef:    norm.AccountRef,
			UpstreamID:    norm.UpstreamID,
			NodeID:        norm.NodeID,
		})
	} else {
		evidence = []UpstreamEvidenceEntry{}
	}
	denied := 0
	allowed := 0
	for _, entry := range evidence {
		switch entry.Status {
		case "blocked":
			denied++
		case "ok", "reachable":
			allowed++
		}
	}
	return AccountDiagnosticView{
		Scope:    "account_diagnostic",
		Query:    norm,
		Evidence: evidence,
		Summary: DiagnosticSummary{
			Total:   len(evidence),
			Denied:  denied,
			Allowed: allowed,
		},
		GlobalBlocking: false,
	}
}

func errorsIsContractCode(err error) string {
	var ce *ContractError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return ""
}
