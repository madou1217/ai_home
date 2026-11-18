package accountusage

// Compatibility at the migration boundary, not a second quota policy. Snapshot
// values came from JSON but the former compiler used JavaScript coercions,
// ECMAScript whitespace, UTF-16 slicing and positive-half Math.round.
import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

type usageUndefined struct{}

var usageMissing = usageUndefined{}

type usageJSString string

// MarshalJSON preserves a lone UTF-16 half produced by String.slice(0, 256).
// Go's normal JSON encoder replaces that value; JSON.stringify escapes it.
func (value usageJSString) MarshalJSON() ([]byte, error) {
	var result bytes.Buffer
	result.WriteByte('"')
	for _, unit := range usageUTF16(string(value)) {
		switch unit {
		case '"', '\\':
			result.WriteByte('\\')
			result.WriteByte(byte(unit))
		case '\b':
			result.WriteString(`\b`)
		case '\f':
			result.WriteString(`\f`)
		case '\n':
			result.WriteString(`\n`)
		case '\r':
			result.WriteString(`\r`)
		case '\t':
			result.WriteString(`\t`)
		default:
			if unit < 0x20 || unit >= 0xd800 && unit <= 0xdfff {
				result.WriteString(`\u`)
				result.WriteString(strconv.FormatUint(uint64(unit)|0x10000, 16)[1:])
			} else {
				result.WriteRune(rune(unit))
			}
		}
	}
	result.WriteByte('"')
	return result.Bytes(), nil
}

// WTF-8 is used only inside this pure compiler to retain JSON's lone surrogate
// escapes. It never reaches an OS path, log, identifier or a database directly.
func usageWriteRune(out *strings.Builder, r rune) {
	if r >= 0xd800 && r <= 0xdfff {
		out.WriteByte(byte(0xe0 | r>>12))
		out.WriteByte(byte(0x80 | r>>6&63))
		out.WriteByte(byte(0x80 | r&63))
		return
	}
	out.WriteRune(r)
}
func usageRunes(value string) []rune {
	result := make([]rune, 0, len(value))
	for len(value) > 0 {
		if len(value) >= 3 && value[0] == 0xed && value[1] >= 0xa0 && value[1] <= 0xbf && value[2]&0xc0 == 0x80 {
			result = append(result, rune(value[0]&15)<<12|rune(value[1]&63)<<6|rune(value[2]&63))
			value = value[3:]
			continue
		}
		r, n := utf8.DecodeRuneInString(value)
		result = append(result, r)
		value = value[n:]
	}
	return result
}
func usageUTF16(value string) []uint16 {
	result := make([]uint16, 0, len(value))
	for _, r := range usageRunes(value) {
		if r > 0xffff {
			a, b := utf16.EncodeRune(r)
			result = append(result, uint16(a), uint16(b))
		} else {
			result = append(result, uint16(r))
		}
	}
	return result
}
func usageFromUTF16(units []uint16) string {
	var out strings.Builder
	for index := 0; index < len(units); index++ {
		r := rune(units[index])
		if r >= 0xd800 && r <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
			r = utf16.DecodeRune(r, rune(units[index+1]))
			index++
		}
		usageWriteRune(&out, r)
	}
	return out.String()
}
func usageSlice(value string, max int) string {
	units := usageUTF16(value)
	if len(units) > max {
		units = units[:max]
	}
	return usageFromUTF16(units)
}
func usageSpace(r rune) bool {
	return r >= 0x09 && r <= 0x0d || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func usageTrim(value string) string { return strings.TrimFunc(value, usageSpace) }
func usageCaseIgnorable(r rune) bool {
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Lm, r) || unicode.Is(unicode.Sk, r) {
		return true
	}
	// Unicode Case_Ignorable also includes Word_Break MidLetter/MidNumLet/
	// Single_Quote characters outside those categories. Existing Unicode15.1
	// data is pinned in the review inputs; this is not a provider policy table.
	switch r {
	case 0x27, 0x2e, 0x3a, 0xb7, 0x387, 0x55f, 0x5f4, 0x2018, 0x2019, 0x2024, 0x2027, 0xfe13, 0xfe52, 0xfe55, 0xff07, 0xff0e, 0xff1a, 0x1171e:
		return true
	}
	return false
}
func usageCased(r rune) bool {
	return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) || unicode.Is(unicode.Other_Lowercase, r) || unicode.Is(unicode.Other_Uppercase, r)
}
func usageLower(value string) string {
	runes := usageRunes(value)
	var out strings.Builder
	for index, r := range runes {
		if r == 0x130 {
			out.WriteString("i\u0307")
			continue
		}
		if r == 0x3a3 {
			before, after := false, false
			for i := index - 1; i >= 0; i-- {
				if usageCaseIgnorable(runes[i]) {
					continue
				}
				before = usageCased(runes[i])
				break
			}
			for i := index + 1; i < len(runes); i++ {
				if usageCaseIgnorable(runes[i]) {
					continue
				}
				after = usageCased(runes[i])
				break
			}
			if before && !after {
				r = 0x3c2
			} else {
				r = 0x3c3
			}
		} else {
			r = unicode.ToLower(r)
		}
		usageWriteRune(&out, r)
	}
	return out.String()
}

func usageDecode(raw json.RawMessage, depth int) (any, error) {
	if depth > 128 {
		return nil, errors.New("usage_facts_json_depth")
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return usageMissing, nil
	}
	switch raw[0] {
	case '"':
		// Validate escapes first, then decode UTF-16 ourselves rather than losing
		// unpaired surrogates in encoding/json's replacement conversion.
		if !json.Valid(raw) {
			return nil, errors.New("usage_facts_json_invalid")
		}
		var units []uint16
		for i := 1; i < len(raw)-1; {
			if raw[i] == '\\' {
				i++
				c := raw[i]
				i++
				if c == 'u' {
					n, err := strconv.ParseUint(string(raw[i:i+4]), 16, 16)
					if err != nil {
						return nil, err
					}
					units = append(units, uint16(n))
					i += 4
					continue
				}
				switch c {
				case 'b':
					c = '\b'
				case 'f':
					c = '\f'
				case 'n':
					c = '\n'
				case 'r':
					c = '\r'
				case 't':
					c = '\t'
				}
				units = append(units, uint16(c))
				continue
			}
			r, n := utf8.DecodeRune(raw[i:])
			i += n
			if r > 0xffff {
				a, b := utf16.EncodeRune(r)
				units = append(units, uint16(a), uint16(b))
			} else {
				units = append(units, uint16(r))
			}
		}
		return usageFromUTF16(units), nil
	case '{':
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return nil, err
		}
		value := make(map[string]any, len(fields))
		for key, item := range fields {
			decoded, err := usageDecode(item, depth+1)
			if err != nil {
				return nil, err
			}
			value[key] = decoded
		}
		return value, nil
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, err
		}
		value := make([]any, 0, len(items))
		for _, item := range items {
			decoded, err := usageDecode(item, depth+1)
			if err != nil {
				return nil, err
			}
			value = append(value, decoded)
		}
		return value, nil
	case 'n':
		return nil, nil
	case 't':
		return true, nil
	case 'f':
		return false, nil
	default:
		number, err := strconv.ParseFloat(string(raw), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, err
		}
		return number, nil
	}
}
func usageGet(value any, key string) any {
	if fields, ok := value.(map[string]any); ok {
		if item, exists := fields[key]; exists {
			return item
		}
	}
	return usageMissing
}
func usageTruthy(value any) bool {
	switch v := value.(type) {
	case usageUndefined:
		return false
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && !math.IsNaN(v)
	default:
		return true
	}
}
func usageOrEmpty(value any) any {
	if usageTruthy(value) {
		return value
	}
	return ""
}
func usageString(value any) (string, error) {
	switch v := value.(type) {
	case usageUndefined:
		return "undefined", nil
	case nil:
		return "null", nil
	case string:
		return v, nil
	case bool:
		if v {
			return "true", nil
		}
		return "false", nil
	case float64:
		return usageNumberString(v), nil
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			if item == nil {
				continue
			}
			if _, missing := item.(usageUndefined); missing {
				continue
			}
			s, err := usageString(item)
			if err != nil {
				return "", err
			}
			parts[i] = s
		}
		return strings.Join(parts, ","), nil
	case map[string]any:
		if _, shadowed := v["toString"]; shadowed {
			return "", errors.New("usage_facts_coercion_invalid")
		}
		return "[object Object]", nil
	default:
		return "", errors.New("usage_facts_coercion_invalid")
	}
}
func usageStringField(value any) (string, error) {
	s, err := usageString(usageOrEmpty(value))
	return usageTrim(s), err
}
func usageText(value any) string {
	if s, ok := value.(string); ok {
		return usageTrim(s)
	}
	return ""
}

var usageDecimal = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func usageNumber(value any) (float64, error) {
	switch v := value.(type) {
	case usageUndefined:
		return math.NaN(), nil
	case nil:
		return 0, nil
	case bool:
		if v {
			return 1, nil
		}
		return 0, nil
	case float64:
		return v, nil
	default:
		s, err := usageString(v)
		if err != nil {
			return 0, err
		}
		s = usageTrim(s)
		if s == "" {
			return 0, nil
		}
		if s == "Infinity" || s == "+Infinity" {
			return math.Inf(1), nil
		}
		if s == "-Infinity" {
			return math.Inf(-1), nil
		}
		if len(s) > 2 && s[0] == '0' {
			base := 0
			switch s[1] {
			case 'x', 'X':
				base = 16
			case 'b', 'B':
				base = 2
			case 'o', 'O':
				base = 8
			}
			if base != 0 {
				integer, ok := new(big.Int).SetString(s[2:], base)
				if !ok || strings.ContainsAny(s[2:], "_+-") {
					return math.NaN(), nil
				}
				f, _ := new(big.Float).SetInt(integer).Float64()
				return f, nil
			}
		}
		if !usageDecimal.MatchString(s) {
			return math.NaN(), nil
		}
		n, parseErr := strconv.ParseFloat(s, 64)
		if parseErr != nil && !errors.Is(parseErr, strconv.ErrRange) {
			return math.NaN(), nil
		}
		return n, nil
	}
}
func usageFinite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
func usageNumberString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	if value == 0 {
		return "0"
	}
	a := math.Abs(value)
	if a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	s := strconv.FormatFloat(value, 'e', -1, 64)
	parts := strings.SplitN(s, "e", 2)
	exp, _ := strconv.Atoi(parts[1])
	sign := ""
	if exp >= 0 {
		sign = "+"
	}
	return parts[0] + "e" + sign + strconv.Itoa(exp)
}
func usageNormalizedNumber(value any) (float64, bool, error) {
	if value == nil {
		return 0, false, nil
	}
	if _, ok := value.(usageUndefined); ok {
		return 0, false, nil
	}
	if s, ok := value.(string); ok && s == "" {
		return 0, false, nil
	}
	n, err := usageNumber(value)
	return n, usageFinite(n), err
}
func usageSanitize(value any, fallback string) (string, error) {
	if value == nil {
		value = ""
	}
	if _, missing := value.(usageUndefined); missing {
		value = ""
	}
	s, err := usageString(value)
	if err != nil {
		return "", err
	}
	s = usageLower(usageTrim(s))
	var out strings.Builder
	replacing := false
	for _, r := range usageRunes(s) {
		valid := r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("_.:-", r)
		if valid {
			out.WriteByte(byte(r))
			replacing = false
		} else if !replacing {
			out.WriteByte('_')
			replacing = true
		}
	}
	s = strings.Trim(out.String(), "_")
	if len(s) > 128 {
		s = s[:128]
	}
	if s == "" {
		s = fallback
	}
	return s, nil
}

// Math.round(x) chooses the upper integer at an exact half, and must not use
// Floor(x+.5): the addition itself rounds a just-below-half binary64 value.
func usageRound(value float64) float64 {
	if !usageFinite(value) || value == 0 {
		return value
	}
	floor := math.Floor(value)
	if value-floor >= 0.5 {
		return floor + 1
	}
	return floor
}

type usageJSONNumber float64

func (value usageJSONNumber) MarshalJSON() ([]byte, error) {
	n := float64(value)
	if !usageFinite(n) {
		return []byte("null"), nil
	}
	return []byte(usageNumberString(n)), nil
}
