package shellsetup

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// 受管块在 rc 文件里独占一段；其余字节必须原样保留。标记形态与历史 Node
// 实现（`# >>> aih:shell >>>` / `# <<< aih:shell <<<`）保持一致。
const joinPrefix = "# aih-shell-joined-newline: "

var linePattern = regexp.MustCompile(`[^\n]*\n|[^\n]+$`)

// ManagedBlockSpan 描述已安装受管块在 rc 文本里的位置。
type ManagedBlockSpan struct {
	Start      int
	End        int
	BodyStart  int
	BodyEnd    int
	JoinDigest string
}

func managedMarkers() (string, string) {
	label := BlockPrefix + ":" + BlockName
	return "# >>> " + label + " >>>", "# <<< " + label + " <<<"
}

// InspectManagedBlock 定位受管块；没有块返回 (nil, nil)，标记不完整/重复时报错。
func InspectManagedBlock(text string) (*ManagedBlockSpan, error) {
	startMarker, endMarker := managedMarkers()
	type found struct {
		kind  string
		start int
		end   int
	}
	var markers []found
	for _, match := range linePattern.FindAllStringIndex(text, -1) {
		trimmed := strings.TrimSpace(text[match[0]:match[1]])
		if trimmed == startMarker {
			markers = append(markers, found{kind: "start", start: match[0], end: match[1]})
		} else if trimmed == endMarker {
			markers = append(markers, found{kind: "end", start: match[0], end: match[1]})
		}
	}
	if len(markers) == 0 {
		return nil, nil
	}
	if len(markers) != 2 || markers[0].kind != "start" || markers[1].kind != "end" {
		return nil, errors.New("shell_rc_managed_block_invalid")
	}
	body := text[markers[0].end:markers[1].start]
	joinDigest := ""
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.HasPrefix(line, joinPrefix) {
			joinDigest = strings.TrimPrefix(line, joinPrefix)
			break
		}
	}
	return &ManagedBlockSpan{
		Start:      markers[0].start,
		End:        markers[1].end,
		BodyStart:  markers[0].end,
		BodyEnd:    markers[1].start,
		JoinDigest: joinDigest,
	}, nil
}

// ReadManagedBlock 返回受管块内容（不含标记）；没有块返回 ("", false)。
func ReadManagedBlock(text string) (string, bool, error) {
	span, err := InspectManagedBlock(text)
	if err != nil || span == nil {
		return "", false, err
	}
	return text[span.BodyStart:span.BodyEnd], true, nil
}

func digest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// ReplaceManagedBlock 幂等替换受管块；块位置保持原样，其余内容逐字节保留。
func ReplaceManagedBlock(text, content string) (string, error) {
	span, err := InspectManagedBlock(text)
	if err != nil {
		return "", err
	}
	startMarker, endMarker := managedMarkers()
	newline := "\n"
	if strings.Contains(text, "\r\n") {
		newline = "\r\n"
	}
	needsJoin := span == nil && text != "" && !strings.HasSuffix(text, "\n")
	joinDigest := ""
	if span != nil {
		joinDigest = span.JoinDigest
	} else if needsJoin {
		joinDigest = digest(text)
	}
	lines := []string{startMarker}
	if joinDigest != "" {
		lines = append(lines, joinPrefix+joinDigest)
	}
	normalizedContent := strings.ReplaceAll(strings.TrimSpace(content), "\r\n", "\n")
	if newline == "\r\n" {
		normalizedContent = strings.ReplaceAll(normalizedContent, "\n", "\r\n")
	}
	lines = append(lines, normalizedContent, endMarker)
	block := strings.Join(lines, newline)
	if span != nil {
		suffix := text[span.End:]
		hadNewline := strings.HasSuffix(text[span.Start:span.End], "\n")
		if hadNewline {
			return text[:span.Start] + block + newline + suffix, nil
		}
		return text[:span.Start] + block + suffix, nil
	}
	separator := ""
	if text != "" && !strings.HasSuffix(text, "\n") {
		separator = newline
	}
	return text + separator + block + newline, nil
}

// RemoveManagedBlock 摘除受管块；没有块时 removed=false。
func RemoveManagedBlock(text string) (string, bool, error) {
	span, err := InspectManagedBlock(text)
	if err != nil {
		return text, false, err
	}
	if span == nil {
		return text, false, nil
	}
	prefix := text[:span.Start]
	withoutJoin := strings.TrimSuffix(prefix, "\n")
	withoutJoin = strings.TrimSuffix(withoutJoin, "\r")
	if span.End == len(text) && span.JoinDigest != "" && digest(withoutJoin) == span.JoinDigest {
		prefix = withoutJoin
	}
	return prefix + text[span.End:], true, nil
}

// HasManagedBlock 判断 rc 文本里是否已有完整受管块。
func HasManagedBlock(text string) bool {
	span, err := InspectManagedBlock(text)
	return err == nil && span != nil
}

// Snapshot 是 rc/片段文件的原始字节快照；写入前用它检测并发修改。
type Snapshot struct {
	File     string
	Target   string
	Exists   bool
	Text     string
	Mode     os.FileMode
	Encoding string
	BOM      string
	info     os.FileInfo
}

// ReadSnapshot 跟随符号链接读取文本，并保留编码与权限信息。
func ReadSnapshot(file string) (Snapshot, error) {
	snapshot := Snapshot{File: file, Target: file, Mode: 0o600, Encoding: "utf8"}
	linkInfo, err := os.Lstat(file)
	if err != nil {
		if os.IsNotExist(err) {
			return snapshot, nil
		}
		return snapshot, err
	}
	target := file
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		resolved, evalErr := filepath.EvalSymlinks(file)
		if evalErr != nil {
			return snapshot, evalErr
		}
		target = resolved
	}
	info, err := os.Stat(target)
	if err != nil {
		return snapshot, err
	}
	if !info.Mode().IsRegular() {
		return snapshot, errors.New("shell_config_not_regular_file")
	}
	bytes, err := os.ReadFile(target)
	if err != nil {
		return snapshot, err
	}
	text, encoding, bom, err := decodeText(bytes)
	if err != nil {
		return snapshot, err
	}
	snapshot.Target = target
	snapshot.Exists = true
	snapshot.Text = text
	snapshot.Mode = info.Mode().Perm()
	snapshot.Encoding = encoding
	snapshot.BOM = bom
	snapshot.info = info
	return snapshot, nil
}

func decodeText(bytes []byte) (string, string, string, error) {
	encoding := "utf8"
	bom := ""
	switch {
	case len(bytes) >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe:
		encoding, bom = "utf16le", "fffe"
	case len(bytes) >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff:
		encoding, bom = "utf16be", "feff"
	case len(bytes) >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf:
		bom = "efbbbf"
	}
	body := bytes[len(bom)/2:]
	var text string
	if encoding == "utf8" {
		if !utf8.Valid(body) {
			return "", "", "", errors.New("shell_config_encoding_unsupported")
		}
		text = string(body)
	} else {
		if len(body)%2 != 0 {
			return "", "", "", errors.New("shell_config_encoding_unsupported")
		}
		units := make([]uint16, 0, len(body)/2)
		for index := 0; index < len(body); index += 2 {
			if encoding == "utf16be" {
				units = append(units, uint16(body[index])<<8|uint16(body[index+1]))
			} else {
				units = append(units, uint16(body[index+1])<<8|uint16(body[index]))
			}
		}
		text = string(utf16.Decode(units))
	}
	encoded, err := encodeText(text, encoding, bom)
	if err != nil || string(encoded) != string(bytes) {
		return "", "", "", errors.New("shell_config_encoding_unsupported")
	}
	return text, encoding, bom, nil
}

func encodeText(text, encoding, bom string) ([]byte, error) {
	bomBytes, _ := hex.DecodeString(bom)
	var body []byte
	if encoding == "utf8" {
		body = []byte(text)
	} else {
		units := utf16.Encode([]rune(text))
		body = make([]byte, 0, len(units)*2)
		for _, unit := range units {
			if encoding == "utf16be" {
				body = append(body, byte(unit>>8), byte(unit))
			} else {
				body = append(body, byte(unit), byte(unit>>8))
			}
		}
	}
	return append(bomBytes, body...), nil
}

func sameSnapshot(left, right Snapshot) bool {
	if left.Exists != right.Exists || left.Target != right.Target ||
		left.Text != right.Text || left.Encoding != right.Encoding || left.BOM != right.BOM ||
		left.Mode != right.Mode {
		return false
	}
	if left.Exists {
		if left.info == nil || right.info == nil || !os.SameFile(left.info, right.info) {
			return false
		}
		if !left.info.ModTime().Equal(right.info.ModTime()) {
			return false
		}
	}
	return true
}

// WriteSnapshot 以同目录临时文件 + rename 原子替换，可选生成原字节备份。
// outputEncoding/outputBOM 为空时沿用快照编码。
func WriteSnapshot(snapshot Snapshot, content, outputEncoding, outputBOM string, backup bool) (string, error) {
	current, err := ReadSnapshot(snapshot.File)
	if err != nil {
		return "", err
	}
	if !sameSnapshot(snapshot, current) {
		return "", errors.New("shell_config_changed_retry")
	}
	directory := filepath.Dir(snapshot.Target)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	nonce := fmt.Sprintf("%d-%s", os.Getpid(), randomHex(8))
	temporary := filepath.Join(directory, "."+filepath.Base(snapshot.Target)+".aih-tmp-"+nonce)
	encoding := outputEncoding
	if encoding == "" {
		encoding = snapshot.Encoding
	}
	bom := snapshot.BOM
	if outputBOM != "" || outputEncoding != "" {
		bom = outputBOM
	}
	payload, err := encodeText(content, encoding, bom)
	if err != nil {
		return "", err
	}
	handle, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	created := true
	defer func() {
		if handle != nil {
			_ = handle.Close()
		}
		if created {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := handle.Write(payload); err != nil {
		return "", err
	}
	if err := handle.Chmod(snapshot.Mode); err != nil {
		return "", err
	}
	if err := handle.Sync(); err != nil {
		return "", err
	}
	if err := handle.Close(); err != nil {
		return "", err
	}
	handle = nil
	backupPath := ""
	if backup && snapshot.Exists {
		backupPath = fmt.Sprintf("%s.aih-backup-%d-%s", snapshot.Target, time.Now().UnixMilli(), nonce)
		prior, err := encodeText(snapshot.Text, snapshot.Encoding, snapshot.BOM)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(backupPath, prior, snapshot.Mode); err != nil {
			return "", err
		}
	}
	latest, err := ReadSnapshot(snapshot.File)
	if err != nil {
		return "", err
	}
	if !sameSnapshot(snapshot, latest) {
		return "", errors.New("shell_config_changed_retry")
	}
	if err := os.Rename(temporary, snapshot.Target); err != nil {
		return "", err
	}
	created = false
	return backupPath, nil
}

func randomHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}
