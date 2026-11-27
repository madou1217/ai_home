package proxyregion

import (
	"fmt"
	"strings"

	"golang.org/x/text/language"
	"golang.org/x/text/language/display"
)

// countryNameOverrides 把 CLDR 的长名称压成文档/补全里更短的常用名。
var countryNameOverrides = map[string]string{
	"HK": "中国香港",
	"MO": "中国澳门",
	"TW": "中国台湾",
	"GB": "英国",
	"US": "美国",
	"SG": "新加坡",
	"JP": "日本",
	"KR": "韩国",
	"DE": "德国",
	"FR": "法国",
	"NL": "荷兰",
	"CA": "加拿大",
	"AU": "澳大利亚",
	"NZ": "新西兰",
	"RU": "俄罗斯",
	"IN": "印度",
	"AE": "阿联酋",
	"TR": "土耳其",
	"BR": "巴西",
	"ZA": "南非",
}

// NormalizeCountry 规范化国家码；空值、UN（其它/未解析）和非法值返回空串。
func NormalizeCountry(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" || code == "UN" || len(code) != 2 || !asciiLetters(code) {
		return ""
	}
	return code
}

// ValidCountry 判断 2 字码是否是可用于筛选的国家（ISO 3166-1 alpha-2）。
func ValidCountry(code string) bool {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) != 2 || !asciiLetters(code) || code == "UN" || code == "ZZ" {
		return false
	}
	region, err := language.ParseRegion(code)
	return err == nil && region.IsCountry()
}

// CountryName 返回国家码对应的中文名；未知码返回原码。
func CountryName(code string) string {
	code = NormalizeCountry(code)
	if code == "" {
		return ""
	}
	if name, found := countryNameOverrides[code]; found {
		return name
	}
	region, err := language.ParseRegion(code)
	if err != nil {
		return code
	}
	name := strings.TrimSpace(display.Chinese.Regions().Name(region))
	if name == "" || name == code {
		return code
	}
	return name
}

// CountryLabel 返回「美国(US)」形式；未知码返回原码。
func CountryLabel(code string) string {
	code = NormalizeCountry(code)
	if code == "" {
		return "未知地区"
	}
	return fmt.Sprintf("%s(%s)", CountryName(code), code)
}

func asciiLetters(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') {
			return false
		}
	}
	return true
}

// commonCountryCodes 是代理池常见国家的稳定列表，供离线码表与补全兜底。
var commonCountryCodes = []string{
	"AE", "AU", "BR", "CA", "CH", "DE", "ES", "FR", "GB", "HK",
	"ID", "IE", "IL", "IN", "IT", "JP", "KR", "MY", "NL", "NZ",
	"PH", "PL", "QA", "RU", "SA", "SE", "SG", "TH", "TR", "TW",
	"US", "VN", "ZA",
}

// CountryCodes 返回常见国家码（稳定排序）。
func CountryCodes() []string {
	return append([]string(nil), commonCountryCodes...)
}
