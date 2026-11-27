package completion

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
)

const (
	proxySnapshotMaxBytes = 256 * 1024
	proxyCacheTTL         = 5000 * time.Millisecond
	proxyRequestTimeout   = 650 * time.Millisecond
)

type proxySnapshotCandidate struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Source          string `json:"source"`
	Available       bool   `json:"available"`
	LabelSelectable *bool  `json:"labelSelectable"`
	Country         string `json:"country,omitempty"`
	City            string `json:"city,omitempty"`
	CityCode        string `json:"cityCode,omitempty"`
	Region          string `json:"region,omitempty"`
	GeoSource       string `json:"geoSource,omitempty"`
}

type proxySnapshot struct {
	OK         bool                     `json:"ok"`
	Candidates []proxySnapshotCandidate `json:"candidates"`
}

type proxyCacheDocument struct {
	OK         bool                     `json:"ok"`
	At         int64                    `json:"at"`
	Candidates []proxySnapshotCandidate `json:"candidates"`
}

type proxyManagementConfig struct {
	baseURL       string
	managementKey string
}

func sanitizeControlBytes(value string, limit int) string {
	var builder strings.Builder
	count := 0
	for _, char := range value {
		if count >= limit {
			break
		}
		if char < 0x20 || char == 0x7f {
			builder.WriteByte(' ')
		} else {
			builder.WriteRune(char)
		}
		count++
	}
	return builder.String()
}

func isSafeProxyValue(value string) bool {
	if value == "" || strings.HasPrefix(value, "-") || strings.Contains(value, "=") {
		return false
	}
	for _, char := range value {
		if unicode.IsSpace(char) || char < 0x20 || char == 0x7f {
			return false
		}
	}
	return true
}

func isSafeProxyLabel(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			continue
		}
		switch char {
		case '.', '_', ':', '@', '/', '-':
			continue
		default:
			return false
		}
	}
	return true
}

// readProxyManagementConfig 读取环境/`config:server` 里的管理地址与 key。
func readProxyManagementConfig(environment Environment, aiHome string) (proxyManagementConfig, bool) {
	baseEnv := strings.TrimSpace(environment.env("AIH_SERVER_BASE_URL"))
	keyEnv := strings.TrimSpace(environment.env("AIH_SERVER_MANAGEMENT_KEY"))
	port := serverconfig.DefaultPort
	configKey := ""
	if baseEnv == "" || keyEnv == "" {
		if path, err := appstate.DatabasePath(aiHome); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), completionDBTimeout)
			raw, found, readErr := appstate.ReadKV(ctx, path, appstate.KeyServerConfig)
			cancel()
			if readErr == nil && found && strings.TrimSpace(raw) != "" {
				var document struct {
					Port          json.Number `json:"port"`
					ManagementKey string      `json:"managementKey"`
				}
				if json.Unmarshal([]byte(raw), &document) == nil {
					// 端口是否可用由共享契约判定（1..65535 整数），不再只比 > 0；
					// 越界值若被当成有效端口，管理面请求会静默打到错误端口。
					if numeric, err := document.Port.Int64(); err == nil && serverconfig.IsValidPort(numeric) {
						port = int(numeric)
					}
					configKey = strings.TrimSpace(document.ManagementKey)
				}
			}
		}
	}
	base := baseEnv
	if base == "" {
		base = "http://127.0.0.1:" + itoa(port)
	}
	managementKey := keyEnv
	if managementKey == "" && baseEnv == "" {
		managementKey = configKey
	}
	if !serverconfig.HasValidManagementKeyLength(managementKey) {
		return proxyManagementConfig{}, false
	}
	for _, char := range managementKey {
		if unicode.IsSpace(char) || char < 0x20 || char == 0x7f {
			return proxyManagementConfig{}, false
		}
	}
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return proxyManagementConfig{}, false
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return proxyManagementConfig{}, false
	}
	if parsed.Host == "" {
		return proxyManagementConfig{}, false
	}
	return proxyManagementConfig{
		baseURL:       parsed.Scheme + "://" + parsed.Host,
		managementKey: managementKey,
	}, true
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 12)
	for value > 0 {
		digits = append(digits, byte('0'+value%10))
		value /= 10
	}
	for left, right := 0, len(digits)-1; left < right; left, right = left+1, right-1 {
		digits[left], digits[right] = digits[right], digits[left]
	}
	return string(digits)
}

func publicProxyCandidates(snapshot proxySnapshot) []proxySnapshotCandidate {
	if !snapshot.OK || snapshot.Candidates == nil {
		return nil
	}
	candidates := snapshot.Candidates
	if len(candidates) > 256 {
		candidates = candidates[:256]
	}
	nameCounts := make(map[string]int, len(candidates))
	for _, row := range candidates {
		nameCounts[row.Name]++
	}
	result := make([]proxySnapshotCandidate, 0, len(candidates))
	for _, row := range candidates {
		if !row.Available || len(row.ID) > 256 || !isSafeProxyValue(row.ID) {
			continue
		}
		name := sanitizeControlBytes(row.Name, 160)
		source := sanitizeControlBytes(row.Source, 80)
		selectable := (row.LabelSelectable == nil || *row.LabelSelectable) && len(row.Name) <= 160 && nameCounts[row.Name] == 1
		result = append(result, proxySnapshotCandidate{
			ID:              row.ID,
			Name:            name,
			Source:          source,
			Available:       true,
			LabelSelectable: &selectable,
			Country:         proxyregion.NormalizeCountry(row.Country),
			City:            sanitizeControlBytes(row.City, 80),
			CityCode:        proxyregion.NormalizeCityCode(row.CityCode),
			Region:          sanitizeControlBytes(row.Region, 80),
			GeoSource:       sanitizeControlBytes(row.GeoSource, 24),
		})
	}
	return result
}

func formatProxyCandidates(rows []proxySnapshotCandidate) []proxyChoice {
	result := make([]proxyChoice, 0, len(rows)*2)
	idSet := make(map[string]struct{}, len(rows))
	nameCounts := make(map[string]int, len(rows))
	for _, row := range rows {
		idSet[row.ID] = struct{}{}
		nameCounts[row.Name]++
	}
	for _, row := range rows {
		parts := make([]string, 0, 2)
		if row.Name != "" {
			parts = append(parts, row.Name)
		}
		if row.Source != "" {
			parts = append(parts, row.Source)
		}
		description := strings.Join(parts, " · ")
		if description == "" {
			description = row.ID
		}
		result = append(result, proxyChoice{Value: row.ID, Description: description})
	}
	for _, row := range rows {
		name := row.Name
		if row.LabelSelectable == nil || !*row.LabelSelectable || name == "" || name == row.ID {
			continue
		}
		if !isSafeProxyLabel(name) || strings.HasPrefix(name, "-") || strings.Contains(name, "://") {
			continue
		}
		if name == "auto" || name == "pool" {
			continue
		}
		if _, exists := idSet[name]; exists {
			continue
		}
		if nameCounts[name] != 1 {
			continue
		}
		description := row.ID
		if row.Source != "" {
			description += " · " + row.Source
		}
		result = append(result, proxyChoice{Value: name, Description: description})
	}
	if len(rows) > 0 {
		result = append(result, formatProxyRegions(rows)...)
		result = append([]proxyChoice{{Value: "auto", Description: "自动选择可用代理（仅本次任务）"}}, result...)
	}
	return result
}

// formatProxyRegions 生成地区范围补全：2 字国家码、3 字城市码，均带中文描述。
// 只列出当前候选里真实出现的地区，避免给出选了必然落空的码。
func formatProxyRegions(rows []proxySnapshotCandidate) []proxyChoice {
	countryCounts := make(map[string]int, len(rows))
	cityCounts := make(map[string]int, len(rows))
	for _, row := range rows {
		if row.Country != "" {
			countryCounts[row.Country]++
		}
		if row.CityCode != "" {
			cityCounts[row.CityCode]++
		}
	}
	countries := make([]string, 0, len(countryCounts))
	for code := range countryCounts {
		countries = append(countries, code)
	}
	sort.Strings(countries)
	cities := make([]string, 0, len(cityCounts))
	for code := range cityCounts {
		cities = append(cities, code)
	}
	sort.Strings(cities)
	result := make([]proxyChoice, 0, len(countries)+len(cities)+1)
	for _, code := range countries {
		result = append(result, proxyChoice{
			Value:       strings.ToLower(code),
			Description: fmt.Sprintf("%s · %d 个出口", proxyregion.CountryLabel(code), countryCounts[code]),
		})
	}
	for _, code := range cities {
		result = append(result, proxyChoice{
			Value:       strings.ToLower(code),
			Description: fmt.Sprintf("%s · %d 个出口", proxyregion.CityLabel(code), cityCounts[code]),
		})
	}
	for _, code := range countries {
		result = append(result, proxyChoice{
			Value:       "exclude:" + strings.ToLower(code),
			Description: "排除 " + proxyregion.CountryLabel(code) + fmt.Sprintf(" · %d 个出口", countryCounts[code]),
		})
	}
	for _, code := range cities {
		result = append(result, proxyChoice{
			Value:       "exclude:" + strings.ToLower(code),
			Description: "排除 " + proxyregion.CityLabel(code) + fmt.Sprintf(" · %d 个出口", cityCounts[code]),
		})
	}
	if len(result) > 0 {
		result = append(result, proxyChoice{Value: "exclude:", Description: "排除以下国家/城市：exclude:cn,ru"})
	}
	return result
}

// proxyChoiceAllowed 控制 exclude:* 候选只在用户已经敲了 exclude: 时出现，
// 避免主列表被成倍的排除项淹没。
func proxyChoiceAllowed(row proxyChoice, current string) bool {
	if row.Value == "exclude:" {
		return true
	}
	if strings.HasPrefix(row.Value, "exclude:") {
		return strings.HasPrefix(current, "exclude:")
	}
	return true
}

func proxyCachePath(aiHome string, config proxyManagementConfig) string {
	if strings.TrimSpace(aiHome) == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(config.baseURL + "\x00" + config.managementKey))
	return filepath.Join(aiHome, "run", "completion", "proxy-"+hex.EncodeToString(digest[:])+".json")
}

func readProxySnapshotCache(file string, now time.Time) ([]proxySnapshotCandidate, bool) {
	info, err := os.Stat(file)
	if err != nil || info.IsDir() || info.Size() > proxySnapshotMaxBytes {
		return nil, false
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, false
	}
	var document proxyCacheDocument
	if json.Unmarshal(raw, &document) != nil || !document.OK || document.At <= 0 {
		return nil, false
	}
	age := now.UnixMilli() - document.At
	if age < 0 || age >= proxyCacheTTL.Milliseconds() {
		return nil, false
	}
	return publicProxyCandidates(proxySnapshot{OK: true, Candidates: document.Candidates}), true
}

func writeProxySnapshotCache(file string, candidates []proxySnapshotCandidate, now time.Time) {
	payload, err := json.Marshal(proxyCacheDocument{OK: true, At: now.UnixMilli(), Candidates: candidates})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(file, payload, 0o600)
}

func fetchProxySnapshot(config proxyManagementConfig) proxySnapshot {
	client := &http.Client{
		Timeout: proxyRequestTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, config.baseURL+"/v1/management/proxy-candidates", nil)
	if err != nil {
		return proxySnapshot{}
	}
	request.Header.Set("Authorization", "Bearer "+config.managementKey)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return proxySnapshot{}
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return proxySnapshot{}
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, proxySnapshotMaxBytes+1))
	if err != nil || len(payload) > proxySnapshotMaxBytes {
		return proxySnapshot{}
	}
	var snapshot proxySnapshot
	if json.Unmarshal(payload, &snapshot) != nil {
		return proxySnapshot{}
	}
	return snapshot
}

// listProxyCandidates 读取管理面的公开代理候选（5 秒本地快照，绝不发起租约）。
func listProxyCandidates(environment Environment, aiHome string) []proxyChoice {
	if strings.TrimSpace(aiHome) == "" {
		return nil
	}
	config, ok := readProxyManagementConfig(environment, aiHome)
	if !ok {
		return nil
	}
	cacheFile := proxyCachePath(aiHome, config)
	if cacheFile != "" {
		if rows, found := readProxySnapshotCache(cacheFile, environment.now()); found {
			return formatProxyCandidates(rows)
		}
	}
	rows := publicProxyCandidates(fetchProxySnapshot(config))
	if cacheFile != "" {
		stored := make([]proxySnapshotCandidate, 0, len(rows))
		for _, row := range rows {
			row.Available = true
			stored = append(stored, row)
		}
		writeProxySnapshotCache(cacheFile, stored, environment.now())
	}
	return formatProxyCandidates(rows)
}
