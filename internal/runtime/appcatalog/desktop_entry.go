package appcatalog

import (
	"bufio"
	"bytes"
	"strings"
)

type desktopEntry struct {
	Type            string
	Hidden          bool
	NoDisplay       bool
	Name            string
	NameZH          string
	NameZHCN        string
	Comment         string
	CommentZH       string
	CommentZHCN     string
	GenericName     string
	GenericNameZH   string
	GenericNameZHCN string
	Exec            string
	Icon            string
	Terminal        bool
}

// parseDesktopEntry parses the [Desktop Entry] section of an XDG .desktop INI file.
func parseDesktopEntry(data []byte) (desktopEntry, bool) {
	var entry desktopEntry
	inSection := false
	foundSection := false

	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 16*1024), 512*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			if line == "[Desktop Entry]" {
				inSection = true
				foundSection = true
				continue
			}
			if inSection {
				// Reached another section (e.g. [Desktop Action ...]); stop reading entry keys.
				break
			}
			continue
		}
		if !inSection {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		switch key {
		case "Type":
			entry.Type = val
		case "Hidden":
			entry.Hidden = strings.EqualFold(val, "true")
		case "NoDisplay":
			entry.NoDisplay = strings.EqualFold(val, "true")
		case "Name":
			entry.Name = val
		case "Name[zh]":
			entry.NameZH = val
		case "Name[zh_CN]":
			entry.NameZHCN = val
		case "Comment":
			entry.Comment = val
		case "Comment[zh]":
			entry.CommentZH = val
		case "Comment[zh_CN]":
			entry.CommentZHCN = val
		case "GenericName":
			entry.GenericName = val
		case "GenericName[zh]":
			entry.GenericNameZH = val
		case "GenericName[zh_CN]":
			entry.GenericNameZHCN = val
		case "Exec":
			entry.Exec = val
		case "Icon":
			entry.Icon = val
		case "Terminal":
			entry.Terminal = strings.EqualFold(val, "true")
		}
	}
	return entry, foundSection
}

func (e desktopEntry) displayName(fallback string) string {
	switch {
	case e.NameZHCN != "":
		return e.NameZHCN
	case e.NameZH != "":
		return e.NameZH
	case e.Name != "":
		return e.Name
	default:
		return fallback
	}
}

func (e desktopEntry) subtitle(fallback string) string {
	switch {
	case e.CommentZHCN != "":
		return e.CommentZHCN
	case e.CommentZH != "":
		return e.CommentZH
	case e.Comment != "":
		return e.Comment
	case e.GenericNameZHCN != "":
		return e.GenericNameZHCN
	case e.GenericNameZH != "":
		return e.GenericNameZH
	case e.GenericName != "":
		return e.GenericName
	default:
		return fallback
	}
}
