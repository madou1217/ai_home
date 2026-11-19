package nativeresources

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// NativePluginList 返回托管 native plugin 列表与 revision。
func (s *Service) NativePluginList(ctx context.Context, provider, host string) (int, []ManagedRecord, error) {
	if s == nil {
		return 0, nil, fail("native_plugin_manager_unavailable")
	}
	return s.plugins.list(ctx, provider, host)
}

// NativePluginInstall 安装一个 canonical 包到指定 provider 或 host。
func (s *Service) NativePluginInstall(ctx context.Context, source, provider, host string) (PluginOperateResult, error) {
	if s == nil {
		return PluginOperateResult{}, fail("native_plugin_manager_unavailable")
	}
	return s.plugins.install(ctx, source, provider, host)
}

// NativePluginChange 执行 enable/disable/remove。
func (s *Service) NativePluginChange(ctx context.Context, id, provider, host, action string) (ManagedRecord, error) {
	if s == nil {
		return ManagedRecord{}, fail("native_plugin_manager_unavailable")
	}
	return s.plugins.change(ctx, id, provider, host, action)
}

// NativePluginDoctor 检查托管记录的实际投影状态。
func (s *Service) NativePluginDoctor(ctx context.Context, provider, host string) (NativePluginDoctorResponse, error) {
	if s == nil {
		return NativePluginDoctorResponse{}, fail("native_plugin_manager_unavailable")
	}
	revision, records, err := s.plugins.list(ctx, provider, host)
	if err != nil {
		return NativePluginDoctorResponse{}, err
	}
	resources := make([]NativePluginHealthRecord, 0, len(records))
	healthy := true
	for _, record := range records {
		entry := NativePluginHealthRecord{ManagedRecord: record}
		adapter, aCtx, resolveErr := s.plugins.resolve(record.Provider, record.Host)
		if resolveErr == nil && adapter != nil {
			state := adapter.inspect(aCtx, record)
			entry.Projection = state
			if record.Enabled {
				entry.Healthy = state == "present"
			} else {
				entry.Healthy = state == "absent"
			}
		}
		if !entry.Healthy {
			healthy = false
		}
		resources = append(resources, entry)
	}
	return NativePluginDoctorResponse{Revision: revision, Healthy: healthy, Resources: resources}, nil
}

// NativePluginHealthRecord 是 native plugin doctor 的单条结果。
type NativePluginHealthRecord struct {
	ManagedRecord
	Healthy bool `json:"healthy"`
}

// NativePluginDoctorResponse 是 native plugin doctor 的公开结果。
type NativePluginDoctorResponse struct {
	Revision  int                        `json:"revision"`
	Healthy   bool                       `json:"healthy"`
	Resources []NativePluginHealthRecord `json:"resources"`
}

// InspectPortablePlugin 读取 canonical 包并返回各 host 的投影就绪状态。
func (s *Service) InspectPortablePlugin(source string) (map[string]any, error) {
	pkg, err := readPluginPackage(source)
	if err != nil {
		return nil, err
	}
	reports := inspectPortablePlugin(pkg)
	hosts := make(map[string]any, len(reports))
	for host, report := range reports {
		item := map[string]any{"state": report.State}
		if report.Entry != "" {
			item["entry"] = report.Entry
		}
		if report.Reason != "" {
			item["reason"] = report.Reason
		}
		hosts[host] = item
	}
	return map[string]any{"pluginId": pkg.ID, "version": pkg.Version, "digest": pkg.Digest, "hosts": hosts}, nil
}

// ProjectPortablePlugin 把 canonical 包复制到目标目录并写入 host-projection.json。
func (s *Service) ProjectPortablePlugin(source, host, outputDir string) (map[string]any, error) {
	inspect, err := s.InspectPortablePlugin(source)
	if err != nil {
		return nil, err
	}
	hosts, _ := inspect["hosts"].(map[string]any)
	item, _ := hosts[strings.ToLower(strings.TrimSpace(host))].(map[string]any)
	if item == nil {
		return nil, fail("portable_plugin_host_unknown")
	}
	if stringValueOf(item["state"]) != "projection-ready" {
		return nil, fail("portable_plugin_projection_unavailable")
	}
	pkg, err := readPluginPackage(source)
	if err != nil {
		return nil, err
	}
	target := strings.TrimSpace(outputDir)
	if target == "" {
		return nil, fail("native_plugin_output_required")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return nil, fail("native_plugin_output_failed")
	}
	temporary := target + ".tmp"
	_ = os.RemoveAll(temporary)
	if err := copyPluginPackage(pkg, temporary); err != nil {
		_ = os.RemoveAll(temporary)
		return nil, err
	}
	document := map[string]any{"host": strings.ToLower(strings.TrimSpace(host)), "pluginId": inspect["pluginId"], "entry": item["entry"], "state": item["state"]}
	encoded, _ := json.MarshalIndent(document, "", "  ")
	if err := os.WriteFile(filepath.Join(temporary, "host-projection.json"), encoded, 0o600); err != nil {
		_ = os.RemoveAll(temporary)
		return nil, fail("native_plugin_output_failed")
	}
	_ = os.RemoveAll(target)
	if err := os.Rename(temporary, target); err != nil {
		_ = os.RemoveAll(temporary)
		return nil, fail("native_plugin_output_failed")
	}
	return map[string]any{"host": document["host"], "pluginId": document["pluginId"], "entry": document["entry"], "state": document["state"], "outputDir": target}, nil
}

// NativePluginProviderReport 返回 Provider/Host 的 native plugin 能力。
func (s *Service) NativePluginProviderReport(ctx context.Context) ([]ProviderReportRow, []HostReportRow, error) {
	if s == nil {
		return nil, nil, fail("native_plugin_manager_unavailable")
	}
	report, err := s.Report(ctx)
	if err != nil {
		return nil, nil, err
	}
	providers := make([]ProviderReportRow, 0, len(report.Providers))
	for _, row := range report.Providers {
		if _, ok := row.Resources["plugin"]; ok {
			providers = append(providers, row)
		}
	}
	return providers, report.Hosts, nil
}

func stringValueOf(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
