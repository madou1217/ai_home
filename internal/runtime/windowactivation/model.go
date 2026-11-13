package windowactivation

import (
	"regexp"
	"sort"
	"strings"
)

// ProbeModelResolution 记录从账号模型目录解析出的探测模型与来源。
type ProbeModelResolution struct {
	Model  string
	Source string
}

// ResolveProbeModel 依据规格与账号模型目录解析本次探测使用的最小模型。
// 解析顺序：spec.Model -> spec.ModelCandidates -> ProbeModelPattern 字典序首项 -> unavailable；
// 目录未知（空切片）时返回 ("unknown_catalog") 由上游给出真实结论。
func ResolveProbeModel(spec ProbeSpec, accountModels []string) ProbeModelResolution {
	candidates := make([]string, 0, 1+len(spec.ModelCandidates))
	if primary := strings.TrimSpace(spec.Model); primary != "" {
		candidates = append(candidates, primary)
	}
	for _, candidate := range spec.ModelCandidates {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}

	available := make(map[string]struct{}, len(accountModels))
	for _, item := range accountModels {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			available[trimmed] = struct{}{}
		}
	}

	if len(available) == 0 {
		if len(candidates) > 0 {
			return ProbeModelResolution{Model: candidates[0], Source: "unknown_catalog"}
		}
		return ProbeModelResolution{Model: "", Source: "unavailable"}
	}

	primary := strings.TrimSpace(spec.Model)
	if primary != "" {
		if _, ok := available[primary]; ok {
			return ProbeModelResolution{Model: primary, Source: "spec"}
		}
	}
	for _, candidate := range candidates {
		if _, ok := available[candidate]; ok {
			return ProbeModelResolution{Model: candidate, Source: "candidate"}
		}
	}

	patternSource := strings.TrimSpace(spec.ProbeModelPattern)
	if patternSource != "" {
		if compiled, err := regexp.Compile(patternSource); err == nil {
			matched := make([]string, 0, len(available))
			for model := range available {
				if compiled.MatchString(model) {
					matched = append(matched, model)
				}
			}
			if len(matched) > 0 {
				sort.Strings(matched)
				return ProbeModelResolution{Model: matched[0], Source: "pattern"}
			}
		}
	}

	return ProbeModelResolution{Model: "", Source: "unavailable"}
}
