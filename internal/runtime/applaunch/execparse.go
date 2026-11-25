package applaunch

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"strings"
)

// parseDesktopExec tokenizes a Freedesktop Exec= command line and strips field codes (%f, %F, %u, %U, etc.).
func parseDesktopExec(execLine string) []string {
	rawTokens := splitDesktopCommand(execLine)
	args := make([]string, 0, len(rawTokens))
	for _, tok := range rawTokens {
		cleaned, hadFieldCode := stripDesktopFieldCodes(tok)
		if cleaned == "" && hadFieldCode {
			continue
		}
		if cleaned != "" {
			args = append(args, cleaned)
		}
	}
	return args
}

func splitDesktopCommand(line string) []string {
	var tokens []string
	var cur strings.Builder
	inToken := false
	inDouble := false
	inSingle := false
	escaped := false

	flush := func() {
		if inToken {
			tokens = append(tokens, cur.String())
			cur.Reset()
			inToken = false
		}
	}

	for i := 0; i < len(line); i++ {
		ch := line[i]
		if escaped {
			cur.WriteByte(ch)
			inToken = true
			escaped = false
			continue
		}
		if inSingle {
			if ch == '\'' {
				inSingle = false
			} else {
				cur.WriteByte(ch)
			}
			inToken = true
			continue
		}
		if inDouble {
			if ch == '\\' && i+1 < len(line) {
				next := line[i+1]
				if next == '"' || next == '\\' || next == '$' || next == '`' {
					escaped = true
					continue
				}
			}
			if ch == '"' {
				inDouble = false
			} else {
				cur.WriteByte(ch)
			}
			inToken = true
			continue
		}
		switch ch {
		case '\\':
			escaped = true
			inToken = true
		case '"':
			inDouble = true
			inToken = true
		case '\'':
			inSingle = true
			inToken = true
		case ' ', '\t', '\r', '\n':
			flush()
		default:
			cur.WriteByte(ch)
			inToken = true
		}
	}
	flush()
	return tokens
}

func stripDesktopFieldCodes(token string) (string, bool) {
	if !strings.ContainsRune(token, '%') {
		return token, false
	}
	var out strings.Builder
	out.Grow(len(token))
	hadFieldCode := false
	for i := 0; i < len(token); i++ {
		if token[i] == '%' && i+1 < len(token) {
			next := token[i+1]
			if next == '%' {
				out.WriteByte('%')
				i++
				continue
			}
			switch next {
			case 'f', 'F', 'u', 'U', 'd', 'D', 'n', 'N', 'i', 'c', 'k', 'v', 'm':
				hadFieldCode = true
				i++
				continue
			}
		}
		out.WriteByte(token[i])
	}
	return out.String(), hadFieldCode
}

// readDesktopExecField reads Exec= from the [Desktop Entry] section of a .desktop file.
func readDesktopExecField(desktopPath string) string {
	f, err := os.Open(desktopPath)
	if err != nil {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(f, 256*1024))
	_ = f.Close()
	if err != nil {
		return ""
	}
	inSection := false
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
				continue
			}
			if inSection {
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
		if strings.TrimSpace(line[:eq]) == "Exec" {
			return strings.TrimSpace(line[eq+1:])
		}
	}
	return ""
}
