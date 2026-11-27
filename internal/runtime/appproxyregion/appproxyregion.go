// Package appproxyregion resolves the country/city behind a local app proxy
// endpoint for the app desk.
//
// Two sources are authoritative, in order:
//  1. the per-port metadata published by `aih proxy serve` (covers temporary
//     entries on any port);
//  2. the resident control status (covers older entries that predate the
//     per-port metadata and the currently supervised entry).
//
// Missing geo is returned as empty values; the desk never guesses a country.
package appproxyregion

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/appsessions"
	"github.com/madou1217/ai_home/internal/runtime/proxycontrol"
	"github.com/madou1217/ai_home/internal/runtime/proxyendpoints"
	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
)

// Resolve returns the country/city for one proxy URL.
func Resolve(ctx context.Context, aiHomeDir, proxyURL string) (country, cityCode, region string) {
	proxyURL = strings.TrimSpace(proxyURL)
	if proxyURL == "" {
		return "", "", ""
	}
	if info, ok := proxyendpoints.Lookup(aiHomeDir, proxyURL); ok {
		return info.Country, info.CityCode, info.Region
	}
	client, err := proxycontrol.Load(aiHomeDir)
	if err != nil {
		return "", "", ""
	}
	status, err := client.Status(ctx)
	if err != nil || !proxyendpoints.MatchesEndpoint(status.HTTPURL, proxyURL) {
		return "", "", ""
	}
	country, cityCode = proxyregion.ParseNodeLabel(status.LeaseName)
	return country, cityCode, proxyregion.RegionLabel(country, cityCode)
}

// Enrich fills missing geo fields on proxied instances without mutating the
// caller's slice or persisting anything.
func Enrich(ctx context.Context, instances []appsessions.Instance, aiHomeDir string) []appsessions.Instance {
	if len(instances) == 0 {
		return instances
	}
	enriched := make([]appsessions.Instance, len(instances))
	copy(enriched, instances)
	type geo struct{ country, city, region string }
	cache := make(map[string]geo)
	for index := range enriched {
		instance := &enriched[index]
		if !instance.Proxied || instance.ProxyRegion != "" {
			continue
		}
		key := strings.TrimSpace(instance.ProxyURL)
		resolved, ok := cache[key]
		if !ok {
			resolved.country, resolved.city, resolved.region = Resolve(ctx, aiHomeDir, key)
			cache[key] = resolved
		}
		if instance.ProxySelector == "" {
			if info, ok := proxyendpoints.Lookup(aiHomeDir, key); ok {
				switch strings.ToLower(strings.TrimSpace(info.Selector)) {
				case "", "auto", "pool":
					// Resident entries are renewed through their control API,
					// not by starting a temporary entry on the same port.
				default:
					instance.ProxySelector = info.Selector
				}
			}
		}
		if resolved.region == "" {
			continue
		}
		instance.ProxyCountry = resolved.country
		instance.ProxyCity = resolved.city
		instance.ProxyRegion = resolved.region
	}
	return enriched
}
