// Package mmdbgeo 是 geo.Provider 的 mmdb 实现（GeoLite2 / DB-IP / 任何标准 MaxMind 格式）。
//
// 为什么一份通用实现：GeoLite2-Country / GeoLite2-ASN / GeoLite2-City / DB-IP City Lite
// 都是 mmdb 格式，差别只在「库里有哪些字段」。所以读取代码一份，字段映射按库类型声明 ——
// 新增数据源 = 加一条声明，不改读取逻辑（与 Node 侧 lib/runtime/geo/providers/mmdb.js 同构）。
//
// 用 github.com/oschwald/maxminddb-golang：纯 Go、无 cgo，兼容本项目的 CGO_ENABLED=0 静态构建。
// 查询是 mmdb 的二分查找，微秒级、零网络。
//
// 文件定位（与 Node 侧 paths.js 同一规则，用户要求「有则复用，没有就不用」）：
//  1. AIH 托管：<aiHome>/geo/*.mmdb —— 由工具箱的「GeoIP 数据」下载；
//  2. 本机已装客户端自带的库（Surge / Clash Verge / MonoProxy …）—— **只读**，不复制不移动。
package mmdbgeo

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/oschwald/maxminddb-golang"

	"github.com/madou1217/ai_home/application/geo"
)

// 托管文件名（工具箱下载到这里）。命名沿用上游，便于人工核对。
var managedFileNames = map[string]string{
	"country":   "GeoLite2-Country.mmdb",
	"asn":       "GeoLite2-ASN.mmdb",
	"city":      "GeoLite2-City.mmdb",
	"dbip-city": "dbip-city-lite.mmdb",
}

// clientSource 是本机已装客户端自带的一个 geo 库。
type clientSource struct {
	path string // 支持 ~ 前缀（按 homeDir 展开）
	kind string // country / asn / city
}

// 与 Node 侧 CLIENT_BUNDLED_SOURCES 保持一致：装了就有、没有就跳过。
var clientSources = []clientSource{
	{path: "/Applications/Surge.app/Contents/Resources/GeoLite2-Country.mmdb", kind: "country"},
	{path: "/Applications/Surge.app/Contents/Resources/GeoLite2-ASN.mmdb", kind: "asn"},
	{path: "~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb", kind: "country"},
	{path: "~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb", kind: "country"},
	{path: "/Applications/MonoProxyMac.app/Contents/Resources/GeoLite2-Country.mmdb", kind: "country"},
	{path: "~/Library/Application Support/ClashX/Country.mmdb", kind: "country"},
	{path: "~/Library/Application Support/ClashX Meta/Country.mmdb", kind: "country"},
	{path: "~/Library/Application Support/mihomo-party/Country.mmdb", kind: "country"},
}

// ResolveFile 找一个可用的数据文件：先 AIH 托管，再本机客户端自带。
// 返回文件路径与来源（"managed" / "client"）；都找不到返回空串（调用方按「不可用」处理，不报错）。
func ResolveFile(kind string, aiHomeDir string, homeDir string) (string, string) {
	fileName, ok := managedFileNames[kind]
	if !ok {
		return "", ""
	}
	if aiHomeDir != "" {
		managed := filepath.Join(aiHomeDir, "geo", fileName)
		if isReadableFile(managed) {
			return managed, "managed"
		}
	}
	for _, source := range clientSources {
		if source.kind != kind {
			continue
		}
		candidate := expandHome(source.path, homeDir)
		if isReadableFile(candidate) {
			return candidate, "client"
		}
	}
	return "", ""
}

// isReadableFile：存在、是文件、且非空（客户端有时留 0 字节占位文件，不能当数据）。
func isReadableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.Mode().IsRegular() && info.Size() > 0
}

func expandHome(path string, homeDir string) string {
	if !strings.HasPrefix(path, "~/") {
		return path
	}
	if homeDir == "" {
		return path
	}
	return filepath.Join(homeDir, path[2:])
}

// Provider 是一个 mmdb 数据源。
type Provider struct {
	id           string
	name         string
	kind         string // 决定去哪找文件、以及字段怎么映射
	capabilities geo.Capabilities
	aiHomeDir    string
	homeDir      string

	// 懒加载并缓存 reader：mmdb 打开后常驻内存映射，重复打开是浪费。
	mu         sync.Mutex
	reader     *maxminddb.Reader
	readerPath string
	detail     string
}

// Options 建 Provider 的参数。
type Options struct {
	ID           string
	Name         string
	Kind         string // country / asn / city / dbip-city
	Capabilities geo.Capabilities
	AIHomeDir    string
	HomeDir      string
}

// New 建一个 mmdb Provider。
func New(options Options) *Provider {
	return &Provider{
		id:           options.ID,
		name:         options.Name,
		kind:         options.Kind,
		capabilities: options.Capabilities,
		aiHomeDir:    options.AIHomeDir,
		homeDir:      options.HomeDir,
	}
}

func (p *Provider) ID() string                     { return p.id }
func (p *Provider) Name() string                   { return p.name }
func (p *Provider) Capabilities() geo.Capabilities { return p.capabilities }

// Available：数据文件在、且能打开。
func (p *Provider) Available() bool {
	return p.open() != nil
}

// Detail：不可用的原因（诊断用）。
func (p *Provider) Detail() string {
	p.open()
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.detail
}

func (p *Provider) open() *maxminddb.Reader {
	p.mu.Lock()
	defer p.mu.Unlock()
	path, _ := ResolveFile(p.kind, p.aiHomeDir, p.homeDir)
	if path == "" {
		p.detail = "geo_file_missing"
		return nil
	}
	if p.reader != nil && p.readerPath == path {
		return p.reader
	}
	// 换文件（例如刚下载完新的）时关掉旧的再打开。
	if p.reader != nil {
		_ = p.reader.Close()
		p.reader = nil
	}
	reader, err := maxminddb.Open(path)
	if err != nil {
		p.readerPath = ""
		p.detail = err.Error()
		return nil
	}
	p.reader = reader
	p.readerPath = path
	p.detail = ""
	return p.reader
}

// Close 释放 reader（进程退出或测试收尾用）。
func (p *Provider) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reader != nil {
		_ = p.reader.Close()
		p.reader = nil
	}
}

// mmdbRecord 是 mmdb 记录的通用形状（各库字段不同，缺的为空）。
type mmdbRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	RegisteredCountry struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"registered_country"`
	Subdivisions []struct {
		ISOCode string `maxminddb:"iso_code"`
		Names   struct {
			EN string `maxminddb:"en"`
		} `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	City struct {
		Names struct {
			EN string `maxminddb:"en"`
		} `maxminddb:"names"`
	} `maxminddb:"city"`
	AutonomousSystemNumber       uint   `maxminddb:"autonomous_system_number"`
	AutonomousSystemOrganization string `maxminddb:"autonomous_system_organization"`
}

// Lookup 查一个 IP；查不到返回零值（链上继续问下一个）。
func (p *Provider) Lookup(ip string) geo.Record {
	reader := p.open()
	address := strings.TrimSpace(ip)
	if reader == nil || address == "" {
		return geo.Record{}
	}
	var record mmdbRecord
	if err := reader.Lookup(networkAddress(address), &record); err != nil {
		return geo.Record{}
	}
	return p.mapRecord(record)
}

// mapRecord：把 mmdb 记录映射成统一形状。
//
// 真实数据差异：有些网段只有 registered_country 没有 country（实测 1.1.1.1 就是这样），
// 两个都看，优先 country。
func (p *Provider) mapRecord(record mmdbRecord) geo.Record {
	out := geo.Record{}
	country := record.Country.ISOCode
	if country == "" {
		country = record.RegisteredCountry.ISOCode
	}
	out.Country = strings.ToUpper(strings.TrimSpace(country))
	if len(record.Subdivisions) > 0 {
		subdivision := record.Subdivisions[0]
		out.Region = strings.TrimSpace(subdivision.Names.EN)
		if out.Region == "" {
			out.Region = strings.TrimSpace(subdivision.ISOCode)
		}
	}
	out.City = strings.TrimSpace(record.City.Names.EN)
	if record.AutonomousSystemNumber > 0 {
		out.ASN = "AS" + itoa(record.AutonomousSystemNumber)
	}
	out.Org = strings.TrimSpace(record.AutonomousSystemOrganization)
	// ASN 库只提供 ASN：没有 ASN 就等于没查到。
	if p.kind == "asn" && out.ASN == "" {
		return geo.Record{}
	}
	return out
}

// networkAddress：把字符串转成 net.IP（maxminddb 的 Lookup 接受 net.IP 或字符串，
// 显式转换是为了让非法输入直接返回 nil 而不是让库内部处理）。
func networkAddress(value string) net.IP {
	return net.ParseIP(strings.TrimSpace(value))
}

func itoa(value uint) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}
