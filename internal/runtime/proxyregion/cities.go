package proxyregion

import (
	"fmt"
	"sort"
	"strings"
)

// City 是一条 IATA 城市码定义。Code 固定 3 字；Country 为 ISO alpha-2。
type City struct {
	Code    string
	Country string
	Name    string
	English string
	Aliases []string
}

// cityDefs 是代理池常见城市的码表；TAB 只展示当前候选里实际出现的城市。
// 新增城市时同时给出中文名、英文名与常见别名，保证 Geo city 名称能匹配。
var cityDefs = []City{
	{Code: "LAX", Country: "US", Name: "洛杉矶", English: "Los Angeles", Aliases: []string{"los angeles", "la"}},
	{Code: "SJC", Country: "US", Name: "圣何塞", English: "San Jose", Aliases: []string{"san jose", "硅谷", "silicon valley"}},
	{Code: "SFO", Country: "US", Name: "旧金山", English: "San Francisco", Aliases: []string{"san francisco", "sf"}},
	{Code: "SEA", Country: "US", Name: "西雅图", English: "Seattle"},
	{Code: "JFK", Country: "US", Name: "纽约", English: "New York", Aliases: []string{"new york", "nyc", "new york city"}},
	{Code: "EWR", Country: "US", Name: "纽瓦克", English: "Newark"},
	{Code: "IAD", Country: "US", Name: "华盛顿", English: "Washington", Aliases: []string{"washington dc", "ashburn"}},
	{Code: "ORD", Country: "US", Name: "芝加哥", English: "Chicago"},
	{Code: "DFW", Country: "US", Name: "达拉斯", English: "Dallas"},
	{Code: "MIA", Country: "US", Name: "迈阿密", English: "Miami"},
	{Code: "ATL", Country: "US", Name: "亚特兰大", English: "Atlanta"},
	{Code: "BOS", Country: "US", Name: "波士顿", English: "Boston"},
	{Code: "PHX", Country: "US", Name: "凤凰城", English: "Phoenix"},
	{Code: "LAS", Country: "US", Name: "拉斯维加斯", English: "Las Vegas"},
	{Code: "DEN", Country: "US", Name: "丹佛", English: "Denver"},
	{Code: "SAN", Country: "US", Name: "圣地亚哥", English: "San Diego"},
	{Code: "PDX", Country: "US", Name: "波特兰", English: "Portland"},
	{Code: "MSP", Country: "US", Name: "明尼阿波利斯", English: "Minneapolis"},
	{Code: "DTW", Country: "US", Name: "底特律", English: "Detroit"},
	{Code: "PHL", Country: "US", Name: "费城", English: "Philadelphia"},
	{Code: "CLT", Country: "US", Name: "夏洛特", English: "Charlotte"},
	{Code: "AUS", Country: "US", Name: "奥斯汀", English: "Austin"},
	{Code: "SLC", Country: "US", Name: "盐湖城", English: "Salt Lake City"},

	{Code: "YYZ", Country: "CA", Name: "多伦多", English: "Toronto"},
	{Code: "YVR", Country: "CA", Name: "温哥华", English: "Vancouver"},
	{Code: "YUL", Country: "CA", Name: "蒙特利尔", English: "Montreal"},
	{Code: "YYC", Country: "CA", Name: "卡尔加里", English: "Calgary"},
	{Code: "YOW", Country: "CA", Name: "渥太华", English: "Ottawa"},

	{Code: "LHR", Country: "GB", Name: "伦敦", English: "London", Aliases: []string{"london heathrow"}},
	{Code: "LGW", Country: "GB", Name: "伦敦盖特威克", English: "London Gatwick", Aliases: []string{"gatwick"}},
	{Code: "MAN", Country: "GB", Name: "曼彻斯特", English: "Manchester"},
	{Code: "EDI", Country: "GB", Name: "爱丁堡", English: "Edinburgh"},
	{Code: "BHX", Country: "GB", Name: "伯明翰", English: "Birmingham"},

	{Code: "FRA", Country: "DE", Name: "法兰克福", English: "Frankfurt"},
	{Code: "MUC", Country: "DE", Name: "慕尼黑", English: "Munich"},
	{Code: "BER", Country: "DE", Name: "柏林", English: "Berlin"},
	{Code: "DUS", Country: "DE", Name: "杜塞尔多夫", English: "Dusseldorf", Aliases: []string{"düsseldorf"}},
	{Code: "HAM", Country: "DE", Name: "汉堡", English: "Hamburg"},
	{Code: "STR", Country: "DE", Name: "斯图加特", English: "Stuttgart"},

	{Code: "CDG", Country: "FR", Name: "巴黎", English: "Paris", Aliases: []string{"paris charles de gaulle"}},
	{Code: "ORY", Country: "FR", Name: "巴黎奥利", English: "Paris Orly", Aliases: []string{"orly"}},
	{Code: "MRS", Country: "FR", Name: "马赛", English: "Marseille"},
	{Code: "LYS", Country: "FR", Name: "里昂", English: "Lyon"},

	{Code: "AMS", Country: "NL", Name: "阿姆斯特丹", English: "Amsterdam"},
	{Code: "BRU", Country: "BE", Name: "布鲁塞尔", English: "Brussels"},
	{Code: "ZRH", Country: "CH", Name: "苏黎世", English: "Zurich"},
	{Code: "GVA", Country: "CH", Name: "日内瓦", English: "Geneva"},
	{Code: "VIE", Country: "AT", Name: "维也纳", English: "Vienna"},
	{Code: "FCO", Country: "IT", Name: "罗马", English: "Rome"},
	{Code: "MXP", Country: "IT", Name: "米兰", English: "Milan"},
	{Code: "VCE", Country: "IT", Name: "威尼斯", English: "Venice"},
	{Code: "MAD", Country: "ES", Name: "马德里", English: "Madrid"},
	{Code: "BCN", Country: "ES", Name: "巴塞罗那", English: "Barcelona"},
	{Code: "LIS", Country: "PT", Name: "里斯本", English: "Lisbon"},
	{Code: "DUB", Country: "IE", Name: "都柏林", English: "Dublin"},
	{Code: "ARN", Country: "SE", Name: "斯德哥尔摩", English: "Stockholm"},
	{Code: "OSL", Country: "NO", Name: "奥斯陆", English: "Oslo"},
	{Code: "CPH", Country: "DK", Name: "哥本哈根", English: "Copenhagen"},
	{Code: "HEL", Country: "FI", Name: "赫尔辛基", English: "Helsinki"},
	{Code: "WAW", Country: "PL", Name: "华沙", English: "Warsaw"},
	{Code: "PRG", Country: "CZ", Name: "布拉格", English: "Prague"},
	{Code: "BUD", Country: "HU", Name: "布达佩斯", English: "Budapest"},
	{Code: "OTP", Country: "RO", Name: "布加勒斯特", English: "Bucharest"},
	{Code: "ATH", Country: "GR", Name: "雅典", English: "Athens"},
	{Code: "IST", Country: "TR", Name: "伊斯坦布尔", English: "Istanbul"},
	{Code: "MOW", Country: "RU", Name: "莫斯科", English: "Moscow"},
	{Code: "KBP", Country: "UA", Name: "基辅", English: "Kyiv", Aliases: []string{"kiev"}},

	{Code: "DXB", Country: "AE", Name: "迪拜", English: "Dubai"},
	{Code: "AUH", Country: "AE", Name: "阿布扎比", English: "Abu Dhabi"},
	{Code: "DOH", Country: "QA", Name: "多哈", English: "Doha"},
	{Code: "RUH", Country: "SA", Name: "利雅得", English: "Riyadh"},
	{Code: "JED", Country: "SA", Name: "吉达", English: "Jeddah"},
	{Code: "TLV", Country: "IL", Name: "特拉维夫", English: "Tel Aviv"},
	{Code: "BOM", Country: "IN", Name: "孟买", English: "Mumbai"},
	{Code: "DEL", Country: "IN", Name: "德里", English: "Delhi", Aliases: []string{"new delhi"}},
	{Code: "BLR", Country: "IN", Name: "班加罗尔", English: "Bangalore"},

	{Code: "SIN", Country: "SG", Name: "新加坡", English: "Singapore"},
	{Code: "KUL", Country: "MY", Name: "吉隆坡", English: "Kuala Lumpur"},
	{Code: "BKK", Country: "TH", Name: "曼谷", English: "Bangkok"},
	{Code: "SGN", Country: "VN", Name: "胡志明市", English: "Ho Chi Minh City", Aliases: []string{"ho chi minh", "saigon"}},
	{Code: "HAN", Country: "VN", Name: "河内", English: "Hanoi"},
	{Code: "MNL", Country: "PH", Name: "马尼拉", English: "Manila"},
	{Code: "CGK", Country: "ID", Name: "雅加达", English: "Jakarta"},

	{Code: "HKG", Country: "HK", Name: "香港", English: "Hong Kong"},
	{Code: "TPE", Country: "TW", Name: "台北", English: "Taipei"},
	{Code: "KHH", Country: "TW", Name: "高雄", English: "Kaohsiung"},
	{Code: "NRT", Country: "JP", Name: "东京成田", English: "Tokyo Narita", Aliases: []string{"narita", "tokyo"}},
	{Code: "HND", Country: "JP", Name: "东京羽田", English: "Tokyo Haneda", Aliases: []string{"haneda"}},
	{Code: "KIX", Country: "JP", Name: "大阪关西", English: "Osaka Kansai", Aliases: []string{"osaka", "kansai"}},
	{Code: "ITM", Country: "JP", Name: "大阪伊丹", English: "Osaka Itami", Aliases: []string{"itami"}},
	{Code: "FUK", Country: "JP", Name: "福冈", English: "Fukuoka"},
	{Code: "CTS", Country: "JP", Name: "札幌", English: "Sapporo"},
	{Code: "NGO", Country: "JP", Name: "名古屋", English: "Nagoya"},
	{Code: "ICN", Country: "KR", Name: "首尔仁川", English: "Seoul Incheon", Aliases: []string{"seoul", "incheon"}},
	{Code: "GMP", Country: "KR", Name: "首尔金浦", English: "Seoul Gimpo", Aliases: []string{"gimpo"}},
	{Code: "PUS", Country: "KR", Name: "釜山", English: "Busan"},

	{Code: "SYD", Country: "AU", Name: "悉尼", English: "Sydney"},
	{Code: "MEL", Country: "AU", Name: "墨尔本", English: "Melbourne"},
	{Code: "BNE", Country: "AU", Name: "布里斯班", English: "Brisbane"},
	{Code: "PER", Country: "AU", Name: "珀斯", English: "Perth"},
	{Code: "AKL", Country: "NZ", Name: "奥克兰", English: "Auckland"},

	{Code: "GRU", Country: "BR", Name: "圣保罗", English: "Sao Paulo", Aliases: []string{"são paulo"}},
	{Code: "GIG", Country: "BR", Name: "里约热内卢", English: "Rio de Janeiro", Aliases: []string{"rio"}},
	{Code: "EZE", Country: "AR", Name: "布宜诺斯艾利斯", English: "Buenos Aires"},
	{Code: "SCL", Country: "CL", Name: "圣地亚哥", English: "Santiago"},
	{Code: "BOG", Country: "CO", Name: "波哥大", English: "Bogota", Aliases: []string{"bogotá"}},
	{Code: "LIM", Country: "PE", Name: "利马", English: "Lima"},
	{Code: "MEX", Country: "MX", Name: "墨西哥城", English: "Mexico City"},

	{Code: "JNB", Country: "ZA", Name: "约翰内斯堡", English: "Johannesburg"},
	{Code: "CPT", Country: "ZA", Name: "开普敦", English: "Cape Town"},
	{Code: "CAI", Country: "EG", Name: "开罗", English: "Cairo"},
	{Code: "NBO", Country: "KE", Name: "内罗毕", English: "Nairobi"},
	{Code: "LOS", Country: "NG", Name: "拉各斯", English: "Lagos"},
	{Code: "CMN", Country: "MA", Name: "卡萨布兰卡", English: "Casablanca"},
}

var (
	cityByCode = func() map[string]City {
		table := make(map[string]City, len(cityDefs))
		for _, city := range cityDefs {
			table[city.Code] = city
		}
		return table
	}()
	cityCodesSorted = func() []string {
		codes := make([]string, 0, len(cityDefs))
		for _, city := range cityDefs {
			codes = append(codes, city.Code)
		}
		sort.Strings(codes)
		return codes
	}()
)

// NormalizeCityCode 规范化 IATA 城市码；非 3 字或未收录返回空串。
func NormalizeCityCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if _, found := cityByCode[code]; !found {
		return ""
	}
	return code
}

// ValidCity 判断 3 字码是否在码表中。
func ValidCity(code string) bool {
	_, found := cityByCode[strings.ToUpper(strings.TrimSpace(code))]
	return found
}

// CityName 返回城市码的中文名；未知码返回原码。
func CityName(code string) string {
	city, found := cityByCode[strings.ToUpper(strings.TrimSpace(code))]
	if !found {
		return strings.ToUpper(strings.TrimSpace(code))
	}
	return city.Name
}

// CityLabel 返回「美国·洛杉矶(LAX)」形式。
func CityLabel(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	city, found := cityByCode[code]
	if !found {
		return code
	}
	country := CountryLabel(city.Country)
	if country == "未知地区" {
		return fmt.Sprintf("%s(%s)", city.Name, code)
	}
	return fmt.Sprintf("%s·%s(%s)", country, city.Name, code)
}

// CityCodes 返回码表中全部城市码（稳定排序），供文档/补全使用。
func CityCodes() []string {
	return append([]string(nil), cityCodesSorted...)
}

// CityCodeFor 根据国家、Geo 城市名或节点名推导 IATA 城市码。
// 匹配不到返回空串；调用方仍可用国家粒度筛选。
func CityCodeFor(country, cityName, nodeName string) string {
	country = NormalizeCountry(country)
	cityName = strings.TrimSpace(cityName)
	if cityName != "" {
		normalized := normalizePlace(cityName)
		if code := strings.ToUpper(cityName); len(code) == 3 {
			if city, found := cityByCode[code]; found && (country == "" || city.Country == country) {
				return city.Code
			}
		}
		if city, found := matchCityName(country, normalized); found {
			return city.Code
		}
	}
	for _, token := range cityTokens(nodeName) {
		if city, found := cityByCode[token]; found && (country == "" || city.Country == country) {
			return city.Code
		}
	}
	return ""
}

func matchCityName(country, normalized string) (City, bool) {
	if normalized == "" {
		return City{}, false
	}
	// 先精确匹配，再匹配「Los Angeles, CA」这类带后缀的 Geo 名称。
	for _, city := range cityDefs {
		if country != "" && city.Country != country {
			continue
		}
		if matchesPlace(normalized, city) {
			return city, true
		}
	}
	for _, city := range cityDefs {
		if country != "" && city.Country != country {
			continue
		}
		for _, value := range placeValues(city) {
			if value == "" {
				continue
			}
			if strings.HasPrefix(normalized, value+" ") || strings.HasSuffix(normalized, " "+value) {
				return city, true
			}
		}
	}
	return City{}, false
}

func matchesPlace(normalized string, city City) bool {
	for _, value := range placeValues(city) {
		if value != "" && value == normalized {
			return true
		}
	}
	return false
}

func placeValues(city City) []string {
	values := make([]string, 0, 2+len(city.Aliases))
	values = append(values, normalizePlace(city.English), normalizePlace(city.Name))
	for _, alias := range city.Aliases {
		values = append(values, normalizePlace(alias))
	}
	return values
}

func normalizePlace(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.NewReplacer("’", "'", "　", " ").Replace(value)
	var builder strings.Builder
	lastSpace := false
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9', char > 127:
			builder.WriteRune(char)
			lastSpace = false
		case char == '\'' || char == '-':
			// keep compact: "sao paulo" / "são paulo" match
		default:
			if !lastSpace {
				builder.WriteByte(' ')
				lastSpace = true
			}
		}
	}
	return strings.TrimSpace(builder.String())
}

func cityTokens(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	var tokens []string
	var current strings.Builder
	flush := func() {
		if current.Len() == 3 {
			tokens = append(tokens, strings.ToUpper(current.String()))
		}
		current.Reset()
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') {
			current.WriteRune(char)
			continue
		}
		flush()
	}
	flush()
	return tokens
}

// CityInfo 返回城市码的完整定义。
func CityInfo(code string) (City, bool) {
	city, found := cityByCode[strings.ToUpper(strings.TrimSpace(code))]
	return city, found
}
