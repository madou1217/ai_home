package nativeresources

import (
	"context"
	"sort"
	"strings"
)

// SkillRepoProviderState 描述某个 Skill 在单个 Provider 上的安装状态。
type SkillRepoProviderState struct {
	Provider  string `json:"provider"`
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Enabled   bool   `json:"enabled"`
	Mode      string `json:"mode,omitempty"`
	Digest    string `json:"digest,omitempty"`
}

// SkillRepoEntry 是 Skill 仓中的一条可用资源及其 Provider 矩阵。
type SkillRepoEntry struct {
	InstallCandidate
	Providers []SkillRepoProviderState `json:"providers"`
}

// SkillRepo 返回可用 Skill 仓与每个 Provider 的安装/启用状态。
func (s *Service) SkillRepo(ctx context.Context) ([]SkillRepoEntry, error) {
	if s == nil {
		return nil, fail("skill_manager_unavailable")
	}
	report, err := s.Report(ctx)
	if err != nil {
		return nil, err
	}
	records := make(map[string]ManagedRecord, len(report.Managed.Skill))
	for _, record := range report.Managed.Skill {
		if record.Removed {
			continue
		}
		records[record.ID+"\x00"+record.Provider] = record
	}
	out := make([]SkillRepoEntry, 0)
	for _, candidate := range report.InstallCandidates {
		if candidate.Kind != "skill" {
			continue
		}
		entry := SkillRepoEntry{
			InstallCandidate: candidate,
			Providers:        make([]SkillRepoProviderState, 0, len(report.Providers)),
		}
		for _, row := range report.Providers {
			capability, ok := row.Resources["skill"]
			state := SkillRepoProviderState{
				Provider:  row.Provider,
				Supported: ok && capability.State != "" && capability.State != "unsupported",
			}
			if record, found := records[candidate.ID+"\x00"+row.Provider]; found {
				state.Installed = true
				state.Enabled = record.Enabled
				state.Mode = record.Mode
				state.Digest = record.Digest
			}
			entry.Providers = append(entry.Providers, state)
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ID != out[j].ID {
			return out[i].ID < out[j].ID
		}
		return out[i].Source < out[j].Source
	})
	return out, nil
}

// SkillCandidateSource 把 Skill 仓里的 ID 解析成安装源路径。
func (s *Service) SkillCandidateSource(id string) (string, bool) {
	if s == nil {
		return "", false
	}
	normalized := strings.TrimSpace(id)
	if normalized == "" {
		return "", false
	}
	for _, candidate := range s.installCandidates() {
		if candidate.Kind == "skill" && candidate.ID == normalized {
			return candidate.Source, true
		}
	}
	return "", false
}
