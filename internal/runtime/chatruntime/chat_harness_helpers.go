package chatruntime

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	// VideoFrameDirSuffix 是视频抽帧边车目录后缀。
	VideoFrameDirSuffix = ".frames"

	// DocumentBlockFooter 是内联/注入文档块的统一结束标记。
	DocumentBlockFooter = "（附件结束）"

	// MinElidedDataURIPayloadChars 低于该长度的 base64 data URI 不做剥离。
	MinElidedDataURIPayloadChars = 256
)

var (
	dataURIRegex   = regexp.MustCompile(`data:([a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9.+=-]+)*);base64,([A-Za-z0-9+/=]+)`)
	frameFileRegex = regexp.MustCompile(`^frame-\d+\.jpg$`)

	imageExtMimeMap = map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".webp": "image/webp",
		".gif":  "image/gif",
	}

	videoExtMimeMap = map[string]string{
		".m4v":  "video/x-m4v",
		".mov":  "video/quicktime",
		".mp4":  "video/mp4",
		".webm": "video/webm",
	}
)

// VideoFrameArtifacts 描述已提取的视频元数据与关键帧文件。
type VideoFrameArtifacts struct {
	Frames      []string
	Metadata    map[string]any
	FramesReady bool
}

// VideoInputContext 描述拼接进提示词的视频信息。
type VideoInputContext struct {
	Path        string
	Frames      []string
	Metadata    map[string]any
	FramesReady bool
}

// TurnAttachmentParts 暴露消息与文档/视频分段，供大附件历史注入分流。
type TurnAttachmentParts struct {
	Content        string
	DocumentBlocks []string
	VideoBlock     string
}

// TurnAttachmentInput 描述规范化后单轮提示词与图片输入。
type TurnAttachmentInput struct {
	Prompt     string
	ImagePaths []string
	Parts      TurnAttachmentParts
}

// IsChatSession 判断会话是否处于纯对话模式（无 projectPath 即 Chat 模式）。
func IsChatSession(session *Session) bool {
	return session != nil && strings.TrimSpace(session.ProjectPath) == ""
}

// GuessImageMimeType 根据扩展名返回受支持的图片 MIME 类型，未识别返回空串。
func GuessImageMimeType(filePath string) string {
	return imageExtMimeMap[strings.ToLower(filepath.Ext(strings.TrimSpace(filePath)))]
}

// GuessVideoMimeType 根据扩展名返回受支持的视频 MIME 类型，未识别返回空串。
func GuessVideoMimeType(filePath string) string {
	return videoExtMimeMap[strings.ToLower(filepath.Ext(strings.TrimSpace(filePath)))]
}

// VideoFramesDir 返回视频文件对应的关键帧目录路径。
func VideoFramesDir(filePath string) string {
	return filePath + VideoFrameDirSuffix
}

// ReadVideoFrameArtifacts 读取已提取的视频关键帧与元数据边车。
func ReadVideoFrameArtifacts(filePath string) VideoFrameArtifacts {
	framesDir := VideoFramesDir(filePath)
	metadata := map[string]any{}
	if raw, err := os.ReadFile(filepath.Join(framesDir, "metadata.json")); err == nil {
		_ = json.Unmarshal(raw, &metadata)
	}
	ready, _ := metadata["ready"].(bool)
	rawFrames, hasFrames := metadata["frames"].([]any)
	if !ready || !hasFrames {
		return VideoFrameArtifacts{Frames: []string{}, Metadata: metadata, FramesReady: false}
	}
	entries, err := os.ReadDir(framesDir)
	if err != nil {
		return VideoFrameArtifacts{Frames: []string{}, Metadata: metadata, FramesReady: false}
	}
	available := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if frameFileRegex.MatchString(name) {
			available[name] = struct{}{}
		}
	}
	frames := make([]string, 0, len(rawFrames))
	for _, entry := range rawFrames {
		name, ok := entry.(string)
		if !ok || !frameFileRegex.MatchString(name) {
			continue
		}
		if _, exists := available[name]; exists {
			frames = append(frames, filepath.Join(framesDir, name))
		}
	}
	return VideoFrameArtifacts{
		Frames:      frames,
		Metadata:    metadata,
		FramesReady: len(frames) > 0,
	}
}

// ElideDataUris 剥离文本文档中过大的内嵌 base64 data URI 载荷并统计字符节省。
func ElideDataUris(text string, minPayloadChars int) (string, int, int) {
	if minPayloadChars < 0 {
		minPayloadChars = MinElidedDataURIPayloadChars
	}
	matches := dataURIRegex.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text, 0, 0
	}
	var sb strings.Builder
	sb.Grow(len(text))
	last := 0
	count := 0
	savedChars := 0
	for _, m := range matches {
		fullStart, fullEnd := m[0], m[1]
		mime := text[m[2]:m[3]]
		params := ""
		if m[4] >= 0 {
			params = text[m[4]:m[5]]
		}
		payloadLen := m[7] - m[6]
		if payloadLen < minPayloadChars {
			continue
		}
		count++
		placeholder := fmt.Sprintf("data:%s%s;base64,[AIH-ELIDED-%d:%dchars]", mime, params, count, payloadLen)
		savedChars += (fullEnd - fullStart) - len(placeholder)
		sb.WriteString(text[last:fullStart])
		sb.WriteString(placeholder)
		last = fullEnd
	}
	if count == 0 {
		return text, 0, 0
	}
	sb.WriteString(text[last:])
	return sb.String(), count, savedChars
}

// ElisionNotice 生成 data URI 剥离说明。
func ElisionNotice(count, savedChars int) string {
	if count <= 0 {
		return ""
	}
	return fmt.Sprintf("（本附件含 %d 处内嵌 base64 资源,合计 %d 字符,已替换为占位符以适配上下文窗口;HTML 结构、样式与文案逐字保留,仅图片/媒体的二进制载荷不可见。）", count, savedChars)
}

// FormatChatDocumentBlock 格式化单篇纯聊文档正文块。
func FormatChatDocumentBlock(name, text string) string {
	body, count, saved := ElideDataUris(text, MinElidedDataURIPayloadChars)
	nameJSON, _ := json.Marshal(name)
	parts := []string{fmt.Sprintf("附件 %s：", string(nameJSON))}
	if notice := ElisionNotice(count, saved); notice != "" {
		parts = append(parts, notice)
	}
	parts = append(parts, body, DocumentBlockFooter)
	return strings.Join(parts, "\n")
}

// TruncateChatDocumentBlock 在保留头部和结束标记的前提下截断过长的文档块。
func TruncateChatDocumentBlock(block string, allowedBodyChars int) string {
	footer := "\n" + DocumentBlockFooter
	hasFooter := strings.HasSuffix(block, footer)
	inner := block
	if hasFooter {
		inner = strings.TrimSuffix(block, footer)
	}
	header := ""
	body := inner
	if idx := strings.IndexByte(inner, '\n'); idx >= 0 {
		header = inner[:idx+1]
		body = inner[idx+1:]
	}
	bodyRunes := []rune(body)
	keep := allowedBodyChars
	if keep < 0 {
		keep = 0
	}
	if keep > len(bodyRunes) {
		keep = len(bodyRunes)
	}
	if keep >= len(bodyRunes) {
		return block
	}
	notice := fmt.Sprintf("\n（本附件超出本轮上下文预算，已装载前 %d 字符，其余 %d 字符未装载——请据此回答，不要假设你已看过全文。）",
		keep, len(bodyRunes)-keep)
	out := header + string(bodyRunes[:keep]) + notice
	if hasFooter {
		out += footer
	}
	return out
}

// AppendDocumentPathsToPrompt 在工作区模式下把文档路径附在提示词末尾。
func AppendDocumentPathsToPrompt(prompt string, paths []string) string {
	if len(paths) == 0 {
		return prompt
	}
	lines := make([]string, 0, len(paths)+3)
	if prompt != "" {
		lines = append(lines, prompt)
	}
	lines = append(lines, "Attached document files:")
	for _, filePath := range paths {
		lines = append(lines, "- "+filePath)
	}
	lines = append(lines, "Read these local document files when answering.")
	return strings.Join(lines, "\n")
}

// AppendVideoContextToPrompt 组装视频文件列表与关键帧说明到提示词末尾。
func AppendVideoContextToPrompt(prompt string, videos []VideoInputContext, toolsAvailable bool) string {
	filtered := make([]VideoInputContext, 0, len(videos))
	for _, v := range videos {
		if strings.TrimSpace(v.Path) != "" {
			filtered = append(filtered, v)
		}
	}
	if len(filtered) == 0 {
		return prompt
	}
	lines := []string{"Attached video files:"}
	allReady := true
	for _, v := range filtered {
		lines = append(lines, "- "+v.Path+formatVideoMetadata(v.Metadata))
		if !v.FramesReady {
			allReady = false
		}
	}
	if allReady {
		msg := "Key frames extracted from each video are attached as images; analyze the video content from these frames."
		if toolsAvailable {
			msg += " If you need more detail, extract additional frames or audio from the video file directly (for example with ffmpeg)."
		}
		lines = append(lines, msg)
	} else {
		if toolsAvailable {
			lines = append(lines, "No key frames were pre-extracted for some videos; read or extract frames from the video file directly (for example with ffmpeg) before analyzing.")
		} else {
			lines = append(lines, "No key frames could be pre-extracted for some videos, so their content may not be visible in this session.")
		}
	}
	block := strings.Join(lines, "\n")
	trimmed := strings.TrimSpace(prompt)
	if trimmed == "" {
		return block
	}
	return trimmed + "\n\n" + block
}

func formatVideoMetadata(meta map[string]any) string {
	if len(meta) == 0 {
		return ""
	}
	var parts []string
	if dur, ok := toFiniteNonNegFloat(meta["durationSeconds"]); ok && dur > 0 {
		parts = append(parts, fmt.Sprintf("%s%s", strconv.FormatFloat(math.Round(dur*10)/10, 'f', -1, 64), "s"))
	}
	w, wok := asPositiveSafeInt64(meta["width"])
	h, hok := asPositiveSafeInt64(meta["height"])
	if wok && hok {
		parts = append(parts, fmt.Sprintf("%dx%d", w, h))
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}

// SessionAttachmentTurnInput 将用户文本与已持久化附件路径统一整理为单轮输入。
func SessionAttachmentTurnInput(session *Session, content string, attachmentPaths []string) (TurnAttachmentInput, error) {
	chat := IsChatSession(session)
	var (
		imagePaths    []string
		documentPaths []string
		videos        []VideoInputContext
	)
	for _, rawPath := range attachmentPaths {
		filePath := strings.TrimSpace(rawPath)
		if filePath == "" {
			continue
		}
		if GuessImageMimeType(filePath) != "" {
			imagePaths = append(imagePaths, filePath)
		} else if GuessVideoMimeType(filePath) != "" {
			art := ReadVideoFrameArtifacts(filePath)
			videos = append(videos, VideoInputContext{
				Path:        filePath,
				Frames:      art.Frames,
				Metadata:    art.Metadata,
				FramesReady: art.FramesReady,
			})
		} else {
			documentPaths = append(documentPaths, filePath)
		}
	}

	documentBlocks := make([]string, 0)
	var prompt string
	if !chat {
		prompt = AppendDocumentPathsToPrompt(content, documentPaths)
	} else {
		docSections := make([]string, 0, len(documentPaths))
		for _, docPath := range documentPaths {
			raw, err := os.ReadFile(docPath)
			if err != nil {
				return TurnAttachmentInput{}, &Error{
					Code:       "chat_attachment_not_found",
					StatusCode: http.StatusNotFound,
					Message:    "找不到对话附件文件",
					Cause:      err,
				}
			}
			block := FormatChatDocumentBlock(filepath.Base(docPath), string(raw))
			documentBlocks = append(documentBlocks, block)
			docSections = append(docSections, block)
		}
		sections := make([]string, 0, 1+len(docSections))
		if trimmed := strings.TrimSpace(content); trimmed != "" {
			sections = append(sections, trimmed)
		}
		sections = append(sections, docSections...)
		prompt = strings.Join(sections, "\n\n")
	}

	videoBlock := AppendVideoContextToPrompt("", videos, !chat)
	if videoBlock != "" {
		if prompt != "" {
			prompt = prompt + "\n\n" + videoBlock
		} else {
			prompt = videoBlock
		}
	}
	allImages := make([]string, 0, len(imagePaths))
	allImages = append(allImages, imagePaths...)
	for _, v := range videos {
		allImages = append(allImages, v.Frames...)
	}
	return TurnAttachmentInput{
		Prompt:     prompt,
		ImagePaths: allImages,
		Parts: TurnAttachmentParts{
			Content:        strings.TrimSpace(content),
			DocumentBlocks: documentBlocks,
			VideoBlock:     videoBlock,
		},
	}, nil
}

func atomicWriteFile(filePath string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(filePath)
	base := filepath.Base(filePath)
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	tmpPath := filepath.Join(dir, fmt.Sprintf(".%s.%s.tmp", base, hex.EncodeToString(buf)))
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, filePath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func cleanupPersistedAttachments(paths []string) {
	seen := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		removePathBestEffort(VideoFramesDir(trimmed), true)
		removePathBestEffort(trimmed, false)
	}
}

func removePathBestEffort(targetPath string, recursive bool) {
	if strings.TrimSpace(targetPath) == "" {
		return
	}
	if recursive {
		_ = os.RemoveAll(targetPath)
	} else {
		_ = os.Remove(targetPath)
	}
}

func sortedMapKeysAny(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
