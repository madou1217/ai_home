// Package geo 是「IP → 归属地」查询的领域层（Node 侧对应 lib/runtime/geo）。
//
// 两段分工（与 Node 侧一致，别混淆）：
//
//	① 拿出口 IP   —— 必须经节点出网一次（唯一能知道出口真实 IP 的方式），不属本包；
//	② IP → 归属地 —— 本包负责，纯本地 mmdb 查表，微秒级、零网络。
//
// 为什么不用在线 API（2026-10-22 决策）：ipinfo / ip-api 这类服务不稳定、有速率限制，
// 而且每次都要经节点出网，慢且不可控。改成「本地数据文件 + 本地查询」。
//
// 数据源做成 Provider：每个声明自己能提供哪些字段（国家 / 省州 / 城市 / ASN），
// 按顺序尝试，**前一个不可用或查不到就自动切下一个**；结果按字段合并，
// 所以「Country 库 + ASN 库」能拼成一条完整结论。
package geo

import "strings"

// Capabilities 声明一个 Provider 能提供哪些字段。
// 用途：链上已经拿到国家、而某个 Provider 只有国家时，跳过它省一次查询。
type Capabilities struct {
	Country bool
	Region  bool
	City    bool
	ASN     bool
}

// Record 是一次查询的结果（字段级合并后的形状）。
// 与 Node 侧 node-health 的 geo 字段同形，便于两侧对齐与落库。
type Record struct {
	Country string // ISO 3166-1 alpha-2，大写
	Region  string // 省 / 州
	City    string
	ASN     string // 形如 AS13335
	Org     string
	IP      string
	Source  string // 数据来源（provider id 链，如 "dbip-city+geolite2-asn"）
}

// HasAny 是否给出了国家或 ASN 之一（判定「命中」的最小条件）。
func (r Record) HasAny() bool {
	return strings.TrimSpace(r.Country) != "" || strings.TrimSpace(r.ASN) != ""
}

// Provider 是「IP → 归属地」的一个数据源。
//
// 实现方（internal/adapters/geo/*）只需回答三件事：能不能用、能提供什么、查一个 IP。
// Lookup 查不到返回零值 Record（不是错误）——不同库覆盖范围不同，链上继续问下一个。
type Provider interface {
	// ID 稳定标识（"dbip-city" / "geolite2-country" …），出现在来源链与诊断里。
	ID() string
	// Name 展示名。
	Name() string
	// Capabilities 声明能提供哪些字段。
	Capabilities() Capabilities
	// Available 数据文件在不在、能不能打开。false 时链上直接跳过。
	Available() bool
	// Lookup 查一个 IP；查不到或出错返回零值 Record。
	Lookup(ip string) Record
	// Detail 不可用/出错的原因（诊断用，可用时为空）。
	Detail() string
}

// Attempt 是一次 provider 尝试的记录（「切过、为什么切」可观察）。
type Attempt struct {
	ProviderID string
	Error      string // unavailable / not_found / not_needed / 具体错误
	Hit        []string
}

// Result 是链式查询的结论。
type Result struct {
	OK         bool
	Record     Record
	Providers  []string // 实际贡献了字段的 provider（按顺序）
	Attempts   []Attempt
	Error      string // OK=false 时的原因
}

// Lookup 沿链查询一个 IP。永不 panic：任何 provider 出错都记进 Attempts 并切下一个。
func Lookup(providers []Provider, ip string) Result {
	address := strings.TrimSpace(ip)
	if address == "" {
		return Result{Error: "invalid_ip"}
	}
	var (
		merged  Record
		used    []string
		attempts []Attempt
	)
	for _, provider := range providers {
		// 关键字段（国家 + ASN）都拿到了就不必再问后面的库。
		if len(used) > 0 && !missingImportant(merged) {
			break
		}
		if provider == nil {
			continue
		}
		// 这个库补不上还缺的字段（例如已有国家、它只有国家）→ 跳过，省一次查询。
		if len(used) > 0 && !canContribute(provider.Capabilities(), merged) {
			attempts = append(attempts, Attempt{ProviderID: provider.ID(), Error: "not_needed"})
			continue
		}
		if !provider.Available() {
			attempts = append(attempts, Attempt{ProviderID: provider.ID(), Error: "unavailable"})
			continue
		}
		record := provider.Lookup(address)
		if !record.HasAny() {
			attempts = append(attempts, Attempt{ProviderID: provider.ID(), Error: "not_found"})
			continue
		}
		merged = mergeFields(merged, record)
		used = append(used, provider.ID())
		attempts = append(attempts, Attempt{ProviderID: provider.ID(), Hit: hitFields(record)})
	}
	if !merged.HasAny() {
		return Result{Attempts: attempts, Error: "geo_not_found"}
	}
	merged.Source = strings.Join(used, "+")
	return Result{OK: true, Record: merged, Providers: used, Attempts: attempts}
}

// missingImportant：只把国家与 ASN 当关键字段。城市/省州是加分项，
// 不为它们多问一个库（实测多问一个库约 100-230μs，2w 节点时是秒级差异）。
func missingImportant(record Record) bool {
	return strings.TrimSpace(record.Country) == "" || strings.TrimSpace(record.ASN) == ""
}

// canContribute：这个 provider 还能补上关键字段吗。
func canContribute(capabilities Capabilities, merged Record) bool {
	if strings.TrimSpace(merged.Country) == "" && capabilities.Country {
		return true
	}
	if strings.TrimSpace(merged.ASN) == "" && capabilities.ASN {
		return true
	}
	return false
}

// mergeFields：先到的非空值优先（第一个 provider 的国家胜过后面 provider 的）。
func mergeFields(target Record, source Record) Record {
	fill := func(dst *string, value string) {
		if strings.TrimSpace(*dst) == "" && strings.TrimSpace(value) != "" {
			*dst = strings.TrimSpace(value)
		}
	}
	fill(&target.Country, source.Country)
	fill(&target.Region, source.Region)
	fill(&target.City, source.City)
	fill(&target.ASN, source.ASN)
	fill(&target.Org, source.Org)
	fill(&target.IP, source.IP)
	return target
}

func hitFields(record Record) []string {
	fields := make([]string, 0, 6)
	for _, entry := range []struct {
		key   string
		value string
	}{
		{"country", record.Country},
		{"region", record.Region},
		{"city", record.City},
		{"asn", record.ASN},
		{"org", record.Org},
		{"ip", record.IP},
	} {
		if strings.TrimSpace(entry.value) != "" {
			fields = append(fields, entry.key)
		}
	}
	return fields
}

// Availability 是一个 provider 的可用性快照（界面与诊断用）。
type Availability struct {
	ID           string
	Name         string
	Capabilities Capabilities
	Available    bool
	Detail       string
}

// Describe 列出链上每个 provider 的可用性。
func Describe(providers []Provider) []Availability {
	out := make([]Availability, 0, len(providers))
	for _, provider := range providers {
		if provider == nil {
			continue
		}
		out = append(out, Availability{
			ID:           provider.ID(),
			Name:         provider.Name(),
			Capabilities: provider.Capabilities(),
			Available:    provider.Available(),
			Detail:       provider.Detail(),
		})
	}
	return out
}
