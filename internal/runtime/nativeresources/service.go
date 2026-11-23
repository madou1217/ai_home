package nativeresources

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// Config 配置 NativeResources 统一管理服务。
type Config struct {
	AIHomeDir       string
	HostHomeDir     string
	Catalog         *providers.Catalog
	Env             map[string]string
	Runner          CommandRunner
	SourceRoot      string
	DemoRoot        string // Deprecated: source-root alias for existing callers; never enables demos.
	NativeBinaries  map[string]string
	SkipDoctorProbe bool
}

// Service 提供 WebUI 原生资源（plugin / skill / mcp）的只读探测、生命周期操作。
type Service struct {
	aiHomeDir       string
	hostHomeDir     string
	catalog         *providers.Catalog
	env             map[string]string
	runner          CommandRunner
	sourceRoot      string
	skipDoctorProbe bool
	store           *managedStore
	plugins         *nativePluginManager
	skills          *skillManager
	mcps            *mcpManager
	doctor          *doctorCache
}

// NewService 初始化原生资源服务（共享同一 managedStore 与 SWR Doctor 缓存）。
func NewService(cfg Config) (*Service, error) {
	if strings.TrimSpace(cfg.AIHomeDir) == "" || strings.TrimSpace(cfg.HostHomeDir) == "" {
		return nil, fail("native_resource_home_required")
	}
	catalog := cfg.Catalog
	if catalog == nil {
		c, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return nil, err
		}
		catalog = c
	}
	env := cfg.Env
	if env == nil {
		env = envFromOS()
	}
	runner := cfg.Runner
	if runner == nil {
		runner = defaultCommandRunner{}
	}
	sourceRoot := strings.TrimSpace(cfg.SourceRoot)
	if sourceRoot == "" {
		sourceRoot = strings.TrimSpace(cfg.DemoRoot)
	}
	if sourceRoot == "" {
		sourceRoot = resolveSourceRoot(env)
	}

	store, err := newManagedStore(cfg.AIHomeDir)
	if err != nil {
		return nil, err
	}

	defs := catalog.List()
	pluginReg := make(map[string]ResourceCapability, len(defs))
	skillReg := make(map[string]ResourceCapability, len(defs))
	mcpReg := make(map[string]ResourceCapability, len(defs))
	for _, d := range defs {
		pluginReg[d.ID] = nativeResourceStatus(d, "plugin")
		skillReg[d.ID] = nativeResourceStatus(d, "skill")
		mcpReg[d.ID] = nativeResourceStatus(d, "mcp")
	}

	pm, err := newNativePluginManager(cfg.AIHomeDir, cfg.HostHomeDir, pluginReg, store, catalog, env, runner, cfg.NativeBinaries)
	if err != nil {
		return nil, err
	}
	sm, err := newSkillManager(cfg.AIHomeDir, cfg.HostHomeDir, skillReg, store)
	if err != nil {
		return nil, err
	}
	mm, err := newMCPManager(cfg.AIHomeDir, cfg.HostHomeDir, mcpReg)
	if err != nil {
		return nil, err
	}

	return &Service{
		aiHomeDir:       cfg.AIHomeDir,
		hostHomeDir:     cfg.HostHomeDir,
		catalog:         catalog,
		env:             env,
		runner:          runner,
		sourceRoot:      sourceRoot,
		skipDoctorProbe: cfg.SkipDoctorProbe,
		store:           store,
		plugins:         pm,
		skills:          sm,
		mcps:            mm,
		doctor:          newDoctorCache(),
	}, nil
}

func envFromOS() map[string]string {
	out := make(map[string]string)
	for _, entry := range os.Environ() {
		if k, v, ok := strings.Cut(entry, "="); ok {
			out[k] = v
		}
	}
	return out
}

func resolveSourceRoot(env map[string]string) string {
	if root := strings.TrimSpace(env["AIH_PACKAGE_ROOT"]); root != "" {
		if abs, err := filepath.Abs(root); err == nil {
			return abs
		}
	}
	// 后台/launchd 启动时 cwd 可能是 "/"，不能只靠 cwd 判断安装包根目录。
	// 依次从 cwd 与可执行文件所在目录向上找带 package.json + lib 的目录。
	starts := make([]string, 0, 2)
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, start := range starts {
		cur := start
		for i := 0; i < 6; i++ {
			if _, err := os.Stat(filepath.Join(cur, "package.json")); err == nil {
				if _, err2 := os.Stat(filepath.Join(cur, "lib")); err2 == nil {
					return cur
				}
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
	}
	if len(starts) > 0 {
		return starts[0]
	}
	return "."
}

// ProviderResourceReport 描述报告中单类资源的完整状态（能力 + 已托管记录）。
type ProviderResourceReport struct {
	ResourceCapability
	Managed any `json:"managed"`
}

// ProviderReportRow 描述报告中的 Provider 行。
type ProviderReportRow struct {
	Provider  string                            `json:"provider"`
	Source    string                            `json:"source"`
	Runtime   RuntimeProbeResult                `json:"runtime"`
	Resources map[string]ProviderResourceReport `json:"resources"`
}

// HostPluginReport 描述 Host 行内的 plugin 资源项。
type HostPluginReport struct {
	Capability ResourceCapability `json:"capability"`
	Managed    []ManagedRecord    `json:"managed"`
}

// HostReportRow 描述报告中的 Host 行。
type HostReportRow struct {
	DoctorHostRow
	Resources map[string]HostPluginReport `json:"resources"`
}

// ManagedSummaryGroup 描述顶层 managed 汇总列表（目标路径仅暴露 basename）。
type ManagedSummaryGroup struct {
	Plugin []ManagedRecord   `json:"plugin"`
	Skill  []ManagedRecord   `json:"skill"`
	MCP    []PublicMCPRecord `json:"mcp"`
}

// ReportResponse 对应 GET /v1/management/webui/toolkit/native-resources 的完整 JSON 契约。
type ReportResponse struct {
	OK                bool                `json:"ok"`
	Source            string              `json:"source"`
	DemoSources       map[string]string   `json:"-"` // Deprecated: retained only for Go source compatibility; never populated.
	Providers         []ProviderReportRow `json:"providers"`
	Hosts             []HostReportRow     `json:"hosts"`
	Managed           ManagedSummaryGroup `json:"managed"`
	InstallCandidates []InstallCandidate  `json:"installCandidates"`
	Lifecycle         []string            `json:"lifecycle"`
	EvidenceBoundary  string              `json:"evidenceBoundary"`
}

// OperateInput 描述 POST /v1/management/webui/toolkit/native-resources 的操作请求。
type OperateInput struct {
	Kind     string         `json:"kind"`
	Action   string         `json:"action"`
	Provider string         `json:"provider"`
	Host     string         `json:"host"`
	Source   string         `json:"source"`
	ID       string         `json:"id"`
	Tool     string         `json:"tool"`
	Args     map[string]any `json:"args"`
}

// Selector 表示归一化的 provider 或 host 选择器。
type Selector struct {
	Provider string `json:"provider,omitempty"`
	Host     string `json:"host,omitempty"`
}

// OperateResponse 对应 POST /v1/management/webui/toolkit/native-resources 的响应。
type OperateResponse struct {
	OK        bool            `json:"ok"`
	Kind      string          `json:"kind"`
	Action    string          `json:"action"`
	Selection Selector        `json:"selection"`
	Result    any             `json:"result,omitempty"`
	Report    *ReportResponse `json:"report,omitempty"`
}

// Report 返回 60s SWR Doctor 能力探测结果 + 实时托管资源列表。
func (s *Service) Report(ctx context.Context) (ReportResponse, error) {
	doctor := s.doctor.getSWR(ctx, func(refreshCtx context.Context) DoctorSnapshot {
		return probeAllCapabilities(refreshCtx, s.catalog, s.hostHomeDir, s.env, s.runner, s.skipDoctorProbe)
	})

	_, pluginRecs, err := s.plugins.list(ctx, "", "")
	if err != nil {
		return ReportResponse{}, err
	}
	_, skillRecs, err := s.skills.list(ctx, "")
	if err != nil {
		return ReportResponse{}, err
	}
	mcpRecs, err := s.mcps.list(ctx, "")
	if err != nil {
		return ReportResponse{}, err
	}
	pluginRecs = s.plugins.describeAll(pluginRecs)
	skillRecs = s.skills.describeAll(skillRecs)

	provRows := make([]ProviderReportRow, 0, len(doctor.Providers))
	for _, row := range doctor.Providers {
		resMap := make(map[string]ProviderResourceReport, len(resourceTypes))
		for _, kind := range resourceTypes {
			capVal, ok := row.Resources[kind]
			if !ok {
				capVal = ResourceCapability{State: "unsupported", Reason: "resource_not_declared"}
			}
			var managedAny any
			switch kind {
			case "plugin":
				managedAny = filterRecordsByProvider(pluginRecs, row.Provider)
			case "skill":
				managedAny = filterRecordsByProvider(skillRecs, row.Provider)
			case "mcp":
				managedAny = filterMCPRecordsByProvider(mcpRecs, row.Provider)
			}
			resMap[kind] = ProviderResourceReport{
				ResourceCapability: capVal,
				Managed:            managedAny,
			}
		}
		provRows = append(provRows, ProviderReportRow{
			Provider:  row.Provider,
			Source:    row.Source,
			Runtime:   row.Runtime,
			Resources: resMap,
		})
	}

	hostRows := make([]HostReportRow, 0, len(doctor.HostAdapters))
	for _, row := range doctor.HostAdapters {
		capVal := ResourceCapability{State: "projection-only", Reason: row.Reason}
		if capVal.Reason == "" {
			capVal.Reason = "host_runtime_unavailable"
		}
		if row.State == "supported" {
			capVal = ResourceCapability{State: "supported"}
		}
		hostRows = append(hostRows, HostReportRow{
			DoctorHostRow: row,
			Resources: map[string]HostPluginReport{
				"plugin": {
					Capability: capVal,
					Managed:    filterRecordsByHost(pluginRecs, row.Host),
				},
			},
		})
	}

	return ReportResponse{
		OK:        true,
		Source:    doctor.Source,
		Providers: provRows,
		Hosts:     hostRows,
		Managed: ManagedSummaryGroup{
			Plugin: sanitizeSummaryTargets(pluginRecs),
			Skill:  sanitizeSummaryTargets(skillRecs),
			MCP:    mcpRecs,
		},
		InstallCandidates: s.installCandidates(),
		Lifecycle:         []string{"install", "enable", "disable", "remove"},
		EvidenceBoundary:  "management state and runtime declaration only; installed plugin execution requires separate verification",
	}, nil
}

func filterRecordsByProvider(records []ManagedRecord, provider string) []ManagedRecord {
	out := make([]ManagedRecord, 0)
	for _, r := range records {
		if r.Provider == provider {
			out = append(out, r)
		}
	}
	return out
}

func filterRecordsByHost(records []ManagedRecord, host string) []ManagedRecord {
	out := make([]ManagedRecord, 0)
	for _, r := range records {
		if r.Host == host {
			out = append(out, r)
		}
	}
	return out
}

func filterMCPRecordsByProvider(records []PublicMCPRecord, provider string) []PublicMCPRecord {
	out := make([]PublicMCPRecord, 0)
	for _, r := range records {
		if r.Provider == provider {
			out = append(out, r)
		}
	}
	return out
}

func sanitizeSummaryTargets(records []ManagedRecord) []ManagedRecord {
	out := make([]ManagedRecord, len(records))
	for i, r := range records {
		if r.Target != "" {
			r.Target = filepath.Base(r.Target)
		}
		out[i] = r
	}
	return out
}

// Operate 执行原生资源安装/启停/卸载、MCP 探针调用。
func (s *Service) Operate(ctx context.Context, input OperateInput) (OperateResponse, error) {
	kind := strings.ToLower(strings.TrimSpace(input.Kind))
	if kind != "plugin" && kind != "skill" && kind != "mcp" {
		return OperateResponse{}, fail("native_resource_kind_invalid")
	}
	sel, err := normalizeSelector(input.Provider, input.Host)
	if err != nil {
		return OperateResponse{}, err
	}
	action := strings.ToLower(strings.TrimSpace(input.Action))

	if action == "demo" {
		return OperateResponse{}, fail("native_resource_demo_removed")
	}
	if action == "" {
		return OperateResponse{}, fail("native_resource_action_required")
	}

	var result any
	id := strings.TrimSpace(input.ID)
	switch kind {
	case "plugin":
		if action == "install" {
			src, sErr := s.sourceFor(input.Source)
			if sErr != nil {
				return OperateResponse{}, sErr
			}
			result, err = s.plugins.install(ctx, src, sel.Provider, sel.Host)
		} else {
			result, err = s.plugins.change(ctx, id, sel.Provider, sel.Host, action)
		}
	case "skill":
		if action == "install" {
			src, sErr := s.sourceFor(input.Source)
			if sErr != nil {
				return OperateResponse{}, sErr
			}
			result, err = s.skills.install(ctx, src, sel.Provider, "", false)
		} else {
			result, err = s.skills.change(ctx, id, sel.Provider, action)
		}
	case "mcp":
		if id == "" {
			return OperateResponse{}, fail("native_resource_id_required")
		}
		switch action {
		case "install":
			src, sErr := s.sourceFor(input.Source)
			if sErr != nil {
				return OperateResponse{}, sErr
			}
			nodeBin := s.runner.FindNode()
			if nodeBin == "" {
				nodeBin = "node"
			}
			if _, addErr := s.mcps.add(ctx, id, MCPServerSpec{Command: nodeBin, Args: []string{src}}, sel.Provider); addErr != nil {
				return OperateResponse{}, addErr
			}
			result, err = s.mcps.change(ctx, id, sel.Provider, "enable")
		case "test":
			result, err = s.mcps.test(ctx, id, sel.Provider)
		case "tools":
			result, err = s.mcps.tools(ctx, id, sel.Provider)
		case "call":
			tool := strings.TrimSpace(input.Tool)
			if tool == "" {
				return OperateResponse{}, fail("native_resource_tool_required")
			}
			args := input.Args
			if args == nil {
				args = map[string]any{}
			}
			result, err = s.mcps.call(ctx, id, sel.Provider, tool, args)
		default:
			result, err = s.mcps.change(ctx, id, sel.Provider, action)
		}
	}
	if err != nil {
		return OperateResponse{}, err
	}
	rep, err := s.Report(ctx)
	if err != nil {
		return OperateResponse{}, err
	}
	return OperateResponse{
		OK:        true,
		Kind:      kind,
		Action:    action,
		Selection: sel,
		Result:    result,
		Report:    &rep,
	}, nil
}

func normalizeSelector(provider, host string) (Selector, error) {
	p := strings.ToLower(strings.TrimSpace(provider))
	h := strings.ToLower(strings.TrimSpace(host))
	if (p != "" && h != "") || (p == "" && h == "") {
		return Selector{}, fail("native_resource_selector_required")
	}
	return Selector{Provider: p, Host: h}, nil
}

func (s *Service) sourceFor(rawSource string) (string, error) {
	src := strings.TrimSpace(rawSource)
	if src == "" {
		return "", fail("native_resource_source_required")
	}
	if !filepath.IsAbs(src) {
		src = filepath.Join(s.sourceRoot, src)
	}
	candidate, err := filepath.Abs(src)
	if err != nil {
		return "", fail("native_resource_source_forbidden")
	}
	absRoot, err := filepath.Abs(s.sourceRoot)
	if err != nil {
		return "", fail("native_resource_source_forbidden")
	}
	rel, err := filepath.Rel(absRoot, candidate)
	if err != nil || rel == "" || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fail("native_resource_source_forbidden")
	}
	if _, err := os.Stat(candidate); err != nil {
		return "", fail("native_resource_source_missing")
	}
	return candidate, nil
}
