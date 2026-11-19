package nativeresources

import (
	"context"
	"strings"
)

// SkillHealthRecord 是 skill doctor 的单条资源结果。
type SkillHealthRecord struct {
	ManagedRecord
	Healthy bool `json:"healthy"`
}

// SkillDoctorResponse 是 skill doctor 的公开结果。
type SkillDoctorResponse struct {
	Revision  int                 `json:"revision"`
	Healthy   bool                `json:"healthy"`
	Resources []SkillHealthRecord `json:"resources"`
}

// SkillList 返回托管 Skill 列表与当前 revision。
func (s *Service) SkillList(ctx context.Context, provider string) (int, []ManagedRecord, error) {
	if s == nil {
		return 0, nil, fail("skill_manager_unavailable")
	}
	return s.skills.list(ctx, provider)
}

// SkillDoctor 检查托管 Skill 的投影是否与 enabled 状态一致。
func (s *Service) SkillDoctor(ctx context.Context, provider string) (SkillDoctorResponse, error) {
	if s == nil {
		return SkillDoctorResponse{}, fail("skill_manager_unavailable")
	}
	revision, records, err := s.skills.list(ctx, provider)
	if err != nil {
		return SkillDoctorResponse{}, err
	}
	resources := make([]SkillHealthRecord, 0, len(records))
	healthy := true
	for _, record := range records {
		entry := SkillHealthRecord{ManagedRecord: record}
		pkg, pkgErr := s.skills.packageFor(record)
		if pkgErr == nil {
			adapter := skillProjections[record.Mode]
			if adapter != nil {
				state := adapter.inspect(record, pkg)
				entry.Projection = state
				if record.Enabled {
					entry.Healthy = state == "present"
				} else {
					entry.Healthy = state == "absent"
				}
			}
		}
		if !entry.Healthy {
			healthy = false
		}
		resources = append(resources, entry)
	}
	return SkillDoctorResponse{Revision: revision, Healthy: healthy, Resources: resources}, nil
}

// SkillProviderStates 返回每个 Provider 的 skill 能力状态（unsupported 由调用方过滤）。
func (s *Service) SkillProviderStates(ctx context.Context) (map[string]ResourceCapability, error) {
	if s == nil {
		return nil, fail("skill_manager_unavailable")
	}
	report, err := s.Report(ctx)
	if err != nil {
		return nil, err
	}
	states := make(map[string]ResourceCapability, len(report.Providers))
	for _, row := range report.Providers {
		if capability, ok := row.Resources["skill"]; ok {
			state := strings.ToLower(strings.TrimSpace(capability.State))
			if state != "unsupported" {
				states[row.Provider] = capability.ResourceCapability
			}
		}
	}
	return states, nil
}

// SkillProviderReport 返回包含 unsupported 在内的全部 Provider skill 能力。
func (s *Service) SkillProviderReport(ctx context.Context) ([]ProviderReportRow, error) {
	if s == nil {
		return nil, fail("skill_manager_unavailable")
	}
	report, err := s.Report(ctx)
	if err != nil {
		return nil, err
	}
	rows := make([]ProviderReportRow, 0, len(report.Providers))
	for _, row := range report.Providers {
		if _, ok := row.Resources["skill"]; ok {
			rows = append(rows, row)
		}
	}
	return rows, nil
}
