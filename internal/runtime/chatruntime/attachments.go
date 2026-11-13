package chatruntime

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

const (
	// MaxAttachmentFiles 单次上传及单轮最大附件数量（对齐 chat-attachments.json）。
	MaxAttachmentFiles = 8
	// MaxImageBytes 单个图片附件字节上限（10 MiB）。
	MaxImageBytes = 10 * 1024 * 1024
	// MaxDocumentBytes 单个文本/文档附件字节上限（16 MiB）。
	MaxDocumentBytes = 16 * 1024 * 1024
	// MaxVideoBytes 单个视频附件字节上限（100 MiB）。
	MaxVideoBytes = 100 * 1024 * 1024
	// MaxTotalAttachmentBytes 单批上传附件解码后总字节上限（128 MiB）。
	MaxTotalAttachmentBytes = 128 * 1024 * 1024
	// MaxAttachmentHTTPBodyBytes HTTP 上传附件 JSON 请求体上限（192 MiB）。
	MaxAttachmentHTTPBodyBytes = 192 * 1024 * 1024

	attachmentKindImage    = "image"
	attachmentKindDocument = "document"
	attachmentKindVideo    = "video"

	maxVideoFrames   = 8
	frameEdgeLimit   = 768
	videoToolTimeout = 30 * time.Second
)

var (
	dataURLHeaderRegex = regexp.MustCompile(`(?i)^data:([^;,]+);base64$`)
	base64ShapeRegex   = regexp.MustCompile(`^[A-Za-z0-9+/]*={0,2}$`)
	binaryControlRegex = regexp.MustCompile(`[\x00-\x08\x0e-\x1f]`)

	supportedImageMIME = map[string]bool{
		"image/png":  true,
		"image/jpeg": true,
		"image/jpg":  true,
		"image/webp": true,
		"image/gif":  true,
	}

	supportedVideoMIME = map[string]bool{
		"video/mp4":       true,
		"video/x-m4v":     true,
		"video/quicktime": true,
		"video/webm":      true,
	}

	supportedTextExtensions = map[string]bool{
		"md": true, "markdown": true, "mdx": true, "txt": true, "text": true,
		"log": true, "csv": true, "tsv": true, "json": true, "jsonl": true,
		"yaml": true, "yml": true, "toml": true, "xml": true, "html": true,
		"htm": true, "css": true, "scss": true, "less": true, "js": true,
		"jsx": true, "ts": true, "tsx": true, "mjs": true, "cjs": true,
		"py": true, "rb": true, "go": true, "rs": true, "java": true,
		"kt": true, "swift": true, "c": true, "h": true, "cpp": true,
		"hpp": true, "cs": true, "php": true, "sh": true, "bash": true,
		"zsh": true, "ps1": true, "sql": true, "r": true, "vue": true,
		"svelte": true, "ini": true, "cfg": true, "conf": true, "properties": true,
		"tex": true, "rst": true, "diff": true, "patch": true,
	}
)

// AttachmentUploadInput 表示前端提交的单个 base64 dataUrl 上传项。
type AttachmentUploadInput struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType,omitempty"`
	DataURL  string `json:"dataUrl"`
}

// NormalizedUpload 表示已完整校验并解码待落盘的附件。
type NormalizedUpload struct {
	Kind     string
	Name     string
	MimeType string
	DataURL  string
	Buffer   []byte
	Size     int
}

// VideoPreparationResult 描述视频探测与关键帧抽取结果。
type VideoPreparationResult struct {
	FilePath    string
	Frames      []string
	Metadata    map[string]any
	FramesReady bool
}

// VideoPreprocessor 允许测试替换 ffprobe/ffmpeg 抽帧过程；为 nil 时调用本机二进制。
type VideoPreprocessor func(ctx context.Context, filePath string) VideoPreparationResult

// AttachmentServiceOptions 配置附件上传服务根路径与存储。
type AttachmentServiceOptions struct {
	Store             *PublishingStore
	AIHomeDir         string
	HostHomeDir       string
	TempRootDir       string
	VideoPreprocessor VideoPreprocessor
}

// AttachmentService 负责校验、原子落盘与入库会话附件。
type AttachmentService struct {
	store             *PublishingStore
	aiHomeDir         string
	hostHomeDir       string
	tempRootDir       string
	videoPreprocessor VideoPreprocessor
}

// NewAttachmentService 构造附件服务。
func NewAttachmentService(opts AttachmentServiceOptions) (*AttachmentService, error) {
	if opts.Store == nil {
		return nil, ErrInvalid("attachment_store_required")
	}
	tempRoot := strings.TrimSpace(opts.TempRootDir)
	if tempRoot == "" {
		tempRoot = filepath.Join(os.TempDir(), "aih-web-chat-images")
	}
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if hostHome == "" && strings.TrimSpace(opts.AIHomeDir) != "" {
		hostHome = resolveHostHomeFromAIHome(opts.AIHomeDir)
	}
	prep := opts.VideoPreprocessor
	if prep == nil {
		prep = defaultPrepareChatVideo
	}
	return &AttachmentService{
		store:             opts.Store,
		aiHomeDir:         strings.TrimSpace(opts.AIHomeDir),
		hostHomeDir:       hostHome,
		tempRootDir:       tempRoot,
		videoPreprocessor: prep,
	}, nil
}

// Upload 校验整批上传（数量、编码、UTF-8、单文件与总量上限），原子写盘并登记到数据库；失败回滚临时文件。
func (s *AttachmentService) Upload(ctx context.Context, sessionID string, uploads []AttachmentUploadInput) ([]Attachment, error) {
	session, err := s.store.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	normalized, err := NormalizeChatUploadBatch(uploads)
	if err != nil {
		return nil, err
	}
	rootDir := s.resolveAttachmentRootDir(session)
	if err := os.MkdirAll(rootDir, 0o700); err != nil {
		return nil, err
	}

	writtenPaths := make([]string, 0, len(normalized))
	dbInputs := make([]AttachmentInput, 0, len(normalized))
	rollback := func() {
		for _, p := range writtenPaths {
			_ = os.Remove(p)
			if GuessVideoMimeType(p) != "" {
				_ = os.RemoveAll(VideoFramesDir(p))
			}
		}
	}

	for _, item := range normalized {
		targetPath := buildUniqueAttachmentPath(rootDir, item.Kind, item.Name)
		if err := atomicWriteFile(targetPath, item.Buffer, 0o600); err != nil {
			rollback()
			return nil, err
		}
		writtenPaths = append(writtenPaths, targetPath)
		if item.Kind == attachmentKindVideo && s.videoPreprocessor != nil {
			_ = s.videoPreprocessor(ctx, targetPath)
		}
		mimeType := GuessImageMimeType(targetPath)
		if mimeType == "" {
			mimeType = GuessVideoMimeType(targetPath)
		}
		if mimeType == "" {
			mimeType = item.MimeType
		}
		dbInputs = append(dbInputs, AttachmentInput{
			FilePath: targetPath,
			Name:     item.Name,
			MimeType: mimeType,
		})
	}

	created, err := s.store.CreateAttachments(ctx, session.SessionID, dbInputs)
	if err != nil {
		rollback()
		return nil, err
	}
	return created, nil
}

func (s *AttachmentService) resolveAttachmentRootDir(session *Session) string {
	provider := strings.ToLower(strings.TrimSpace(session.Provider))
	if s.hostHomeDir != "" && storagepolicy.Normalize(provider) != "" {
		if providerRoot := storagepolicy.ResolveAttachmentRoot(s.hostHomeDir, provider); filepath.IsAbs(providerRoot) {
			return providerRoot
		}
	}
	projectPath := strings.TrimSpace(session.ProjectPath)
	if projectPath != "" && filepath.IsAbs(projectPath) {
		if info, err := os.Stat(projectPath); err == nil && info.IsDir() {
			return filepath.Join(projectPath, ".aih", "chat-images")
		}
	}
	return s.tempRootDir
}

func resolveHostHomeFromAIHome(aiHomeDir string) string {
	cleaned := filepath.Clean(strings.TrimSpace(aiHomeDir))
	if cleaned == "" || cleaned == "." {
		return ""
	}
	if filepath.Base(cleaned) == ".ai_home" {
		return filepath.Dir(cleaned)
	}
	return ""
}

// NormalizeChatUploadBatch 对整个上传批做严格前置校验。
func NormalizeChatUploadBatch(uploads []AttachmentUploadInput) ([]NormalizedUpload, error) {
	if len(uploads) == 0 {
		return nil, NewErrorWithMessage("chat_attachments_required", http.StatusUnprocessableEntity, "请至少附加一个文件", nil)
	}
	if len(uploads) > MaxAttachmentFiles {
		return nil, NewErrorWithMessage("chat_attachment_limit_exceeded", http.StatusUnprocessableEntity,
			fmt.Sprintf("每次最多附加 %d 个文件", MaxAttachmentFiles), map[string]any{"limit": MaxAttachmentFiles})
	}
	out := make([]NormalizedUpload, 0, len(uploads))
	totalBytes := 0
	for _, u := range uploads {
		item, err := NormalizeChatUpload(u)
		if err != nil {
			return nil, err
		}
		totalBytes += item.Size
		if totalBytes > MaxTotalAttachmentBytes {
			return nil, NewErrorWithMessage("chat_attachment_total_size_exceeded", http.StatusUnprocessableEntity,
				fmt.Sprintf("附件总大小不能超过 %d MB", MaxTotalAttachmentBytes/1048576),
				map[string]any{"limit": MaxTotalAttachmentBytes, "actual": totalBytes})
		}
		out = append(out, item)
	}
	return out, nil
}

// NormalizeChatUpload 校验并解码单个附件上传项。
func NormalizeChatUpload(u AttachmentUploadInput) (NormalizedUpload, error) {
	name := strings.TrimSpace(u.Name)
	if name == "" {
		return NormalizedUpload{}, NewErrorWithMessage("chat_attachment_name_required", http.StatusUnprocessableEntity, "附件名称不能为空", nil)
	}
	declaredMIME := strings.ToLower(strings.TrimSpace(u.MimeType))
	kind := resolveChatAttachmentKind(name, declaredMIME)
	if kind == "" {
		return NormalizedUpload{}, NewErrorWithMessage("chat_attachment_mime_unsupported", http.StatusUnprocessableEntity,
			fmt.Sprintf("%s：支持图片、视频、Markdown、文本、代码及 JSON/CSV 等文本数据文件", name),
			map[string]any{"mimeType": declaredMIME})
	}
	parsedMIME, rawBytes, err := ParseBase64DataURL(u.DataURL)
	if err != nil {
		return NormalizedUpload{}, err
	}
	if kind == attachmentKindDocument {
		docMIME := declaredMIME
		if docMIME == "" {
			docMIME = parsedMIME
		}
		if parsedMIME != docMIME && !(declaredMIME == "application/octet-stream" && strings.HasPrefix(parsedMIME, "text/")) {
			return NormalizedUpload{}, NewErrorWithMessage("chat_attachment_data_invalid", http.StatusUnprocessableEntity, fmt.Sprintf("%s：文本附件编码无效", name), nil)
		}
		if !utf8.Valid(rawBytes) {
			return NormalizedUpload{}, NewErrorWithMessage("chat_attachment_encoding_invalid", http.StatusUnprocessableEntity, fmt.Sprintf("%s：请使用 UTF-8 编码的文本文件", name), nil)
		}
		text := string(rawBytes)
		if err := assertAttachmentSize(name, attachmentKindDocument, len(rawBytes), true); err != nil {
			return NormalizedUpload{}, err
		}
		if binaryControlRegex.MatchString(text) {
			return NormalizedUpload{}, NewErrorWithMessage("chat_attachment_binary_text", http.StatusUnprocessableEntity, fmt.Sprintf("%s：文件包含二进制内容", name), nil)
		}
		ext := attachmentExtension(name)
		normalizedMIME := "text/plain"
		if ext == "md" || ext == "markdown" {
			normalizedMIME = "text/markdown"
		}
		return NormalizedUpload{
			Kind:     attachmentKindDocument,
			Name:     name,
			MimeType: normalizedMIME,
			DataURL:  strings.TrimSpace(u.DataURL),
			Buffer:   rawBytes,
			Size:     len(rawBytes),
		}, nil
	}

	mimeType := declaredMIME
	if mimeType == "" || mimeType == "application/octet-stream" {
		if kind == attachmentKindVideo {
			mimeType = videoExtMimeMap["."+attachmentExtension(name)]
		} else {
			mimeType = parsedMIME
		}
	}
	if mimeType == "" || (parsedMIME != mimeType && !(declaredMIME == "application/octet-stream" && parsedMIME == mimeType)) {
		return NormalizedUpload{}, NewErrorWithMessage("chat_attachment_data_invalid", http.StatusUnprocessableEntity, fmt.Sprintf("%s：附件 MIME 与编码不一致", name), nil)
	}
	if err := assertAttachmentSize(name, kind, len(rawBytes), false); err != nil {
		return NormalizedUpload{}, err
	}
	return NormalizedUpload{
		Kind:     kind,
		Name:     name,
		MimeType: mimeType,
		DataURL:  strings.TrimSpace(u.DataURL),
		Buffer:   rawBytes,
		Size:     len(rawBytes),
	}, nil
}

// ParseBase64DataURL 严格校验 `data:<mime>;base64,<payload>` 并在解码前检查总大小预算。
func ParseBase64DataURL(dataURL string) (string, []byte, error) {
	normalized := strings.TrimSpace(dataURL)
	comma := strings.IndexByte(normalized, ',')
	if comma < 0 {
		return "", nil, NewErrorWithMessage("chat_attachment_data_invalid", http.StatusUnprocessableEntity, "附件编码无效", nil)
	}
	header := normalized[:comma]
	b64 := normalized[comma+1:]
	m := dataURLHeaderRegex.FindStringSubmatch(header)
	if len(m) < 2 {
		return "", nil, NewErrorWithMessage("chat_attachment_data_invalid", http.StatusUnprocessableEntity, "附件编码无效", nil)
	}
	maxEncodedLen := ((MaxTotalAttachmentBytes + 2) / 3) * 4
	if len(b64) > maxEncodedLen {
		return "", nil, NewErrorWithMessage("chat_attachment_total_size_exceeded", http.StatusUnprocessableEntity,
			fmt.Sprintf("附件总大小不能超过 %d MB", MaxTotalAttachmentBytes/1048576),
			map[string]any{"limit": MaxTotalAttachmentBytes})
	}
	if !base64ShapeRegex.MatchString(b64) || len(b64)%4 == 1 {
		return "", nil, NewErrorWithMessage("chat_attachment_data_invalid", http.StatusUnprocessableEntity, "附件编码无效", nil)
	}
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", nil, NewErrorWithMessage("chat_attachment_data_invalid", http.StatusUnprocessableEntity, "附件编码无效", nil)
	}
	canonical := strings.TrimRight(base64.StdEncoding.EncodeToString(decoded), "=")
	if canonical != strings.TrimRight(b64, "=") {
		return "", nil, NewErrorWithMessage("chat_attachment_data_invalid", http.StatusUnprocessableEntity, "附件编码无效", nil)
	}
	return strings.ToLower(strings.TrimSpace(m[1])), decoded, nil
}

func resolveChatAttachmentKind(name, mimeType string) string {
	mime := strings.ToLower(strings.TrimSpace(mimeType))
	ext := attachmentExtension(name)
	if supportedImageMIME[mime] {
		return attachmentKindImage
	}
	if supportedVideoMIME[mime] {
		return attachmentKindVideo
	}
	if strings.HasPrefix(mime, "text/") || supportedTextExtensions[ext] {
		return attachmentKindDocument
	}
	if videoExtMimeMap["."+ext] != "" && (mime == "" || mime == "application/octet-stream") {
		return attachmentKindVideo
	}
	return ""
}

func attachmentExtension(name string) string {
	ext := strings.TrimPrefix(filepath.Ext(strings.TrimSpace(name)), ".")
	return strings.ToLower(ext)
}

func assertAttachmentSize(name, kind string, size int, allowEmpty bool) error {
	maximum := MaxDocumentBytes
	label := "文本文件"
	if kind == attachmentKindImage {
		maximum = MaxImageBytes
		label = "图片"
	} else if kind == attachmentKindVideo {
		maximum = MaxVideoBytes
		label = "视频"
	}
	if size < 0 || size > maximum {
		return NewErrorWithMessage("chat_attachment_size_exceeded", http.StatusUnprocessableEntity,
			fmt.Sprintf("%s：%s不能超过 %d MB", name, label, maximum/1048576),
			map[string]any{"kind": kind, "limit": maximum, "actual": size})
	}
	if size == 0 && !allowEmpty {
		emptyLabel := label
		if kind == attachmentKindDocument {
			emptyLabel = "附件"
		}
		return NewErrorWithMessage("chat_attachment_empty", http.StatusUnprocessableEntity,
			fmt.Sprintf("%s：%s为空", name, emptyLabel), map[string]any{"kind": kind})
	}
	return nil
}

func buildUniqueAttachmentPath(rootDir, kind, rawName string) string {
	uuidPart := randomAttachmentToken()
	safe := sanitizeAttachmentFileName(rawName)
	ext := attachmentExtension(safe)
	switch kind {
	case attachmentKindDocument:
		if !supportedTextExtensions[ext] {
			safe += ".txt"
		}
	case attachmentKindVideo:
		if safe == "" {
			safe = "video.mp4"
		}
		if GuessVideoMimeType(safe) == "" {
			safe += ".mp4"
		}
	default:
		if safe == "" {
			safe = "image.png"
		}
	}
	return filepath.Join(rootDir, uuidPart+"-"+safe)
}

func sanitizeAttachmentFileName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r == '/' || r == '\\' || (r >= 0 && r < 0x20) {
			b.WriteByte('_')
		} else {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) > 160 {
		out = out[len(out)-160:]
	}
	return out
}

func randomAttachmentToken() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw[:])
}

func defaultPrepareChatVideo(ctx context.Context, filePath string) VideoPreparationResult {
	finalDir := VideoFramesDir(filePath)
	stagingDir := finalDir + "." + randomAttachmentToken() + ".tmp"
	meta := map[string]any{}
	var frames []string
	ready := false
	cleanup := func() {
		_ = os.RemoveAll(stagingDir)
		_ = os.RemoveAll(finalDir)
	}
	toolCtx, cancel := context.WithTimeout(ctx, videoToolTimeout)
	defer cancel()

	ffprobe := resolveVideoToolBinary("ffprobe")
	ffmpeg := resolveVideoToolBinary("ffmpeg")
	if out, err := exec.CommandContext(toolCtx, ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath).Output(); err == nil {
		var parsed struct {
			Format struct {
				Duration string `json:"duration"`
			} `json:"format"`
			Streams []struct {
				CodecType string `json:"codec_type"`
				Width     int    `json:"width"`
				Height    int    `json:"height"`
			} `json:"streams"`
		}
		if json.Unmarshal(out, &parsed) == nil {
			if dur, convErr := parsePositiveFloat(parsed.Format.Duration); convErr == nil && dur > 0 {
				meta["durationSeconds"] = math.Round(dur*10) / 10
			}
			for _, st := range parsed.Streams {
				if st.CodecType == "video" {
					if st.Width > 0 {
						meta["width"] = st.Width
					}
					if st.Height > 0 {
						meta["height"] = st.Height
					}
					break
				}
			}
		}
	} else {
		cleanup()
		return VideoPreparationResult{FilePath: filePath, Metadata: meta}
	}

	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		cleanup()
		return VideoPreparationResult{FilePath: filePath, Metadata: meta}
	}
	scaleFilter := fmt.Sprintf("scale='min(%d,iw)':-2", frameEdgeLimit)
	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-i", filePath}
	if dur, ok := toFiniteNonNegFloat(meta["durationSeconds"]); ok && dur > 0 {
		interval := math.Max(1, dur/float64(maxVideoFrames))
		args = append(args, "-vf", fmt.Sprintf("fps=1/%.3f,%s", interval, scaleFilter), "-frames:v", fmt.Sprintf("%d", maxVideoFrames))
	} else {
		args = append(args, "-vf", scaleFilter, "-frames:v", "1")
	}
	args = append(args, filepath.Join(stagingDir, "frame-%02d.jpg"))
	if err := exec.CommandContext(toolCtx, ffmpeg, args...).Run(); err != nil {
		cleanup()
		return VideoPreparationResult{FilePath: filePath, Metadata: meta}
	}
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		cleanup()
		return VideoPreparationResult{FilePath: filePath, Metadata: meta}
	}
	frameNames := make([]string, 0, len(entries))
	for _, entry := range entries {
		if frameFileRegex.MatchString(entry.Name()) {
			frameNames = append(frameNames, entry.Name())
		}
	}
	ready = len(frameNames) > 0
	record := CloneMap(meta)
	record["frames"] = frameNames
	record["ready"] = ready
	rawRecord, err := json.Marshal(record)
	if err != nil || atomicWriteFile(filepath.Join(stagingDir, "metadata.json"), rawRecord, 0o600) != nil {
		cleanup()
		return VideoPreparationResult{FilePath: filePath, Metadata: meta}
	}
	_ = os.RemoveAll(finalDir)
	if err := os.Rename(stagingDir, finalDir); err != nil {
		cleanup()
		return VideoPreparationResult{FilePath: filePath, Metadata: meta}
	}
	for _, name := range frameNames {
		frames = append(frames, filepath.Join(finalDir, name))
	}
	return VideoPreparationResult{
		FilePath:    filePath,
		Frames:      frames,
		Metadata:    meta,
		FramesReady: ready,
	}
}

func resolveVideoToolBinary(name string) string {
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"} {
		candidate := filepath.Join(dir, name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return name
}

func parsePositiveFloat(raw string) (float64, error) {
	var f float64
	_, err := fmt.Sscanf(strings.TrimSpace(raw), "%f", &f)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f <= 0 {
		return 0, fmt.Errorf("invalid duration")
	}
	return f, nil
}
