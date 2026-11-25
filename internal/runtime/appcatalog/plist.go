package appcatalog

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
)

type infoPlistMeta struct {
	Names          []string
	UIElement      bool
	BackgroundOnly bool
}

func (m infoPlistMeta) isBackgroundHelper() bool {
	return m.UIElement || m.BackgroundOnly
}

// parseInfoPlist extracts CFBundleDisplayName, CFBundleName, LSUIElement, and LSBackgroundOnly
// from the top-level <dict> of an XML Info.plist. Binary plists (bplist00) return zero metadata
// so callers retain the bundle with its directory basename.
func parseInfoPlist(data []byte) infoPlistMeta {
	var meta infoPlistMeta
	if len(data) == 0 || bytes.HasPrefix(data, []byte("bplist00")) {
		return meta
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	dictDepth := 0
	arrayDepth := 0
	pendingKey := ""
	displayName := ""
	bundleName := ""

	finish := func() infoPlistMeta {
		meta.Names = collectPlistNames(displayName, bundleName)
		return meta
	}

	for {
		tok, err := dec.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return finish()
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
						return finish()
					}
					pendingKey = strings.TrimSpace(key)
				}
			case "true":
				if dictDepth == 1 && arrayDepth == 0 {
					switch pendingKey {
					case "LSUIElement":
						meta.UIElement = true
					case "LSBackgroundOnly":
						meta.BackgroundOnly = true
					}
					pendingKey = ""
				}
			case "false":
				if dictDepth == 1 && arrayDepth == 0 {
					pendingKey = ""
				}
			case "string":
				if dictDepth == 1 && arrayDepth == 0 {
					switch pendingKey {
					case "CFBundleDisplayName", "CFBundleName", "LSUIElement", "LSBackgroundOnly":
						var val string
						if err := dec.DecodeElement(&val, &t); err != nil {
							return finish()
						}
						val = strings.TrimSpace(val)
						switch pendingKey {
						case "CFBundleDisplayName":
							if displayName == "" && val != "" {
								displayName = val
							}
						case "CFBundleName":
							if bundleName == "" && val != "" {
								bundleName = val
							}
						case "LSUIElement":
							if isPlistTruthy(val) {
								meta.UIElement = true
							}
						case "LSBackgroundOnly":
							if isPlistTruthy(val) {
								meta.BackgroundOnly = true
							}
						}
					}
					pendingKey = ""
				}
			case "integer":
				if dictDepth == 1 && arrayDepth == 0 {
					if pendingKey == "LSUIElement" || pendingKey == "LSBackgroundOnly" {
						var val string
						if err := dec.DecodeElement(&val, &t); err != nil {
							return finish()
						}
						if isPlistTruthy(strings.TrimSpace(val)) {
							if pendingKey == "LSUIElement" {
								meta.UIElement = true
							} else {
								meta.BackgroundOnly = true
							}
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
	return finish()
}

func isPlistTruthy(val string) bool {
	return val == "1" || strings.EqualFold(val, "true") || strings.EqualFold(val, "yes")
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
