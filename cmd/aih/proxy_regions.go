package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
)

// runProxyRegions 打印临时代理池的地区码表，并标注当前候选里各地区的出口数。
//
// 默认只列常见国家码和“当前有出口”的城市码；--all 展开完整 IATA 城市表。
// 需要 Server 管理密钥时才会查询当前候选；缺失时仍可看离线码表。
func runProxyRegions(ctx context.Context, arguments []string, runtime commandRuntime) error {
	all := false
	jsonOutput := false
	for _, argument := range arguments {
		switch argument {
		case "--all":
			all = true
		case "--json":
			jsonOutput = true
		case "--help", "-h":
			_, _ = fmt.Fprintln(runtime.stdout, "用法: aih proxy regions [--all] [--json]")
			_, _ = fmt.Fprintln(runtime.stdout, "列出 2 字国家码与 3 字 IATA 城市码的中文名，以及当前候选的出口数。")
			return nil
		default:
			return fmt.Errorf("用法: aih proxy regions [--all] [--json]")
		}
	}

	countryCounts := map[string]int{}
	cityCounts := map[string]int{}
	candidatesAvailable := false
	candidateCount := 0
	if client, err := managementProxyClient(runtime); err == nil {
		if candidates, err := client.Candidates(ctx); err == nil {
			candidatesAvailable = true
			candidateCount = len(candidates)
			for _, candidate := range candidates {
				if !candidate.Available {
					continue
				}
				if country := proxyregion.NormalizeCountry(candidate.Country); country != "" {
					countryCounts[country]++
				}
				if city := proxyregion.NormalizeCityCode(candidate.CityCode); city != "" {
					cityCounts[city]++
				}
			}
		}
	}

	countries := proxyregion.CountryCodes()
	seenCountries := make(map[string]bool, len(countries)+len(countryCounts))
	for _, code := range countries {
		seenCountries[code] = true
	}
	extraCountries := make([]string, 0)
	for code := range countryCounts {
		if !seenCountries[code] {
			extraCountries = append(extraCountries, code)
		}
	}
	sort.Strings(extraCountries)
	countries = append(countries, extraCountries...)

	cityCodes := proxyregion.CityCodes()
	if !all {
		cityCodes = cityCodes[:0]
		for code := range cityCounts {
			cityCodes = append(cityCodes, code)
		}
		sort.Strings(cityCodes)
	}

	if jsonOutput {
		type countryRow struct {
			Code  string `json:"code"`
			Name  string `json:"name"`
			Count int    `json:"count"`
		}
		type cityRow struct {
			Code    string `json:"code"`
			Name    string `json:"name"`
			Country string `json:"country"`
			Count   int    `json:"count"`
		}
		payload := struct {
			Available  bool         `json:"available"`
			Countries  []countryRow `json:"countries"`
			Cities     []cityRow    `json:"cities"`
			Candidates int          `json:"candidateCount"`
		}{Available: candidatesAvailable, Candidates: candidateCount}
		for _, code := range countries {
			payload.Countries = append(payload.Countries, countryRow{Code: code, Name: proxyregion.CountryName(code), Count: countryCounts[code]})
		}
		for _, code := range cityCodes {
			city, _ := proxyregion.CityInfo(code)
			payload.Cities = append(payload.Cities, cityRow{Code: code, Name: city.Name, Country: city.Country, Count: cityCounts[code]})
		}
		encoded, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		return nil
	}

	if !candidatesAvailable {
		_, _ = fmt.Fprintln(runtime.stdout, "（未连接 AIH Server：仅显示码表；出口数需要管理密钥）")
	}
	_, _ = fmt.Fprintln(runtime.stdout, "国家码（2 字，ISO 3166-1 alpha-2）：")
	for _, code := range countries {
		count := ""
		if candidatesAvailable {
			count = fmt.Sprintf(" · %d 个出口", countryCounts[code])
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  %-2s  %s%s\n", strings.ToLower(code), proxyregion.CountryLabel(code), count)
	}
	_, _ = fmt.Fprintln(runtime.stdout)
	_, _ = fmt.Fprintln(runtime.stdout, "城市码（3 字，IATA）：")
	if len(cityCodes) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "  当前候选没有解析到城市；用 --all 查看完整城市码表。")
	}
	for _, code := range cityCodes {
		count := ""
		if candidatesAvailable {
			count = fmt.Sprintf(" · %d 个出口", cityCounts[code])
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  %-3s  %s%s\n", strings.ToLower(code), proxyregion.CityLabel(code), count)
	}
	_, _ = fmt.Fprintln(runtime.stdout)
	_, _ = fmt.Fprintln(runtime.stdout, "示例：--proxy us,sg  --proxy lax  --proxy us,sg,exclude:hk  --proxy exclude:cn,ru")
	return nil
}
