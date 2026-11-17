package codexclistartup

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Ordered JSON retains unknown model fields and JS property order. Maps sorted
// by encoding/json would change content hashes and drop the first-template ABI.
type field struct {
	key   string
	value any
}
type object []field

func (o object) get(key string) any {
	for _, f := range o {
		if f.key == key {
			return f.value
		}
	}
	return nil
}
func (o *object) set(key string, value any) {
	for i := range *o {
		if (*o)[i].key == key {
			(*o)[i].value = value
			return
		}
	}
	*o = append(*o, field{key, value})
}
func parseOrdered(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	value, err := orderedValue(decoder, 0)
	if err != nil {
		return nil, err
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, errInput
	}
	return value, nil
}
func orderedValue(d *json.Decoder, depth int) (any, error) {
	if depth > 100 {
		return nil, errInput
	}
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delim {
	case '{':
		out := object{}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return nil, err
			}
			key, ok := k.(string)
			if !ok {
				return nil, errInput
			}
			value, err := orderedValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			out.set(key, value)
		}
		if end, err := d.Token(); err != nil || end != json.Delim('}') {
			return nil, errInput
		}
		return out, nil
	case '[':
		out := []any{}
		for d.More() {
			value, err := orderedValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, value)
		}
		if end, err := d.Token(); err != nil || end != json.Delim(']') {
			return nil, errInput
		}
		return out, nil
	}
	return nil, errInput
}
func appendString(b []byte, s string) []byte {
	b = append(b, '"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b = append(b, '\\', byte(r))
		case '\b':
			b = append(b, '\\', 'b')
		case '\f':
			b = append(b, '\\', 'f')
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			if r < 0x20 {
				const h = "0123456789abcdef"
				b = append(b, '\\', 'u', '0', '0', h[r>>4], h[r&15])
			} else {
				b = append(b, string(r)...)
			}
		}
	}
	return append(b, '"')
}
func appendNumber(b []byte, n float64) []byte {
	if n == 0 {
		return append(b, '0')
	}
	if math.IsInf(n, 0) || math.IsNaN(n) {
		return append(b, "null"...)
	}
	if a := math.Abs(n); a >= 1e-6 && a < 1e21 {
		return strconv.AppendFloat(b, n, 'f', -1, 64)
	}
	s := strconv.FormatFloat(n, 'e', -1, 64)
	if i := strings.IndexByte(s, 'e'); i >= 0 && len(s) > i+3 {
		s = s[:i+2] + strings.TrimLeft(s[i+2:], "0")
	}
	return append(b, s...)
}
func appendJSON(b []byte, value any) []byte {
	switch v := value.(type) {
	case nil:
		return append(b, "null"...)
	case bool:
		return strconv.AppendBool(b, v)
	case string:
		return appendString(b, v)
	case float64:
		return appendNumber(b, v)
	case []any:
		b = append(b, '[')
		for i, item := range v {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendJSON(b, item)
		}
		return append(b, ']')
	case object:
		// JS enumeration puts canonical array-index keys first, numerically.
		fields := append(object(nil), v...)
		index := func(s string) (uint64, bool) {
			n, err := strconv.ParseUint(s, 10, 32)
			return n, err == nil && n < 1<<32-1 && strconv.FormatUint(n, 10) == s
		}
		sort.SliceStable(fields, func(i, j int) bool {
			a, ai := index(fields[i].key)
			c, ci := index(fields[j].key)
			if ai != ci {
				return ai
			}
			return ai && a < c
		})
		b = append(b, '{')
		for i, f := range fields {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendString(b, f.key)
			b = append(b, ':')
			b = appendJSON(b, f.value)
		}
		return append(b, '}')
	}
	return append(b, "null"...)
}
