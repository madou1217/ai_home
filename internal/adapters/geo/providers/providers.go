// Package providers 组装 geo 查询链（Node 侧对应 lib/runtime/geo/providers/index.js）。
//
// **顺序即优先级**：链上从前到后尝试，前一个不可用/查不到自动切下一个。
// 排序原则（与 Node 侧必须一致，否则两侧结论会不同）：
//  1. 字段更全的在前（City 库能给城市，Country 库给不了）；
//  2. ASN 库排在最后：它只补 ASN 字段，不覆盖国家（链按字段合并，先到先得）。
//
// 新增数据源 = 这里加一行，链、调用方、Node 侧对应实现都不动。
package providers

import (
	"github.com/madou1217/ai_home/application/geo"
	"github.com/madou1217/ai_home/internal/adapters/geo/mmdbgeo"
)

// Options 建链的参数。
type Options struct {
	AIHomeDir string
	HomeDir   string
}

// Build 按优先级建一组 provider。
func Build(options Options) []geo.Provider {
	shared := func(id string, name string, kind string, capabilities geo.Capabilities) geo.Provider {
		return mmdbgeo.New(mmdbgeo.Options{
			ID:           id,
			Name:         name,
			Kind:         kind,
			Capabilities: capabilities,
			AIHomeDir:    options.AIHomeDir,
			HomeDir:      options.HomeDir,
		})
	}
	return []geo.Provider{
		// 城市级优先（同时给国家/省州/城市）：DB-IP City Lite（工具箱可下载）。
		shared("dbip-city", "DB-IP City Lite", "dbip-city", geo.Capabilities{Country: true, Region: true, City: true}),
		// GeoLite2-City（用户自备则复用）。
		shared("geolite2-city", "GeoLite2 City", "city", geo.Capabilities{Country: true, Region: true, City: true}),
		// 国家库（本机 Surge / Clash Verge / MonoProxy 现成）。
		shared("geolite2-country", "GeoLite2 Country", "country", geo.Capabilities{Country: true}),
		// ASN 库（本机 Surge 现成）：只补 ASN / org，排最后。
		shared("geolite2-asn", "GeoLite2 ASN", "asn", geo.Capabilities{ASN: true}),
	}
}

// CloseAll 释放链上所有 provider 的 reader。
func CloseAll(list []geo.Provider) {
	for _, provider := range list {
		if closer, ok := provider.(interface{ Close() }); ok {
			closer.Close()
		}
	}
}
