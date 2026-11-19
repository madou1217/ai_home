package sshbridge

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// OSCPrefix 是图像帧的 OSC 前缀。
	OSCPrefix = "\x1b]5379;aih-clip;"
	// BEL 是帧终止符。
	BEL = "\x07"

	// DefaultChunkSize 是每个 tty 帧的 Base64 字符数。
	DefaultChunkSize = 3072
	// DefaultMaxBytes 是原始图片字节上限。
	DefaultMaxBytes = 16 * 1024 * 1024
	// DefaultMaxChunks 是单次传输的最大帧数。
	DefaultMaxChunks = 8192
	// DefaultMaxBufferedText 是解析器允许缓冲的未完成帧文本上限。
	DefaultMaxBufferedText = 24 * 1024 * 1024
	// DefaultPendingTTL 是未完成传输的保留时间。
	DefaultPendingTTL = 10 * time.Second
)

// EncodedFrames 是一次编码结果。
type EncodedFrames struct {
	ID       string
	Action   string
	MimeType string
	SHA256   string
	Bytes    int
	Frames   []string
}

func normalizeAction(value string) string {
	action := strings.ToLower(strings.TrimSpace(value))
	if action == "cache" || action == "paste" {
		return action
	}
	return "paste"
}

// encodeURIComponent 与浏览器 encodeURIComponent 的保留集合一致。
func encodeURIComponent(value string) string {
	const hexDigits = "0123456789ABCDEF"
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		char := value[index]
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') ||
			char == '-' || char == '_' || char == '.' || char == '!' || char == '~' || char == '*' || char == '\'' || char == '(' || char == ')' {
			builder.WriteByte(char)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(hexDigits[char>>4])
		builder.WriteByte(hexDigits[char&0x0f])
	}
	return builder.String()
}

func randomUUID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}

func buildFrameText(fields [][2]string) string {
	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		if field[1] == "" {
			continue
		}
		parts = append(parts, field[0]+"="+encodeURIComponent(field[1]))
	}
	return OSCPrefix + strings.Join(parts, ";") + BEL
}

// EncodeClipboardImageFrames 把图片编码为 OSC 5379 帧序列。
func EncodeClipboardImageFrames(image Image, action string, maxBytes, chunkSize int) (EncodedFrames, error) {
	info, err := ValidateImage(image.Buffer, image.MimeType, maxBytes)
	if err != nil {
		return EncodedFrames{}, err
	}
	if chunkSize <= 0 {
		chunkSize = DefaultChunkSize
	}
	if chunkSize < 512 {
		chunkSize = 512
	}
	base64Text := base64.StdEncoding.EncodeToString(image.Buffer)
	total := (len(base64Text) + chunkSize - 1) / chunkSize
	if total < 1 {
		total = 1
	}
	id := sanitizeFrameID(image.ID)
	if id == "" {
		id = sanitizeFrameID(randomUUID())
	}
	resolvedAction := normalizeAction(action)
	frames := make([]string, 0, total)
	for index := 0; index < total; index++ {
		start := index * chunkSize
		end := start + chunkSize
		if end > len(base64Text) {
			end = len(base64Text)
		}
		frames = append(frames, buildFrameText([][2]string{
			{"v", "1"},
			{"id", id},
			{"action", resolvedAction},
			{"seq", strconv.Itoa(index + 1)},
			{"total", strconv.Itoa(total)},
			{"mime", info.MimeType},
			{"bytes", strconv.Itoa(len(image.Buffer))},
			{"sha256", info.SHA256},
			{"data", base64Text[start:end]},
		}))
	}
	return EncodedFrames{ID: id, Action: resolvedAction, MimeType: info.MimeType, SHA256: info.SHA256, Bytes: len(image.Buffer), Frames: frames}, nil
}

func sanitizeFrameID(value string) string {
	var builder strings.Builder
	for _, char := range strings.TrimSpace(value) {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') ||
			char == '.' || char == '_' || char == '-' {
			builder.WriteRune(char)
			if builder.Len() >= 96 {
				break
			}
		}
	}
	return builder.String()
}

// ParsedImage 是解析完成的一帧图片。
type ParsedImage struct {
	ID       string
	Action   string
	Buffer   []byte
	MimeType string
	SHA256   string
	Bytes    int
}

// ConsumeResult 是解析器处理一段终端字节的结果。
type ConsumeResult struct {
	Passthrough []byte
	Images      []ParsedImage
	Errors      []error
}

type pendingTransfer struct {
	id        string
	action    string
	total     int
	bytes     int
	sha256    string
	mimeType  string
	chunks    map[int]string
	updatedAt time.Time
}

// FrameParser 从远端 tty 输出中拆出图像帧，其余字节原样透传。
type FrameParser struct {
	maxBytes    int
	maxChunks   int
	maxBuffered int
	pendingTTL  time.Duration
	buffer      string
	pending     map[string]*pendingTransfer
}

// NewFrameParser 创建解析器；零值参数使用默认上限。
func NewFrameParser(maxBytes, maxChunks, maxBuffered int, pendingTTL time.Duration) *FrameParser {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if maxChunks <= 0 {
		maxChunks = DefaultMaxChunks
	}
	if maxBuffered <= 0 {
		maxBuffered = DefaultMaxBufferedText
	}
	if pendingTTL <= 0 {
		pendingTTL = DefaultPendingTTL
	}
	return &FrameParser{maxBytes: maxBytes, maxChunks: maxChunks, maxBuffered: maxBuffered, pendingTTL: pendingTTL, pending: map[string]*pendingTransfer{}}
}

// PendingCount 返回未完成传输数。
func (p *FrameParser) PendingCount() int { return len(p.pending) }

func longestPrefixSuffix(text, prefix string) int {
	max := len(text)
	if len(prefix)-1 < max {
		max = len(prefix) - 1
	}
	for size := max; size > 0; size-- {
		if strings.HasPrefix(prefix, text[len(text)-size:]) {
			return size
		}
	}
	return 0
}

func parseFrameBody(body string) map[string]string {
	fields := map[string]string{}
	for _, part := range strings.Split(body, ";") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		key := strings.TrimSpace(part[:index])
		if key == "" {
			continue
		}
		decoded, err := url.PathUnescape(part[index+1:])
		if err != nil {
			decoded = ""
		}
		fields[key] = decoded
	}
	return fields
}

func parsePositiveInteger(value string) int {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || number <= 0 {
		return 0
	}
	return number
}

func normalizeChunkData(value string) string {
	data := strings.TrimSpace(value)
	for index := 0; index < len(data); index++ {
		char := data[index]
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') ||
			char == '+' || char == '/' || char == '=' {
			continue
		}
		return ""
	}
	return data
}

func (p *FrameParser) pruneExpired() {
	cutoff := time.Now().Add(-p.pendingTTL)
	for id, item := range p.pending {
		if item.updatedAt.Before(cutoff) {
			delete(p.pending, id)
		}
	}
}

func (p *FrameParser) resetOversizedBuffer() {
	if len(p.buffer) <= p.maxBuffered {
		return
	}
	suffix := longestPrefixSuffix(p.buffer, OSCPrefix)
	if suffix > 0 {
		p.buffer = p.buffer[len(p.buffer)-suffix:]
	} else {
		p.buffer = ""
	}
}

func (p *FrameParser) acceptFrame(fields map[string]string) (*ParsedImage, error) {
	if fields["v"] != "1" {
		return nil, nil
	}
	id := sanitizeFrameID(fields["id"])
	if id == "" {
		return nil, nil
	}
	seq := parsePositiveInteger(fields["seq"])
	total := parsePositiveInteger(fields["total"])
	bytesCount := parsePositiveInteger(fields["bytes"])
	sha := strings.ToLower(strings.TrimSpace(fields["sha256"]))
	mimeType := NormalizeMimeType(fields["mime"])
	data := normalizeChunkData(fields["data"])
	if seq == 0 || total == 0 || seq > total || total > p.maxChunks || bytesCount == 0 || bytesCount > p.maxBytes {
		return nil, nil
	}
	validSHA := len(sha) == 64
	for _, char := range sha {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			validSHA = false
			break
		}
	}
	if !validSHA || mimeType == "" || data == "" {
		return nil, nil
	}
	item := p.pending[id]
	if item == nil {
		item = &pendingTransfer{id: id, action: normalizeAction(fields["action"]), total: total, bytes: bytesCount, sha256: sha, mimeType: mimeType, chunks: map[int]string{}, updatedAt: time.Now()}
		p.pending[id] = item
	}
	if item.total != total || item.bytes != bytesCount || item.sha256 != sha || item.mimeType != mimeType {
		delete(p.pending, id)
		return nil, nil
	}
	item.updatedAt = time.Now()
	item.chunks[seq] = data
	if len(item.chunks) != item.total {
		return nil, nil
	}
	var builder strings.Builder
	for index := 1; index <= item.total; index++ {
		chunk, ok := item.chunks[index]
		if !ok {
			return nil, nil
		}
		builder.WriteString(chunk)
	}
	delete(p.pending, id)
	raw, err := base64.StdEncoding.DecodeString(builder.String())
	if err != nil {
		return nil, nil
	}
	if len(raw) != item.bytes || hashHex(raw) != item.sha256 {
		return nil, fmt.Errorf("ssh_clip_frame_checksum_mismatch")
	}
	info, err := ValidateImage(raw, item.mimeType, p.maxBytes)
	if err != nil {
		return nil, err
	}
	return &ParsedImage{ID: item.id, Action: item.action, Buffer: raw, MimeType: info.MimeType, SHA256: info.SHA256, Bytes: info.Bytes}, nil
}

func hashHex(buffer []byte) string {
	sum := sha256.Sum256(buffer)
	return hex.EncodeToString(sum[:])
}

// Consume 处理一段 tty 字节。
func (p *FrameParser) Consume(data []byte) ConsumeResult {
	p.pruneExpired()
	p.buffer += string(data)
	p.resetOversizedBuffer()
	result := ConsumeResult{}
	var passthrough bytes.Buffer
	for len(p.buffer) > 0 {
		start := strings.Index(p.buffer, OSCPrefix)
		if start < 0 {
			suffix := longestPrefixSuffix(p.buffer, OSCPrefix)
			if suffix > 0 {
				passthrough.WriteString(p.buffer[:len(p.buffer)-suffix])
				p.buffer = p.buffer[len(p.buffer)-suffix:]
			} else {
				passthrough.WriteString(p.buffer)
				p.buffer = ""
			}
			break
		}
		if start > 0 {
			passthrough.WriteString(p.buffer[:start])
			p.buffer = p.buffer[start:]
		}
		bodyStart := len(OSCPrefix)
		belIndex := strings.Index(p.buffer[bodyStart:], BEL)
		if belIndex >= 0 {
			belIndex += bodyStart
		}
		stIndex := strings.Index(p.buffer[bodyStart:], "\x1b\\")
		if stIndex >= 0 {
			stIndex += bodyStart
		}
		end := -1
		terminatorLength := 1
		if belIndex >= 0 && stIndex >= 0 {
			if belIndex < stIndex {
				end = belIndex
				terminatorLength = 1
			} else {
				end = stIndex
				terminatorLength = 2
			}
		} else if belIndex >= 0 {
			end = belIndex
		} else if stIndex >= 0 {
			end = stIndex
			terminatorLength = 2
		}
		if end < 0 {
			break
		}
		body := p.buffer[bodyStart:end]
		p.buffer = p.buffer[end+terminatorLength:]
		image, err := p.acceptFrame(parseFrameBody(body))
		if err != nil {
			result.Errors = append(result.Errors, err)
		} else if image != nil {
			result.Images = append(result.Images, *image)
		}
	}
	if passthrough.Len() > 0 {
		result.Passthrough = passthrough.Bytes()
	}
	return result
}
