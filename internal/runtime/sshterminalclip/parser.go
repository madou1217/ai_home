package sshterminalclip

import (
	"bytes"
	"encoding/base64"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/sshbridge"
)

// TextPaste 是一段终端返回的纯文本剪贴板内容。
type TextPaste struct {
	Buffer   []byte
	MimeType string
}

// PasteRequest 是终端通知「现在可以粘贴」时给出的读取参数。
type PasteRequest struct {
	MimeType    string   `json:"mimeType"`
	MimeTypes   []string `json:"mimeTypes"`
	Loc         string   `json:"loc"`
	Pw          string   `json:"-"`
	PasswordKey string   `json:"passwordKey"`
	Name        string   `json:"name"`
}

// UnsupportedPasteNotification 是粘贴事件存在、但没有可读图片类型时的通知。
type UnsupportedPasteNotification struct {
	MimeTypes   []string `json:"mimeTypes"`
	Loc         string   `json:"loc"`
	Pw          string   `json:"-"`
	PasswordKey string   `json:"passwordKey"`
}

// PasteEventsSupport 是 5522 paste events 的支持状态。
type PasteEventsSupport struct {
	Mode      int  `json:"mode"`
	State     int  `json:"state"`
	Supported bool `json:"supported"`
	Enabled   bool `json:"enabled"`
}

// ParseOutput 是解析一段终端字节的结果。
type ParseOutput struct {
	Passthrough                   []byte
	Images                        []sshbridge.Image
	TextPastes                    []TextPaste
	PasteRequests                 []PasteRequest
	UnsupportedPasteNotifications []UnsupportedPasteNotification
	MimeLists                     [][]string
	PasteEventsSupport            *PasteEventsSupport
	Errors                        []error
	Completed                     bool
	Progress                      bool
}

type readState struct {
	chunksByMime        map[string][][]byte
	availableMimeTypes  []string
	isPasteNotification bool
	isMimeListQuery     bool
	loc                 string
	pw                  string
	passwordKey         string
	totalBytes          int
}

// Parser 从终端输出中拆出 OSC 52 / OSC 5522 响应，其余字节原样透传。
type Parser struct {
	maxBytes        int
	preferredMime   []string
	maxBufferedText int
	buffer          string
	reads           map[string]*readState
}

// NewParser 创建解析器；零值参数使用默认上限。
func NewParser(maxBytes int, mimeTypes []string) *Parser {
	if maxBytes <= 0 {
		maxBytes = sshbridge.DefaultMaxBytes
	}
	maxBuffered := defaultMaxBufferedText
	if maxBuffered < len(OSC5522Prefix)+128 {
		maxBuffered = len(OSC5522Prefix) + 128
	}
	return &Parser{
		maxBytes:        maxBytes,
		preferredMime:   normalizeMimeList(mimeTypes),
		maxBufferedText: maxBuffered,
		reads:           map[string]*readState{},
	}
}

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

func longestProtocolPrefixSuffix(text string) int {
	values := []int{
		longestPrefixSuffix(text, OSC52Prefix),
		longestPrefixSuffix(text, OSC5522Prefix),
		longestPrefixSuffix(text, pasteEventsSupportResponsePrefix),
	}
	best := 0
	for _, value := range values {
		if value > best {
			best = value
		}
	}
	return best
}

type protocolMatch struct {
	prefix   string
	protocol string
	index    int
}

func findNextProtocolStart(text string) *protocolMatch {
	candidates := []struct{ prefix, protocol string }{
		{OSC5522Prefix, "osc5522"},
		{OSC52Prefix, "osc52"},
		{pasteEventsSupportResponsePrefix, "paste_events_support"},
	}
	best := (*protocolMatch)(nil)
	for _, candidate := range candidates {
		index := strings.Index(text, candidate.prefix)
		if index < 0 {
			continue
		}
		if best == nil || index < best.index {
			best = &protocolMatch{prefix: candidate.prefix, protocol: candidate.protocol, index: index}
		}
	}
	return best
}

var pasteEventsSupportPattern = regexp.MustCompile(`^\x1b\[\?5522;([0-9]+)\$y$`)
var pasteEventsPartialPattern = regexp.MustCompile(`^\x1b\[\?5522;[0-9]*\$?y?$`)
var pasteEventsPrefixPattern = regexp.MustCompile(`^\x1b\[\?5522;([0-9]+)\$y`)

// ParsePasteEventsSupportResponse 解析模式支持响应。
func ParsePasteEventsSupportResponse(text string) *PasteEventsSupport {
	match := pasteEventsSupportPattern.FindStringSubmatch(text)
	if match == nil {
		return nil
	}
	state := 0
	for _, char := range match[1] {
		state = state*10 + int(char-'0')
	}
	return &PasteEventsSupport{Mode: 5522, State: state, Supported: state != 0 && state != 4, Enabled: state == 1 || state == 3}
}

func (p *Parser) resetOversizedBuffer() {
	if len(p.buffer) <= p.maxBufferedText {
		return
	}
	suffix := longestProtocolPrefixSuffix(p.buffer)
	if suffix > 0 {
		p.buffer = p.buffer[len(p.buffer)-suffix:]
	} else {
		p.buffer = ""
	}
}

func (p *Parser) readState(id string) *readState {
	key := sanitizeOsc5522ID(id)
	if key == "" {
		key = defaultResponseID
	}
	state := p.reads[key]
	if state == nil {
		state = &readState{chunksByMime: map[string][][]byte{}, passwordKey: "pw"}
		p.reads[key] = state
	}
	return state
}

func (p *Parser) deleteRead(id string) {
	key := sanitizeOsc5522ID(id)
	if key == "" {
		key = defaultResponseID
	}
	delete(p.reads, key)
}

func trackPasteMetadata(state *readState, metadata map[string]string) {
	if strings.ToLower(strings.TrimSpace(metadata["loc"])) == "primary" {
		state.loc = "primary"
	}
	passwordKey := "pw"
	if _, ok := metadata["password"]; ok {
		passwordKey = "password"
	}
	password := normalizeBase64(metadata["pw"])
	if password == "" {
		password = normalizeBase64(metadata["password"])
	}
	if password != "" {
		state.pw = password
		state.passwordKey = passwordKey
	}
}

func decodeBase64Payload(value string, maxBytes int) ([]byte, error) {
	encoded := normalizeBase64(value)
	if encoded == "" {
		return nil, nil
	}
	buffer, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(buffer) == 0 {
		return nil, nil
	}
	if len(buffer) > maxBytes {
		return nil, &ProtocolError{Code: "ssh_clip_terminal_clipboard_too_large"}
	}
	return buffer, nil
}

func imageFromBuffer(buffer []byte, maxBytes int, mimeType string) (*sshbridge.Image, error) {
	image, err := sshbridge.ValidateImage(buffer, mimeType, maxBytes)
	if err != nil {
		if err.Error() == "ssh_clip_image_too_large" {
			return nil, err
		}
		return nil, nil
	}
	return &image, nil
}

var dataURLPattern = regexp.MustCompile(`(?i)data:(image/(?:png|jpe?g|webp|gif|bmp|tiff?));base64,([A-Za-z0-9+/=]+)`)

func imageFromDataURLText(text string, maxBytes int) (*sshbridge.Image, error) {
	match := dataURLPattern.FindStringSubmatch(text)
	if match == nil {
		return nil, nil
	}
	buffer, err := decodeBase64Payload(match[2], maxBytes)
	if err != nil || buffer == nil {
		return nil, err
	}
	return imageFromBuffer(buffer, maxBytes, "")
}

func decodeTerminalClipboardImagePayload(payload string, maxBytes int) (*sshbridge.Image, error) {
	decoded, err := decodeBase64Payload(payload, maxBytes)
	if err != nil || decoded == nil {
		return nil, err
	}
	direct, err := imageFromBuffer(decoded, maxBytes, "")
	if err != nil || direct != nil {
		return direct, err
	}
	return imageFromDataURLText(string(decoded), maxBytes)
}

func parseOsc52Body(body string) (selection, payload string, ok bool) {
	index := strings.Index(body, ";")
	if index <= 0 {
		return "", "", false
	}
	return body[:index], body[index+1:], true
}

func parseOsc5522Body(body string) (metadata map[string]string, payload string, hasPayload bool) {
	metadata = map[string]string{}
	separator := strings.Index(body, ";")
	metadataText := body
	if separator >= 0 {
		metadataText = body[:separator]
		payload = body[separator+1:]
		hasPayload = true
	}
	for _, part := range strings.Split(metadataText, ":") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(part[:index]))
		if key != "" {
			metadata[key] = part[index+1:]
		}
	}
	return metadata, payload, hasPayload
}

func (p *Parser) appendOsc5522Data(metadata map[string]string, payload string, hasPayload bool) error {
	mimeType := decodeOsc5522Mime(metadata["mime"])
	if mimeType == "" {
		return nil
	}
	if !hasPayload {
		state := p.readState(metadata["id"])
		trackPasteMetadata(state, metadata)
		if !containsString(state.availableMimeTypes, mimeType) {
			state.availableMimeTypes = append(state.availableMimeTypes, mimeType)
		}
		state.isPasteNotification = true
		return nil
	}
	chunk, err := decodeBase64Payload(payload, p.maxBytes)
	if err != nil {
		return err
	}
	if chunk == nil {
		return nil
	}
	state := p.readState(metadata["id"])
	trackPasteMetadata(state, metadata)
	if mimeType == osc5522TargetsMime {
		for _, value := range strings.Fields(string(chunk)) {
			normalized := normalizeTerminalMimeType(value)
			if normalized != "" && !containsString(state.availableMimeTypes, normalized) {
				state.availableMimeTypes = append(state.availableMimeTypes, normalized)
			}
		}
		state.isMimeListQuery = true
		return nil
	}
	if state.totalBytes+len(chunk) > p.maxBytes {
		p.deleteRead(metadata["id"])
		return &ProtocolError{Code: "ssh_clip_terminal_clipboard_too_large"}
	}
	state.chunksByMime[mimeType] = append(state.chunksByMime[mimeType], chunk)
	state.totalBytes += len(chunk)
	return nil
}

func concatChunks(chunks [][]byte) []byte {
	return bytes.Join(chunks, nil)
}

func (p *Parser) imageFromState(state *readState) (*sshbridge.Image, error) {
	if state == nil || len(state.chunksByMime) == 0 {
		return nil, nil
	}
	mimeTypes := append([]string{}, p.preferredMime...)
	for mimeType := range state.chunksByMime {
		if !containsString(mimeTypes, mimeType) {
			mimeTypes = append(mimeTypes, mimeType)
		}
	}
	for _, mimeType := range mimeTypes {
		chunks := state.chunksByMime[mimeType]
		if len(chunks) == 0 {
			continue
		}
		image, err := imageFromBuffer(concatChunks(chunks), p.maxBytes, mimeType)
		if err != nil {
			return nil, err
		}
		if image != nil {
			return image, nil
		}
	}
	for _, mimeType := range OSC5522TextImageMimeTypes {
		chunks := state.chunksByMime[mimeType]
		if len(chunks) == 0 {
			continue
		}
		image, err := imageFromDataURLText(string(concatChunks(chunks)), p.maxBytes)
		if err != nil {
			return nil, err
		}
		if image != nil {
			return image, nil
		}
	}
	if chunks := state.chunksByMime["text/plain"]; len(chunks) > 0 {
		return imageFromDataURLText(string(concatChunks(chunks)), p.maxBytes)
	}
	return nil, nil
}

func textFromState(state *readState) *TextPaste {
	if state == nil {
		return nil
	}
	chunks := state.chunksByMime["text/plain"]
	if len(chunks) == 0 {
		return nil
	}
	buffer := concatChunks(chunks)
	if len(buffer) == 0 {
		return nil
	}
	return &TextPaste{Buffer: buffer, MimeType: "text/plain"}
}

func (p *Parser) choosePasteRequest(state *readState) *PasteRequest {
	if state == nil || !state.isPasteNotification {
		return nil
	}
	available := state.availableMimeTypes
	imageMime := ""
	for _, preferred := range p.preferredMime {
		if containsString(available, preferred) {
			imageMime = preferred
			break
		}
	}
	if imageMime == "" {
		for _, candidate := range available {
			if containsString(OSC5522ImageMimeTypes, candidate) {
				imageMime = candidate
				break
			}
		}
	}
	selected := imageMime
	if selected == "" {
		for _, candidate := range OSC5522TextImageMimeTypes {
			if containsString(available, candidate) {
				selected = candidate
				break
			}
		}
	}
	if selected == "" && containsString(available, "text/plain") {
		selected = "text/plain"
	}
	if selected == "" {
		return nil
	}
	return &PasteRequest{MimeType: selected, MimeTypes: append([]string{}, available...), Loc: state.loc, Pw: state.pw, PasswordKey: state.passwordKey, Name: "Paste event"}
}

type finishedRead struct {
	image        *sshbridge.Image
	text         *TextPaste
	pasteRequest *PasteRequest
	mimeTypes    []string
	unsupported  *UnsupportedPasteNotification
}

func (p *Parser) finishRead(metadata map[string]string) (finishedRead, error) {
	key := sanitizeOsc5522ID(metadata["id"])
	if key == "" {
		key = defaultResponseID
	}
	state := p.reads[key]
	delete(p.reads, key)
	image, err := p.imageFromState(state)
	if err != nil {
		return finishedRead{}, err
	}
	result := finishedRead{image: image}
	if image == nil {
		result.text = textFromState(state)
	}
	result.pasteRequest = p.choosePasteRequest(state)
	if state != nil && state.isMimeListQuery {
		result.mimeTypes = append([]string{}, state.availableMimeTypes...)
	}
	if state != nil && state.isPasteNotification && result.pasteRequest == nil {
		result.unsupported = &UnsupportedPasteNotification{MimeTypes: append([]string{}, state.availableMimeTypes...), Loc: state.loc, Pw: state.pw, PasswordKey: state.passwordKey}
	}
	return result, nil
}

func (p *Parser) consumeOsc52Body(body string, output *ParseOutput) error {
	output.Progress = true
	_, payload, ok := parseOsc52Body(body)
	var image *sshbridge.Image
	var err error
	if ok {
		image, err = decodeTerminalClipboardImagePayload(payload, p.maxBytes)
	}
	output.Completed = true
	if err != nil {
		output.Errors = append(output.Errors, err)
		return nil
	}
	if image != nil {
		output.Images = append(output.Images, *image)
	} else {
		output.Errors = append(output.Errors, &ProtocolError{Code: "ssh_clip_terminal_clipboard_no_image"})
	}
	return nil
}

func (p *Parser) consumeOsc5522Body(body string, output *ParseOutput) error {
	metadata, payload, hasPayload := parseOsc5522Body(body)
	if metadata["type"] != "read" {
		return nil
	}
	status := strings.ToUpper(strings.TrimSpace(metadata["status"]))
	if status == "" {
		return nil
	}
	output.Progress = true
	switch status {
	case "OK":
		state := p.readState(metadata["id"])
		trackPasteMetadata(state, metadata)
		return nil
	case "DATA":
		return p.appendOsc5522Data(metadata, payload, hasPayload)
	case "DONE":
		finished, err := p.finishRead(metadata)
		if err != nil {
			return err
		}
		if finished.image != nil {
			output.Images = append(output.Images, *finished.image)
		}
		if finished.text != nil {
			output.TextPastes = append(output.TextPastes, *finished.text)
		}
		if finished.pasteRequest != nil {
			output.PasteRequests = append(output.PasteRequests, *finished.pasteRequest)
		}
		if len(finished.mimeTypes) > 0 {
			output.MimeLists = append(output.MimeLists, finished.mimeTypes)
		}
		if finished.unsupported != nil {
			output.UnsupportedPasteNotifications = append(output.UnsupportedPasteNotifications, *finished.unsupported)
		}
		if finished.image == nil && finished.text == nil && finished.pasteRequest == nil &&
			len(finished.mimeTypes) == 0 && finished.unsupported == nil {
			output.Errors = append(output.Errors, &ProtocolError{Code: "ssh_clip_terminal_clipboard_no_image"})
		}
		output.Completed = true
		return nil
	default:
		p.deleteRead(metadata["id"])
		output.Errors = append(output.Errors, errorForOsc5522Status(status))
		output.Completed = true
		return nil
	}
}

func (p *Parser) consumePasteEventsSupportResponse(output *ParseOutput) bool {
	match := pasteEventsPrefixPattern.FindString(p.buffer)
	if match == "" {
		if pasteEventsPartialPattern.MatchString(p.buffer) {
			return false
		}
		p.buffer = p.buffer[1:]
		return true
	}
	output.PasteEventsSupport = ParsePasteEventsSupportResponse(match)
	output.Completed = true
	output.Progress = true
	p.buffer = p.buffer[len(match):]
	return true
}

// Consume 处理一段终端字节。
func (p *Parser) Consume(data []byte) ParseOutput {
	p.buffer += string(data)
	p.resetOversizedBuffer()
	output := ParseOutput{}
	var passthrough bytes.Buffer
	for p.buffer != "" {
		match := findNextProtocolStart(p.buffer)
		if match == nil {
			suffix := longestProtocolPrefixSuffix(p.buffer)
			if suffix > 0 {
				passthrough.WriteString(p.buffer[:len(p.buffer)-suffix])
				p.buffer = p.buffer[len(p.buffer)-suffix:]
			} else {
				passthrough.WriteString(p.buffer)
				p.buffer = ""
			}
			break
		}
		if match.index > 0 {
			passthrough.WriteString(p.buffer[:match.index])
			p.buffer = p.buffer[match.index:]
		}
		if match.protocol == "paste_events_support" {
			if !p.consumePasteEventsSupportResponse(&output) {
				break
			}
			continue
		}
		bodyStart := len(match.prefix)
		belIndex := strings.Index(p.buffer[bodyStart:], BELTerminator)
		if belIndex >= 0 {
			belIndex += bodyStart
		}
		stIndex := strings.Index(p.buffer[bodyStart:], StringTerminator)
		if stIndex >= 0 {
			stIndex += bodyStart
		}
		end := -1
		terminatorLength := 1
		switch {
		case belIndex >= 0 && stIndex >= 0:
			if belIndex < stIndex {
				end = belIndex
			} else {
				end = stIndex
				terminatorLength = 2
			}
		case belIndex >= 0:
			end = belIndex
		case stIndex >= 0:
			end = stIndex
			terminatorLength = 2
		}
		if end < 0 {
			break
		}
		body := p.buffer[bodyStart:end]
		p.buffer = p.buffer[end+terminatorLength:]
		var err error
		if match.protocol == "osc5522" {
			err = p.consumeOsc5522Body(body, &output)
		} else {
			err = p.consumeOsc52Body(body, &output)
		}
		if err != nil {
			output.Completed = true
			output.Errors = append(output.Errors, err)
		}
	}
	if passthrough.Len() > 0 {
		output.Passthrough = passthrough.Bytes()
	}
	return output
}
