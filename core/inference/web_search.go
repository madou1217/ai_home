package inference

import "strings"

// WebSearchLocation 是网络搜索使用的近似地理位置。
type WebSearchLocation struct {
	country  string
	region   string
	city     string
	timezone string
}

// NewWebSearchLocation 创建不携带精确坐标的近似位置。
func NewWebSearchLocation(
	country string,
	region string,
	city string,
	timezone string,
) (WebSearchLocation, error) {
	location := WebSearchLocation{
		country:  country,
		region:   region,
		city:     city,
		timezone: timezone,
	}
	if !location.IsValid() {
		return WebSearchLocation{}, ErrInvalidRequest
	}
	return location, nil
}

// Country 返回可选 ISO 国家代码。
func (location WebSearchLocation) Country() string { return location.country }

// Region 返回可选地区名称。
func (location WebSearchLocation) Region() string { return location.region }

// City 返回可选城市名称。
func (location WebSearchLocation) City() string { return location.city }

// Timezone 返回可选 IANA 时区。
func (location WebSearchLocation) Timezone() string { return location.timezone }

// IsValid 判断近似位置非空且各字段大小受限。
func (location WebSearchLocation) IsValid() bool {
	values := []string{location.country, location.region, location.city, location.timezone}
	hasValue := false
	for _, value := range values {
		if value == "" {
			continue
		}
		hasValue = true
		if len(value) > 128 || !isNonBlankText(value) || strings.TrimSpace(value) != value {
			return false
		}
	}
	return hasValue
}

// WebSearchOptions 是客户端声明的服务器侧网络搜索配置。
type WebSearchOptions struct {
	// ExternalWebAccess 区分缺省与明确允许或禁止实时外网访问。
	ExternalWebAccess *bool
	// AllowedDomains 限制搜索结果来源域名。
	AllowedDomains []string
	// Location 是可选近似位置。
	Location *WebSearchLocation
}

// WebSearchTool 是不依赖 OpenAI 或 Anthropic JSON 的服务器侧搜索意图。
type WebSearchTool struct {
	externalWebAccess *bool
	allowedDomains    []string
	location          *WebSearchLocation
}

// NewWebSearchTool 创建有界且不可变的服务器侧搜索配置。
func NewWebSearchTool(options WebSearchOptions) (WebSearchTool, error) {
	if len(options.AllowedDomains) > 100 {
		return WebSearchTool{}, ErrInvalidRequest
	}
	domains := make([]string, len(options.AllowedDomains))
	seen := make(map[string]struct{}, len(options.AllowedDomains))
	for index, domain := range options.AllowedDomains {
		if len(domain) > 253 || !isCanonicalOpaqueID(domain) {
			return WebSearchTool{}, ErrInvalidRequest
		}
		normalized := strings.ToLower(domain)
		if _, exists := seen[normalized]; exists {
			return WebSearchTool{}, ErrInvalidRequest
		}
		seen[normalized] = struct{}{}
		domains[index] = domain
	}
	if options.Location != nil && !options.Location.IsValid() {
		return WebSearchTool{}, ErrInvalidRequest
	}
	return WebSearchTool{
		externalWebAccess: cloneBool(options.ExternalWebAccess),
		allowedDomains:    domains,
		location:          cloneWebSearchLocation(options.Location),
	}, nil
}

// ExternalWebAccess 返回实时外网访问意图及其是否被明确设置。
func (tool WebSearchTool) ExternalWebAccess() (bool, bool) {
	if tool.externalWebAccess == nil {
		return false, false
	}
	return *tool.externalWebAccess, true
}

// AllowedDomains 返回允许域名副本。
func (tool WebSearchTool) AllowedDomains() []string {
	return append([]string(nil), tool.allowedDomains...)
}

// Location 返回可选近似位置。
func (tool WebSearchTool) Location() (WebSearchLocation, bool) {
	if tool.location == nil {
		return WebSearchLocation{}, false
	}
	return *tool.location, true
}

// IsValid 判断搜索配置仍满足构造不变量。
func (tool WebSearchTool) IsValid() bool {
	_, err := NewWebSearchTool(WebSearchOptions{
		ExternalWebAccess: tool.externalWebAccess,
		AllowedDomains:    tool.allowedDomains,
		Location:          tool.location,
	})
	return err == nil
}

// clone 返回与原值隔离的搜索配置。
func (tool WebSearchTool) clone() WebSearchTool {
	return WebSearchTool{
		externalWebAccess: cloneBool(tool.externalWebAccess),
		allowedDomains:    append([]string(nil), tool.allowedDomains...),
		location:          cloneWebSearchLocation(tool.location),
	}
}

// cloneWebSearchLocation 复制可选位置值。
func cloneWebSearchLocation(value *WebSearchLocation) *WebSearchLocation {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
