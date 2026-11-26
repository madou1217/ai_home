package appcatalog

import (
	"bytes"
	"encoding/binary"
	"strconv"
	"strings"
	"unicode/utf16"
)

// parseInfoPlistStrings extracts CFBundleDisplayName and CFBundleName from a macOS
// InfoPlist.strings file. Supports traditional OpenStep .strings text (UTF-8, UTF-16LE,
// UTF-16BE), XML property lists, and binary property lists (bplist00).
// Malformed inputs return nil without affecting application scanning.
func parseInfoPlistStrings(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	if bytes.HasPrefix(data, []byte("bplist00")) {
		return parseBinaryPlistStrings(data)
	}
	text := decodeStringsText(data)
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, "<?xml") ||
		strings.HasPrefix(trimmed, "<plist") ||
		strings.HasPrefix(trimmed, "<!DOCTYPE") {
		return parseInfoPlist([]byte(trimmed)).Names
	}
	return parseOpenStepStrings(text)
}

func decodeStringsText(data []byte) string {
	if len(data) >= 2 {
		if data[0] == 0xFF && data[1] == 0xFE {
			return decodeUTF16(data[2:], binary.LittleEndian)
		}
		if data[0] == 0xFE && data[1] == 0xFF {
			return decodeUTF16(data[2:], binary.BigEndian)
		}
	}
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		return string(data[3:])
	}
	// Heuristic for BOM-less UTF-16 .strings files containing ASCII keys/delimiters.
	if len(data) >= 4 && len(data)%2 == 0 {
		sampleLen := len(data)
		if sampleLen > 128 {
			sampleLen = 128
		}
		evenZeros := 0
		oddZeros := 0
		for i := 0; i < sampleLen; i += 2 {
			if data[i] == 0 {
				evenZeros++
			}
			if data[i+1] == 0 {
				oddZeros++
			}
		}
		if oddZeros >= 2 && evenZeros == 0 {
			return decodeUTF16(data, binary.LittleEndian)
		}
		if evenZeros >= 2 && oddZeros == 0 {
			return decodeUTF16(data, binary.BigEndian)
		}
	}
	return string(data)
}

func decodeUTF16(data []byte, order binary.ByteOrder) string {
	n := len(data) / 2
	if n == 0 {
		return ""
	}
	u16 := make([]uint16, n)
	for i := 0; i < n; i++ {
		u16[i] = order.Uint16(data[2*i : 2*i+2])
	}
	return string(utf16.Decode(u16))
}

func parseOpenStepStrings(text string) []string {
	var displayName, bundleName string
	n := len(text)
	i := 0
	for i < n {
		i = skipStringsWSAndComments(text, i)
		if i >= n {
			break
		}
		key, next, ok := parseStringsToken(text, i)
		if !ok {
			i = skipStringsRecovery(text, i)
			continue
		}
		i = skipStringsWSAndComments(text, next)
		if i >= n || text[i] != '=' {
			i = skipStringsRecovery(text, i)
			continue
		}
		i = skipStringsWSAndComments(text, i+1)
		if i >= n {
			break
		}
		val, next, ok := parseStringsToken(text, i)
		if !ok {
			i = skipStringsRecovery(text, i)
			continue
		}
		i = skipStringsWSAndComments(text, next)
		if i < n && text[i] == ';' {
			i++
		}

		val = strings.TrimSpace(val)
		switch strings.TrimSpace(key) {
		case "CFBundleDisplayName":
			if displayName == "" && val != "" {
				displayName = val
			}
		case "CFBundleName":
			if bundleName == "" && val != "" {
				bundleName = val
			}
		}
	}
	return collectPlistNames(displayName, bundleName)
}

func skipStringsWSAndComments(s string, i int) int {
	n := len(s)
	for i < n {
		// Skip UTF-8 BOM if present inline.
		if i+3 <= n && s[i] == 0xEF && s[i+1] == 0xBB && s[i+2] == 0xBF {
			i += 3
			continue
		}
		c := s[i]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			i++
			continue
		}
		if c == '/' && i+1 < n {
			if s[i+1] == '*' {
				end := strings.Index(s[i+2:], "*/")
				if end < 0 {
					return n
				}
				i += 2 + end + 2
				continue
			}
			if s[i+1] == '/' {
				end := strings.IndexByte(s[i+2:], '\n')
				if end < 0 {
					return n
				}
				i += 2 + end + 1
				continue
			}
		}
		break
	}
	return i
}

func skipStringsRecovery(s string, i int) int {
	n := len(s)
	for i < n {
		if s[i] == ';' || s[i] == '\n' {
			return i + 1
		}
		i++
	}
	return n
}

func parseStringsToken(s string, i int) (string, int, bool) {
	n := len(s)
	if i >= n {
		return "", n, false
	}
	if s[i] == '"' {
		return parseStringsQuoted(s, i)
	}
	start := i
	for i < n {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '=' || c == ';' || c == '"' || c == '/' {
			break
		}
		i++
	}
	if i == start {
		return "", i, false
	}
	return s[start:i], i, true
}

func parseStringsQuoted(s string, start int) (string, int, bool) {
	n := len(s)
	if start >= n || s[start] != '"' {
		return "", start, false
	}
	var b strings.Builder
	i := start + 1
	for i < n {
		c := s[i]
		if c == '"' {
			return b.String(), i + 1, true
		}
		if c != '\\' {
			b.WriteByte(c)
			i++
			continue
		}
		i++
		if i >= n {
			return "", n, false
		}
		esc := s[i]
		switch esc {
		case '"', '\\', '/':
			b.WriteByte(esc)
			i++
		case 'n':
			b.WriteByte('\n')
			i++
		case 'r':
			b.WriteByte('\r')
			i++
		case 't':
			b.WriteByte('\t')
			i++
		case 'U', 'u':
			if i+5 <= n {
				code, err := strconv.ParseUint(s[i+1:i+5], 16, 16)
				if err == nil {
					r1 := rune(code)
					i += 5
					// Combine UTF-16 surrogate pairs (\UD83D\UDE00).
					if utf16.IsSurrogate(r1) && i+6 <= n && s[i] == '\\' && (s[i+1] == 'U' || s[i+1] == 'u') {
						if code2, err2 := strconv.ParseUint(s[i+2:i+6], 16, 16); err2 == nil {
							combined := utf16.DecodeRune(r1, rune(code2))
							if combined != '\uFFFD' {
								b.WriteRune(combined)
								i += 6
								continue
							}
						}
					}
					b.WriteRune(r1)
					continue
				}
			}
			b.WriteByte(esc)
			i++
		case '0', '1', '2', '3', '4', '5', '6', '7':
			end := i + 1
			for end < n && end < i+3 && s[end] >= '0' && s[end] <= '7' {
				end++
			}
			if oct, err := strconv.ParseUint(s[i:end], 8, 16); err == nil {
				b.WriteRune(rune(oct))
			}
			i = end
		default:
			b.WriteByte(esc)
			i++
		}
	}
	return "", n, false
}

// parseBinaryPlistStrings extracts CFBundleDisplayName and CFBundleName from a top-level
// dictionary in an Apple binary property list (bplist00) without external dependencies.
func parseBinaryPlistStrings(data []byte) []string {
	const (
		bplistHeaderLen  = 8
		bplistTrailerLen = 32
		maxObjects       = 1 << 20
	)
	if len(data) < bplistHeaderLen+bplistTrailerLen || !bytes.HasPrefix(data, []byte("bplist00")) {
		return nil
	}
	bodyLimit := uint64(len(data) - bplistTrailerLen)
	trailer := data[bodyLimit:]

	offsetSize := int(trailer[6])
	objectRefSize := int(trailer[7])
	if !isValidBplistIntSize(offsetSize) || !isValidBplistIntSize(objectRefSize) {
		return nil
	}
	numObjects := binary.BigEndian.Uint64(trailer[8:16])
	topObject := binary.BigEndian.Uint64(trailer[16:24])
	offsetTableOffset := binary.BigEndian.Uint64(trailer[24:32])

	if numObjects == 0 || numObjects > maxObjects || topObject >= numObjects {
		return nil
	}
	if offsetTableOffset < bplistHeaderLen || offsetTableOffset >= bodyLimit {
		return nil
	}
	if numObjects > (bodyLimit-offsetTableOffset)/uint64(offsetSize) {
		return nil
	}

	readUint := func(pos uint64, size int) (uint64, bool) {
		if pos > uint64(len(data)) || uint64(size) > uint64(len(data))-pos {
			return 0, false
		}
		var v uint64
		for i := 0; i < size; i++ {
			v = (v << 8) | uint64(data[pos+uint64(i)])
		}
		return v, true
	}

	objectOffset := func(idx uint64) (uint64, bool) {
		if idx >= numObjects {
			return 0, false
		}
		pos := offsetTableOffset + idx*uint64(offsetSize)
		off, ok := readUint(pos, offsetSize)
		if !ok || off < bplistHeaderLen || off >= offsetTableOffset {
			return 0, false
		}
		return off, true
	}

	readCount := func(marker byte, pos uint64) (uint64, uint64, bool) {
		low := uint64(marker & 0x0F)
		if low < 0x0F {
			return low, pos, true
		}
		if pos >= offsetTableOffset {
			return 0, 0, false
		}
		intMarker := data[pos]
		if intMarker&0xF0 != 0x10 {
			return 0, 0, false
		}
		pow := intMarker & 0x0F
		if pow > 3 {
			return 0, 0, false
		}
		byteCount := 1 << pow
		if pos+1 > offsetTableOffset || uint64(byteCount) > offsetTableOffset-(pos+1) {
			return 0, 0, false
		}
		val, ok := readUint(pos+1, byteCount)
		if !ok {
			return 0, 0, false
		}
		return val, pos + 1 + uint64(byteCount), true
	}

	readStringObj := func(idx uint64) (string, bool) {
		off, ok := objectOffset(idx)
		if !ok {
			return "", false
		}
		marker := data[off]
		kind := marker & 0xF0
		count, bodyPos, ok := readCount(marker, off+1)
		if !ok || bodyPos > offsetTableOffset {
			return "", false
		}
		switch kind {
		case 0x50, 0x70: // ASCII or UTF-8 string
			if count > offsetTableOffset-bodyPos {
				return "", false
			}
			return string(data[bodyPos : bodyPos+count]), true
		case 0x60: // UTF-16BE string
			if count > (offsetTableOffset-bodyPos)/2 {
				return "", false
			}
			return decodeUTF16(data[bodyPos:bodyPos+count*2], binary.BigEndian), true
		default:
			return "", false
		}
	}

	topOff, ok := objectOffset(topObject)
	if !ok {
		return nil
	}
	topMarker := data[topOff]
	if topMarker&0xF0 != 0xD0 {
		return nil
	}
	entryCount, entriesPos, ok := readCount(topMarker, topOff+1)
	if !ok || entriesPos > offsetTableOffset {
		return nil
	}
	refSize := uint64(objectRefSize)
	if entryCount > (offsetTableOffset-entriesPos)/(2*refSize) {
		return nil
	}

	keysPos := entriesPos
	valsPos := entriesPos + entryCount*refSize
	var displayName, bundleName string
	for i := uint64(0); i < entryCount; i++ {
		keyRef, ok := readUint(keysPos+i*refSize, objectRefSize)
		if !ok {
			break
		}
		keyStr, ok := readStringObj(keyRef)
		if !ok {
			continue
		}
		if keyStr != "CFBundleDisplayName" && keyStr != "CFBundleName" {
			continue
		}
		valRef, ok := readUint(valsPos+i*refSize, objectRefSize)
		if !ok {
			continue
		}
		valStr, ok := readStringObj(valRef)
		if !ok {
			continue
		}
		valStr = strings.TrimSpace(valStr)
		if keyStr == "CFBundleDisplayName" && displayName == "" && valStr != "" {
			displayName = valStr
		} else if keyStr == "CFBundleName" && bundleName == "" && valStr != "" {
			bundleName = valStr
		}
	}
	return collectPlistNames(displayName, bundleName)
}

func isValidBplistIntSize(size int) bool {
	return size == 1 || size == 2 || size == 4 || size == 8
}
