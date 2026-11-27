package proxyregion

import (
	"strings"
	"unicode"
)

// ParseNodeLabel extracts the country and city from a proxy node label.
//
// Pool nodes use labels such as "🇺🇸 United States丨01", "🇸🇬SG04" or
// "United States LAX". The flag is the most reliable source; a leading
// two-letter token followed by digits (US14, SG04) is also accepted. Labels
// without any recognizable geo (for example "AWS") return empty values so the
// desk can omit the region instead of guessing.
func ParseNodeLabel(label string) (country, cityCode string) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", ""
	}
	country = countryFromFlag(label)
	if country == "" {
		country = countryFromToken(label)
	}
	cityCode = CityCodeFor(country, "", label)
	return country, cityCode
}

// RegionLabel renders a compact Chinese label for a country/city pair.
// Empty geo returns "", letting callers omit the region entirely.
func RegionLabel(country, cityCode string) string {
	if code := NormalizeCityCode(cityCode); code != "" {
		return CityLabel(code)
	}
	if code := NormalizeCountry(country); code != "" {
		return CountryLabel(code)
	}
	return ""
}

// countryFromFlag decodes a pair of regional-indicator runes into ISO alpha-2.
func countryFromFlag(label string) string {
	runes := []rune(label)
	for index := 0; index+1 < len(runes); index++ {
		first, second := runes[index], runes[index+1]
		if first < 0x1F1E6 || first > 0x1F1FF || second < 0x1F1E6 || second > 0x1F1FF {
			continue
		}
		code := string([]rune{
			'A' + (first - 0x1F1E6),
			'A' + (second - 0x1F1E6),
		})
		if ValidCountry(code) {
			return code
		}
	}
	return ""
}

// countryFromToken finds a two-letter country prefix in the first plain token,
// for labels that carry no flag: "US14 / 0.5x" or "SG04".
func countryFromToken(label string) string {
	token := ""
	for _, runeValue := range label {
		if unicode.IsLetter(runeValue) && runeValue < unicode.MaxASCII {
			token += string(runeValue)
			continue
		}
		if unicode.IsDigit(runeValue) && token != "" {
			break
		}
		if token != "" {
			break
		}
	}
	// Only an exact two-letter token qualifies. "AWS" is a provider label,
	// not Aruba: taking its first two letters would invent a country.
	if len(token) != 2 {
		return ""
	}
	code := strings.ToUpper(token)
	if ValidCountry(code) {
		return code
	}
	return ""
}
