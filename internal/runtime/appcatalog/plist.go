package appcatalog

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
)

// parseInfoPlistNames extracts non-empty CFBundleDisplayName and CFBundleName from an XML Info.plist.
// Binary plists (bplist00) or malformed documents return nil so callers keep only the bundle basename.
func parseInfoPlistNames(data []byte) []string {
	if len(data) == 0 || bytes.HasPrefix(data, []byte("bplist00")) {
		return nil
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	dictDepth := 0
	arrayDepth := 0
	pendingKey := ""
	displayName := ""
	bundleName := ""

	for {
		tok, err := dec.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return collectPlistNames(displayName, bundleName)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "dict":
				if dictDepth == 1 && arrayDepth == 0 {
					pendingKey = ""
				}
				dictDepth++
			case "array":
				if dictDepth == 1 && arrayDepth == 0 {
					pendingKey = ""
				}
				arrayDepth++
			case "key":
				if dictDepth == 1 && arrayDepth == 0 {
					var key string
					if err := dec.DecodeElement(&key, &t); err != nil {
						return collectPlistNames(displayName, bundleName)
					}
					pendingKey = strings.TrimSpace(key)
				}
			case "string":
				if dictDepth == 1 && arrayDepth == 0 {
					if pendingKey == "CFBundleDisplayName" || pendingKey == "CFBundleName" {
						var val string
						if err := dec.DecodeElement(&val, &t); err != nil {
							return collectPlistNames(displayName, bundleName)
						}
						val = strings.TrimSpace(val)
						if pendingKey == "CFBundleDisplayName" && displayName == "" && val != "" {
							displayName = val
						} else if pendingKey == "CFBundleName" && bundleName == "" && val != "" {
							bundleName = val
						}
					}
					pendingKey = ""
				}
			default:
				if dictDepth == 1 && arrayDepth == 0 {
					pendingKey = ""
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "dict":
				if dictDepth > 0 {
					dictDepth--
				}
			case "array":
				if arrayDepth > 0 {
					arrayDepth--
				}
			}
		}
	}
	return collectPlistNames(displayName, bundleName)
}

func collectPlistNames(displayName, bundleName string) []string {
	var names []string
	if displayName != "" {
		names = append(names, displayName)
	}
	if bundleName != "" && !strings.EqualFold(bundleName, displayName) {
		names = append(names, bundleName)
	}
	return names
}
