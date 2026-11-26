// Package termtext keeps AIH terminal output readable on every terminal,
// including consoles without a CJK font. UTF-8 capable terminals receive the
// original text; terminals that cannot render CJK automatically receive a
// lossless-enough ASCII fallback (pinyin for Han, ASCII punctuation, explicit
// U+XXXX for other symbols) instead of mojibake or empty boxes.
package termtext

import (
	"context"
	_ "embed"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/term"
)

//go:embed pinyin.tsv
var pinyinData string

var (
	once       sync.Once
	pinyin     map[rune]string
	asciiMode  bool
	modeKnown  bool
	modeMu     sync.Mutex
	cjkOnce    sync.Once
	cjkPresent bool
)

// Mode values accepted by AIH_TERM_ENCODING.
const (
	envOverride = "AIH_TERM_ENCODING"
)

// Active reports whether the ASCII fallback is active for terminal output.
func Active() bool {
	ensureMode(os.Stdout)
	modeMu.Lock()
	defer modeMu.Unlock()
	return asciiMode
}

// WrapWriter returns a writer that transliterates non-ASCII text when the
// terminal cannot render it. Non-TTY writers (files, pipes, tests) are
// returned unchanged so machine-readable output stays exact UTF-8.
func WrapWriter(writer io.Writer) io.Writer {
	if writer == nil {
		return nil
	}
	if !shouldFallback(writer) {
		return writer
	}
	return &asciiWriter{target: writer}
}

func shouldFallback(writer io.Writer) bool {
	if override := strings.ToLower(strings.TrimSpace(os.Getenv(envOverride))); override != "" {
		switch override {
		case "ascii", "fallback":
			return true
		case "utf8", "utf-8":
			return false
		}
	}
	file, ok := writer.(*os.File)
	if !ok || !term.IsTerminal(int(file.Fd())) {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return true
	}
	if runtime.GOOS == "linux" && isLinuxVirtualConsole(file.Fd()) {
		// A kernel VT draws with the loaded bitmap console font; installed
		// desktop fonts are irrelevant there, so CJK would render as boxes.
		return true
	}
	if runtime.GOOS == "windows" {
		return !windowsHasCJKFont()
	}
	if runtime.GOOS == "darwin" {
		return false
	}
	// SSH clients render with the local font: keep UTF-8 even when the server
	// itself has no CJK fonts.
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_CLIENT") != "" {
		return !localeIsUTF8()
	}
	if !localeIsUTF8() {
		return true
	}
	return !unixHasCJKFont()
}

// isLinuxVirtualConsole reports whether fd points at /dev/ttyN or /dev/console,
// where the kernel console font (not fontconfig) decides which glyphs appear.
func isLinuxVirtualConsole(fd uintptr) bool {
	link, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(fd)))
	if err != nil {
		return false
	}
	base := filepath.Base(link)
	if base == "console" {
		return true
	}
	if !strings.HasPrefix(base, "tty") {
		return false
	}
	digits := base[3:]
	if digits == "" {
		return false
	}
	for i := 0; i < len(digits); i++ {
		if digits[i] < '0' || digits[i] > '9' {
			return false
		}
	}
	return true
}

func localeIsUTF8() bool {
	for _, name := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		value := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
		if value == "" || value == "c" || value == "posix" {
			continue
		}
		return strings.Contains(value, "utf-8") || strings.Contains(value, "utf8")
	}
	// No locale at all is the common "C" default; treat as non-UTF-8 only on a
	// local TTY (SSH clients still render UTF-8).
	return false
}

func unixHasCJKFont() bool {
	cjkOnce.Do(func() { cjkPresent = probeUnixCJKFont() })
	return cjkPresent
}

func probeUnixCJKFont() bool {
	// fontconfig is the cheapest reliable probe when present.
	if path, err := findExecutable("fc-list"); err == nil && path != "" {
		if err := runQuick(path, ":lang=zh", "family"); err == nil {
			return true
		}
	}
	for _, pattern := range []string{
		"/usr/share/fonts/**/*NotoSansCJK*",
		"/usr/share/fonts/**/*NotoSerifCJK*",
		"/usr/share/fonts/**/*wqy*",
		"/usr/share/fonts/**/*WenQuanYi*",
		"/usr/share/fonts/**/*DroidSansFallback*",
		"/usr/share/fonts/**/*SourceHanSans*",
	} {
		if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
			return true
		}
	}
	return false
}

func windowsHasCJKFont() bool {
	root := os.Getenv("WINDIR")
	if root == "" {
		root = `C:\Windows`
	}
	fontDir := filepath.Join(root, "Fonts")
	for _, name := range []string{
		"msyh.ttc", "msyhbd.ttc", "msyhl.ttc", "simhei.ttf", "simsun.ttc",
		"msjh.ttc", "msjhbd.ttc", "mingliu.ttc", "YuGothM.ttc", "meiryo.ttc",
	} {
		if info, err := os.Stat(filepath.Join(fontDir, name)); err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}

type asciiWriter struct {
	target  io.Writer
	pending []byte
	mu      sync.Mutex
}

func (w *asciiWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	buffer := append(w.pending, p...)
	complete := len(buffer)
	// Keep an incomplete trailing UTF-8 sequence for the next Write.
	for back := 1; back <= utf8.UTFMax && back <= len(buffer); back++ {
		if utf8.RuneStart(buffer[len(buffer)-back]) {
			if !utf8.FullRune(buffer[len(buffer)-back:]) {
				complete = len(buffer) - back
			}
			break
		}
	}
	w.pending = append(w.pending[:0], buffer[complete:]...)
	converted := ASCII(string(buffer[:complete]))
	if _, err := w.target.Write([]byte(converted)); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Fd lets terminal capability checks keep working through the wrapper.
func (w *asciiWriter) Fd() uintptr {
	if file, ok := w.target.(interface{ Fd() uintptr }); ok {
		return file.Fd()
	}
	return ^uintptr(0)
}

// ASCII converts UTF-8 text to a readable ASCII representation. Han characters
// become tone-less pinyin, CJK punctuation becomes ASCII punctuation, box
// drawing becomes -|+, and other non-ASCII symbols become explicit U+XXXX so
// nothing is silently dropped.
func ASCII(value string) string {
	if isASCII(value) {
		return value
	}
	ensureTable()
	out := make([]byte, 0, len(value)+len(value)/4)
	appendToken := func(token string, punctuation bool) {
		if punctuation {
			out = trimTrailingSpaces(out)
		}
		out = append(out, token...)
	}
	for _, r := range value {
		switch {
		case r < utf8.RuneSelf:
			switch {
			case r == '\n' || r == '\t':
				out = trimTrailingSpaces(out)
			case r == ' ':
				if len(out) > 0 && out[len(out)-1] == ' ' {
					continue
				}
			case isASCIITrimBefore(byte(r)):
				out = trimTrailingSpaces(out)
			}
			out = append(out, byte(r))
		case r == '\u00a0':
			if len(out) == 0 || out[len(out)-1] != ' ' {
				out = append(out, ' ')
			}
		case r >= 0x2500 && r <= 0x257f:
			appendToken(string([]byte{boxDrawingASCII(r)}), true)
		case r >= 0x2580 && r <= 0x259f:
			appendToken("#", false)
		case r >= 0x2800 && r <= 0x28ff:
			// Braille spinners keep animating without dumping U+28xx escapes.
			appendToken("*", false)
		case r >= 0xff01 && r <= 0xff5e:
			mapped := r - 0xfee0
			appendToken(string(mapped), isASCIITrimBefore(byte(mapped)))
		default:
			if replacement, ok := punctuationASCII[r]; ok {
				if r == '—' || r == '–' || r == '−' {
					out = trimTrailingSpaces(out)
					if len(out) > 0 {
						out = append(out, ' ')
					}
					out = append(out, '-')
					out = append(out, ' ')
					continue
				}
				appendToken(replacement, punctuationTrimBefore(r))
				continue
			}
			if syllable, ok := pinyin[r]; ok {
				if len(out) > 0 && out[len(out)-1] != ' ' && out[len(out)-1] != '\n' {
					out = append(out, ' ')
				}
				out = append(out, syllable...)
				out = append(out, ' ')
				continue
			}
			if ascii, ok := stripLatinDiacritic(r); ok {
				out = append(out, ascii...)
				continue
			}
			if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Cf, r) {
				continue
			}
			appendToken(unicodeEscape(r), false)
		}
	}
	return strings.TrimRight(string(out), " ")
}

func punctuationTrimBefore(r rune) bool {
	switch r {
	case '，', '。', '、', '；', '：', '？', '！', '）', '】', '》', '〉', '」', '』', '”', '’', '…', '·', '•':
		return true
	default:
		return false
	}
}

func trimTrailingSpaces(value []byte) []byte {
	for len(value) > 0 && value[len(value)-1] == ' ' {
		value = value[:len(value)-1]
	}
	return value
}

func isASCIITrimBefore(ch byte) bool {
	switch ch {
	case ',', '.', ';', ':', '?', '!', ')', ']', '}', '%':
		return true
	default:
		return false
	}
}

func stripLatinDiacritic(r rune) (string, bool) {
	replacement, ok := latinDiacriticASCII[r]
	return replacement, ok
}

func isASCII(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func boxDrawingASCII(r rune) byte {
	switch r {
	case 0x2500, 0x2501, 0x2550:
		return '-'
	case 0x2502, 0x2503, 0x2551:
		return '|'
	default:
		return '+'
	}
}

func unicodeEscape(r rune) string {
	const hex = "0123456789ABCDEF"
	if r <= 0xffff {
		out := []byte{'[', 'U', '+', '0', '0', '0', '0', ']'}
		for i := 6; i >= 3; i-- {
			out[i] = hex[r&0xf]
			r >>= 4
		}
		return string(out)
	}
	out := make([]byte, 0, 10)
	out = append(out, "[U+"...)
	var digits [6]byte
	index := len(digits)
	for r > 0 {
		index--
		digits[index] = hex[r&0xf]
		r >>= 4
	}
	out = append(out, digits[index:]...)
	out = append(out, ']')
	return string(out)
}

// latinDiacriticASCII folds common accented Latin letters onto plain ASCII so
// European text stays readable without a special font.
var latinDiacriticASCII = map[rune]string{
	'À': "A", 'Á': "A", 'Â': "A", 'Ã': "A", 'Ä': "A", 'Å': "A", 'Æ': "AE",
	'Ç': "C", 'È': "E", 'É': "E", 'Ê': "E", 'Ë': "E", 'Ì': "I", 'Í': "I",
	'Î': "I", 'Ï': "I", 'Ð': "D", 'Ñ': "N", 'Ò': "O", 'Ó': "O", 'Ô': "O",
	'Õ': "O", 'Ö': "O", 'Ø': "O", 'Ù': "U", 'Ú': "U", 'Û': "U", 'Ü': "U",
	'Ý': "Y", 'Þ': "TH", 'ß': "ss", 'à': "a", 'á': "a", 'â': "a", 'ã': "a",
	'ä': "a", 'å': "a", 'æ': "ae", 'ç': "c", 'è': "e", 'é': "e", 'ê': "e",
	'ë': "e", 'ì': "i", 'í': "i", 'î': "i", 'ï': "i", 'ð': "d", 'ñ': "n",
	'ò': "o", 'ó': "o", 'ô': "o", 'õ': "o", 'ö': "o", 'ø': "o", 'ù': "u",
	'ú': "u", 'û': "u", 'ü': "u", 'ý': "y", 'þ': "th", 'ÿ': "y",
	'Ā': "A", 'ā': "a", 'Ă': "A", 'ă': "a", 'Ą': "A", 'ą': "a", 'Ć': "C",
	'ć': "c", 'Č': "C", 'č': "c", 'Ď': "D", 'ď': "d", 'Đ': "D", 'đ': "d",
	'Ē': "E", 'ē': "e", 'Ė': "E", 'ė': "e", 'Ę': "E", 'ę': "e", 'Ě': "E",
	'ě': "e", 'Ğ': "G", 'ğ': "g", 'Ī': "I", 'ī': "i", 'Į': "I", 'į': "i",
	'İ': "I", 'ı': "i", 'Ł': "L", 'ł': "l", 'Ń': "N", 'ń': "n", 'Ņ': "N",
	'ņ': "n", 'Ň': "N", 'ň': "n", 'Ō': "O", 'ō': "o", 'Ő': "O", 'ő': "o",
	'Œ': "OE", 'œ': "oe", 'Ř': "R", 'ř': "r", 'Ś': "S", 'ś': "s", 'Ş': "S",
	'ş': "s", 'Š': "S", 'š': "s", 'Ţ': "T", 'ţ': "t", 'Ť': "T", 'ť': "t",
	'Ū': "U", 'ū': "u", 'Ů': "U", 'ů': "u", 'Ű': "U", 'ű': "u", 'Ų': "U",
	'ų': "u", 'Ź': "Z", 'ź': "z", 'Ż': "Z", 'ż': "z", 'Ž': "Z", 'ž': "z",
}

var punctuationASCII = map[rune]string{
	'，': ",", '。': ".", '、': ",", '；': ";", '：': ":",
	'？': "?", '！': "!", '（': "(", '）': ")", '【': "[", '】': "]",
	'《': "<", '》': ">", '〈': "<", '〉': ">", '「': "\"", '」': "\"",
	'『': "\"", '』': "\"", '“': "\"", '”': "\"", '‘': "'", '’': "'",
	'—': "-", '–': "-", '−': "-", '…': "...", '·': ".", '•': "*",
	'　': " ", '→': "->", '←': "<-", '↑': "^", '↓': "v",
	'✓': "[ok]", '✔': "[ok]", '✗': "[x]", '✘': "[x]", '⚠': "!",
	'℃': "C", '°': "deg", '×': "x", '÷': "/", '±': "+/-",
	'©': "(c)", '®': "(r)", '™': "(tm)", '€': "EUR", '£': "GBP", '¥': "CNY",
	'½': "1/2", '¼': "1/4", '¾': "3/4",
	'●': "*", '○': "o", '◆': "*", '◇': "o", '■': "#", '□': "#",
	'▪': "*", '▫': "o", '★': "*", '☆': "*", '▶': ">", '◀': "<",
	'▲': "^", '▼': "v", '≤': "<=", '≥': ">=", '≠': "!=", '≈': "~",
	'⌘': "Cmd", '⌥': "Opt", '⇧': "Shift", '↵': "Enter", '⌫': "Backspace",
	'⎋': "Esc", '§': "S", '📦': "[pkg]", '📱': "[mobile]", '✅': "[ok]",
}

func ensureMode(writer io.Writer) {
	modeMu.Lock()
	defer modeMu.Unlock()
	if modeKnown {
		return
	}
	asciiMode = shouldFallback(writer)
	modeKnown = true
}

func ensureTable() {
	once.Do(func() {
		pinyin = make(map[rune]string, 27000)
		for _, line := range strings.Split(pinyinData, "\n") {
			tab := strings.IndexByte(line, '\t')
			if tab <= 0 {
				continue
			}
			var code uint32
			for _, ch := range line[:tab] {
				code <<= 4
				switch {
				case ch >= '0' && ch <= '9':
					code |= uint32(ch - '0')
				case ch >= 'a' && ch <= 'f':
					code |= uint32(ch-'a') + 10
				case ch >= 'A' && ch <= 'F':
					code |= uint32(ch-'A') + 10
				}
			}
			if code == 0 {
				continue
			}
			pinyin[rune(code)] = strings.TrimSpace(line[tab+1:])
		}
	})
}

var errNoCJKFont = errors.New("no cjk font")

func findExecutable(name string) (string, error) { return exec.LookPath(name) }

func runQuick(path string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	command := exec.CommandContext(ctx, path, args...)
	out, err := command.Output()
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(out))) == 0 {
		return errNoCJKFont
	}
	return nil
}
