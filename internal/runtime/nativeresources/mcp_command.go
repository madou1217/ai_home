package nativeresources

import (
	"context"
	"reflect"
	"strings"
)

// MCPProjectionHealth 是单个投影文件的健康结论。
type MCPProjectionHealth struct {
	Target  string `json:"target"`
	Healthy bool   `json:"healthy"`
	Error   string `json:"error,omitempty"`
}

// MCPHealthRecord 是 mcp doctor 的单条资源结果。
type MCPHealthRecord struct {
	PublicMCPRecord
	Projections []MCPProjectionHealth `json:"projections"`
	Healthy     bool                  `json:"healthy"`
}

// MCPDoctorResponse 是 mcp doctor 的公开结果。
type MCPDoctorResponse struct {
	Revision  int               `json:"revision"`
	Healthy   bool              `json:"healthy"`
	Resources []MCPHealthRecord `json:"resources"`
}

// MCPList 返回托管 MCP 资源列表与 revision。
func (s *Service) MCPList(ctx context.Context, provider string) (int, []PublicMCPRecord, error) {
	if s == nil {
		return 0, nil, fail("mcp_manager_unavailable")
	}
	records, err := s.mcps.list(ctx, provider)
	if err != nil {
		return 0, nil, err
	}
	state, err := s.store.get(ctx)
	if err != nil {
		return 0, nil, err
	}
	return state.Revision, records, nil
}

// MCPAdd 保存（不启用）一个 MCP stdio server 定义。
func (s *Service) MCPAdd(ctx context.Context, name string, spec MCPServerSpec, provider string) (PublicMCPRecord, error) {
	if s == nil {
		return PublicMCPRecord{}, fail("mcp_manager_unavailable")
	}
	return s.mcps.add(ctx, name, spec, provider)
}

// MCPChange 执行 enable/disable/remove。
func (s *Service) MCPChange(ctx context.Context, name, provider, action string) (PublicMCPRecord, error) {
	if s == nil {
		return PublicMCPRecord{}, fail("mcp_manager_unavailable")
	}
	return s.mcps.change(ctx, name, provider, action)
}

// MCPTest 初始化本地 stdio server 并列出工具。
func (s *Service) MCPTest(ctx context.Context, name, provider string) (map[string]any, error) {
	if s == nil {
		return nil, fail("mcp_manager_unavailable")
	}
	return s.mcps.test(ctx, name, provider)
}

// MCPTools 列出本地 stdio server 的工具。
func (s *Service) MCPTools(ctx context.Context, name, provider string) ([]map[string]any, error) {
	if s == nil {
		return nil, fail("mcp_manager_unavailable")
	}
	return s.mcps.tools(ctx, name, provider)
}

// MCPCall 调用本地 stdio server 的一个工具。
func (s *Service) MCPCall(ctx context.Context, name, provider, tool string, args map[string]any) (map[string]any, error) {
	if s == nil {
		return nil, fail("mcp_manager_unavailable")
	}
	return s.mcps.call(ctx, name, provider, tool, args)
}

// MCPDoctor 比较托管定义与各投影文件中的实际条目。
func (s *Service) MCPDoctor(ctx context.Context, provider string) (MCPDoctorResponse, error) {
	if s == nil {
		return MCPDoctorResponse{}, fail("mcp_manager_unavailable")
	}
	state, err := s.store.get(ctx)
	if err != nil {
		return MCPDoctorResponse{}, err
	}
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	resources := make([]MCPHealthRecord, 0)
	healthy := true
	for _, record := range state.Resources {
		if record.Kind != "mcp" || (normalizedProvider != "" && record.Provider != normalizedProvider) {
			continue
		}
		entry := MCPHealthRecord{PublicMCPRecord: toPublicMCPRecord(record), Projections: []MCPProjectionHealth{}}
		projection, adapter, boundaryErr := s.mcps.boundary(record.Provider)
		if boundaryErr != nil || projection == nil || adapter == nil {
			entry.Healthy = false
			healthy = false
			resources = append(resources, entry)
			continue
		}
		expected := adapter.encode(record.Server)
		targets := make([]string, 0, 1+len(record.Projections))
		if !projectionSupportsPath(projection) {
			entry.Healthy = false
			healthy = false
			resources = append(resources, entry)
			continue
		}
		if target, targetErr := s.mcps.targetFile(record.Provider, s.hostHomeDir); targetErr == nil && target != "" {
			targets = append(targets, target)
		}
		targets = append(targets, record.Projections...)
		seen := map[string]bool{}
		entryHealthy := true
		for _, target := range targets {
			if seen[target] {
				continue
			}
			seen[target] = true
			projectionHealth := MCPProjectionHealth{Target: target}
			_, _, servers, readErr := adapter.read(target)
			if readErr != nil {
				projectionHealth.Healthy = false
				projectionHealth.Error = nativeResourceErrorCode(readErr)
			} else {
				current, present := servers[record.ID]
				if record.Enabled {
					projectionHealth.Healthy = present && reflect.DeepEqual(current, expected)
				} else {
					projectionHealth.Healthy = !present
				}
			}
			if !projectionHealth.Healthy {
				entryHealthy = false
			}
			entry.Projections = append(entry.Projections, projectionHealth)
		}
		entry.Healthy = entryHealthy
		if !entryHealthy {
			healthy = false
		}
		resources = append(resources, entry)
	}
	return MCPDoctorResponse{Revision: state.Revision, Healthy: healthy, Resources: resources}, nil
}

// MCPProviderReport 返回包含 unsupported 在内的全部 Provider MCP 能力。
func (s *Service) MCPProviderReport(ctx context.Context) ([]ProviderReportRow, error) {
	if s == nil {
		return nil, fail("mcp_manager_unavailable")
	}
	report, err := s.Report(ctx)
	if err != nil {
		return nil, err
	}
	rows := make([]ProviderReportRow, 0, len(report.Providers))
	for _, row := range report.Providers {
		if _, ok := row.Resources["mcp"]; ok {
			rows = append(rows, row)
		}
	}
	return rows, nil
}

func projectionSupportsPath(projection any) bool {
	// NativeMCPProjection 的路径校验已在 mcpManager.targetFile 中完成；
	// 这里只保留钩子，避免把类型断言耦合到调用方。
	return projection != nil
}

func nativeResourceErrorCode(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
