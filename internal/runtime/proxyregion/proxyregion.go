// Package proxyregion 解析并匹配临时代理池的地区范围。
//
// 语法：
//
//	us,sg            仅美国、新加坡（ISO 3166-1 alpha-2，2 字）
//	lax,sin          仅洛杉矶、新加坡（IATA 城市码，3 字）
//	us,sg,lax        国家与城市取并集
//	exclude:cn,ru    排除中国、俄罗斯（可混用城市码）
//	us,exclude:hk    仅美国，但排除香港
//
// 2 字 token 一律按国家码解释，3 字 token 一律按 IATA 城市码解释。
// 地区的判断依据是代理解析出的 country/cityCode，不是节点显示名。
package proxyregion

import (
	"errors"
	"fmt"
	"strings"
)

// Filter 是一次地区范围。Countries/Cities 为包含集；Exclude* 为排除集。
// 排除优先于包含；空包含集表示“全部（除排除项）”。
type Filter struct {
	Countries        []string `json:"countries,omitempty"`
	Cities           []string `json:"cities,omitempty"`
	ExcludeCountries []string `json:"excludeCountries,omitempty"`
	ExcludeCities    []string `json:"excludeCities,omitempty"`
}

// Empty 报告是否没有任何范围条件。
func (filter Filter) Empty() bool {
	return len(filter.Countries) == 0 && len(filter.Cities) == 0 &&
		len(filter.ExcludeCountries) == 0 && len(filter.ExcludeCities) == 0
}

// Match 判断一个代理解析出的国家/城市是否落在范围内。
//
// 规则：
//   - 排除优先；
//   - 有包含集时，必须命中某个包含国家或包含城市；
//   - 有排除集但地区未知时失败关闭（不能证明它不在排除范围）；
//   - 地区未知（空）且范围非空时不参与。
func (filter Filter) Match(country, cityCode string) bool {
	if filter.Empty() {
		return true
	}
	country = NormalizeCountry(country)
	cityCode = NormalizeCityCode(cityCode)
	if country == "" && cityCode == "" {
		return false
	}
	if len(filter.ExcludeCountries) > 0 && country == "" {
		return false
	}
	if len(filter.ExcludeCities) > 0 && cityCode == "" {
		return false
	}
	if contains(filter.ExcludeCountries, country) || contains(filter.ExcludeCities, cityCode) {
		return false
	}
	if len(filter.Countries) == 0 && len(filter.Cities) == 0 {
		return true
	}
	return contains(filter.Countries, country) || contains(filter.Cities, cityCode)
}

// Describe 输出可读的中文范围说明。
func (filter Filter) Describe() string {
	if filter.Empty() {
		return "全部出口"
	}
	var parts []string
	if len(filter.Countries) > 0 || len(filter.Cities) > 0 {
		labels := make([]string, 0, len(filter.Countries)+len(filter.Cities))
		for _, code := range filter.Countries {
			labels = append(labels, CountryLabel(code))
		}
		for _, code := range filter.Cities {
			labels = append(labels, CityLabel(code))
		}
		parts = append(parts, "仅 "+strings.Join(labels, "、"))
	}
	if len(filter.ExcludeCountries) > 0 || len(filter.ExcludeCities) > 0 {
		labels := make([]string, 0, len(filter.ExcludeCountries)+len(filter.ExcludeCities))
		for _, code := range filter.ExcludeCountries {
			labels = append(labels, CountryLabel(code))
		}
		for _, code := range filter.ExcludeCities {
			labels = append(labels, CityLabel(code))
		}
		parts = append(parts, "排除 "+strings.Join(labels, "、"))
	}
	return strings.Join(parts, "；")
}

// Parse 解析 --proxy/--selector 的值。
//
// 返回值 isFilter=false 表示这不是地区范围（auto/pool/ssh:/URL/节点 ID/名称），
// 调用方继续走原有的选择器逻辑。只有全部 token 都是 2/3 字码或含
// exclude:/region: 标记时才按地区范围解释，避免把节点名称误判成地区。
func Parse(value string) (filter Filter, isFilter bool, err error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return Filter{}, false, nil
	}
	lower := strings.ToLower(text)
	if lower == "auto" || lower == "pool" || strings.HasPrefix(lower, "ssh:") || strings.Contains(text, "://") {
		return Filter{}, false, nil
	}
	parts := strings.Split(text, ",")
	hasMarker := false
	validCodeTokens := 0
	invalidTokens := make([]string, 0)
	for _, raw := range parts {
		token := strings.TrimSpace(raw)
		if token == "" {
			return Filter{}, false, errors.New("地区范围包含空项；请用逗号分隔国家码或城市码")
		}
		lowerToken := strings.ToLower(token)
		if lowerToken == "exclude" || lowerToken == "exclude:" ||
			lowerToken == "region" || lowerToken == "region:" ||
			strings.HasPrefix(lowerToken, "exclude:") || strings.HasPrefix(lowerToken, "region:") {
			hasMarker = true
			continue
		}
		code := strings.ToUpper(token)
		if isCodeToken(token) && ((len(code) == 2 && ValidCountry(code)) || (len(code) == 3 && ValidCity(code))) {
			validCodeTokens++
			continue
		}
		invalidTokens = append(invalidTokens, token)
	}
	if !hasMarker {
		if validCodeTokens == 0 {
			// 全部是未知 2/3 字（例如 SSH 标签 AWS）时保留原有的节点选择语义。
			return Filter{}, false, nil
		}
		if validCodeTokens != len(parts) {
			return Filter{}, false, fmt.Errorf("地区范围包含未知码 %s；2 字必须是国家码，3 字必须是城市码（点名节点请用节点 ID）", strings.Join(invalidTokens, ","))
		}
	}

	mode := "include"
	for _, raw := range parts {
		token := strings.TrimSpace(raw)
		lowerToken := strings.ToLower(token)
		switch {
		case lowerToken == "exclude" || lowerToken == "exclude:":
			mode = "exclude"
			continue
		case lowerToken == "region" || lowerToken == "region:":
			mode = "include"
			continue
		case strings.HasPrefix(lowerToken, "exclude:"):
			mode = "exclude"
			token = strings.TrimSpace(token[len("exclude:"):])
		case strings.HasPrefix(lowerToken, "region:"):
			mode = "include"
			token = strings.TrimSpace(token[len("region:"):])
		}
		if token == "" {
			return Filter{}, false, errors.New("地区范围标记后缺少国家码或城市码")
		}
		if !isCodeToken(token) {
			return Filter{}, false, fmt.Errorf("地区范围只能使用 2 字国家码或 3 字城市码，收到 %q", token)
		}
		code := strings.ToUpper(token)
		switch len(code) {
		case 2:
			if !ValidCountry(code) {
				return Filter{}, false, fmt.Errorf("未知国家码 %q；请用 TAB 查看可用国家", code)
			}
			if mode == "exclude" {
				filter.ExcludeCountries = appendUnique(filter.ExcludeCountries, code)
			} else {
				filter.Countries = appendUnique(filter.Countries, code)
			}
		case 3:
			if !ValidCity(code) {
				return Filter{}, false, fmt.Errorf("未知城市码 %q；请用 TAB 查看可用城市", code)
			}
			if mode == "exclude" {
				filter.ExcludeCities = appendUnique(filter.ExcludeCities, code)
			} else {
				filter.Cities = appendUnique(filter.Cities, code)
			}
		}
	}
	if filter.Empty() {
		return Filter{}, false, errors.New("地区范围为空；需要至少一个国家码或城市码")
	}
	return filter, true, nil
}

func isCodeToken(token string) bool {
	if len(token) != 2 && len(token) != 3 {
		return false
	}
	for index := 0; index < len(token); index++ {
		char := token[index]
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') {
			return false
		}
	}
	return true
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func contains(values []string, value string) bool {
	if value == "" {
		return false
	}
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
