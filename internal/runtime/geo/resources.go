// Package geo 提供 GeoIP 数据资源的目录描述、本地库下载（DB-IP City Lite）与异步作业状态机。
//
// 对应 Node 侧 lib/runtime/geo/download.js 与 lib/server/geo-resource-job-manager.js，
// 查询仍复用 domain/application 层 application/geo 与 internal/adapters/geo/providers。
package geo

import (
	"os"
	"path/filepath"
	"strings"

	appgeo "github.com/madou1217/ai_home/application/geo"
	geoproviders "github.com/madou1217/ai_home/internal/adapters/geo/providers"
)

// DBIPURLTemplate 是 DB-IP City Lite 的月度免费公开下载地址模板（与 Node download.js 同源）。
const DBIPURLTemplate = "https://download.db-ip.com/free/dbip-city-lite-%s.mmdb.gz"

const (
	// ResourceDBIPCityID 是当前唯一可自动下载的托管 GeoIP 资源标识。
	ResourceDBIPCityID   = "dbip-city"
	managedDBIPFileName  = "dbip-city-lite.mmdb"
)

// CapabilitiesView 是前端 GeoResource / GeoProvider 消费的字段能力描述（camelCase）。
type CapabilitiesView struct {
	Country bool `json:"country"`
	Region  bool `json:"region"`
	City    bool `json:"city"`
	ASN     bool `json:"asn"`
}

// ResourceView 描述一个可托管 GeoIP 数据文件的定义与当前磁盘状态。
type ResourceView struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	Role         string           `json:"role"`
	Kind         string           `json:"kind"`
	SizeHint     string           `json:"sizeHint"`
	URL          string           `json:"url"`
	AutoDownload bool             `json:"autoDownload"`
	Capabilities CapabilitiesView `json:"capabilities"`
	Installed    bool             `json:"installed"`
	Bytes        int64            `json:"bytes"`
	UpdatedAt    int64            `json:"updatedAt"`
	Path         string           `json:"path"`
}

// ProviderAvailabilityView 描述探测链里单个本地 GeoIP provider 的可用状态。
type ProviderAvailabilityView struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	Capabilities CapabilitiesView `json:"capabilities"`
	Available    bool             `json:"available"`
	Error        string           `json:"error"`
}

type resourceSpec struct {
	id           string
	name         string
	role         string
	kind         string
	sizeHint     string
	url          string
	autoDownload bool
	capabilities CapabilitiesView
}

var catalog = []resourceSpec{
	{
		id:           ResourceDBIPCityID,
		name:         "DB-IP City Lite",
		role:         "城市级归属地（国家 / 省州 / 城市），免注册、每月更新",
		kind:         "city",
		sizeHint:     "约 60 MB 压缩 / 120 MB 解压",
		url:          "https://download.db-ip.com/free/dbip-city-lite-<YYYY-MM>.mmdb.gz",
		autoDownload: true,
		capabilities: CapabilitiesView{Country: true, Region: true, City: true, ASN: false},
	},
}

// ManagedDBIPPath 返回托管 DB-IP City Lite 数据库的落盘路径。
func ManagedDBIPPath(aiHomeDir string) string {
	trimmed := strings.TrimSpace(aiHomeDir)
	if trimmed == "" {
		return ""
	}
	return filepath.Join(trimmed, "geo", managedDBIPFileName)
}

func findResourceSpec(resourceID string) (resourceSpec, bool) {
	needle := strings.ToLower(strings.TrimSpace(resourceID))
	for _, spec := range catalog {
		if spec.id == needle {
			return spec, true
		}
	}
	return resourceSpec{}, false
}

// ListResources 返回托管 GeoIP 资源清单与各自在磁盘上的实际存在/大小/更新时间。
func ListResources(aiHomeDir string) []ResourceView {
	targetPath := ManagedDBIPPath(aiHomeDir)
	var installed bool
	var sizeBytes int64
	var updatedAtMS int64
	if targetPath != "" {
		if info, err := os.Stat(targetPath); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
			installed = true
			sizeBytes = info.Size()
			updatedAtMS = info.ModTime().UnixMilli()
		}
	}

	out := make([]ResourceView, 0, len(catalog))
	for _, spec := range catalog {
		view := ResourceView{
			ID:           spec.id,
			Name:         spec.name,
			Role:         spec.role,
			Kind:         spec.kind,
			SizeHint:     spec.sizeHint,
			URL:          spec.url,
			AutoDownload: spec.autoDownload,
			Capabilities: spec.capabilities,
			Path:         targetPath,
		}
		if spec.id == ResourceDBIPCityID {
			view.Installed = installed
			view.Bytes = sizeBytes
			view.UpdatedAt = updatedAtMS
		}
		out = append(out, view)
	}
	return out
}

// ProbeResource 查询单个托管资源的当前状态。
func ProbeResource(aiHomeDir string, resourceID string) (ResourceView, bool) {
	needle := strings.ToLower(strings.TrimSpace(resourceID))
	for _, item := range ListResources(aiHomeDir) {
		if item.ID == needle {
			return item, true
		}
	}
	return ResourceView{}, false
}

// DescribeProviders 探测整条本地 GeoIP 查询链上每个数据源的可用情况。
func DescribeProviders(aiHomeDir string, homeDir string) []ProviderAvailabilityView {
	chain := geoproviders.Build(geoproviders.Options{
		AIHomeDir: strings.TrimSpace(aiHomeDir),
		HomeDir:   strings.TrimSpace(homeDir),
	})
	defer geoproviders.CloseAll(chain)

	out := make([]ProviderAvailabilityView, 0, len(chain))
	for _, provider := range chain {
		caps := provider.Capabilities()
		available := provider.Available()
		detail := ""
		if !available {
			detail = provider.Detail()
		}
		out = append(out, ProviderAvailabilityView{
			ID:   provider.ID(),
			Name: provider.Name(),
			Capabilities: CapabilitiesView{
				Country: caps.Country,
				Region:  caps.Region,
				City:    caps.City,
				ASN:     caps.ASN,
			},
			Available: available,
			Error:     detail,
		})
	}
	return out
}

// LookupIP 使用当前 AIHome 与本机托管 GeoIP 链按优先级查询归属地。
func LookupIP(aiHomeDir string, homeDir string, ip string) appgeo.Result {
	chain := geoproviders.Build(geoproviders.Options{
		AIHomeDir: strings.TrimSpace(aiHomeDir),
		HomeDir:   strings.TrimSpace(homeDir),
	})
	defer geoproviders.CloseAll(chain)
	return appgeo.Lookup(chain, ip)
}
