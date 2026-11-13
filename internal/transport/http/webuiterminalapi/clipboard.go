package webuiterminalapi

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/contracts/chatattachments"
)

const (
	// clipboardImageDirName / projectAttachmentDir 与 Node chat-attachments 一致：
	// 项目目录存在时写 <cwd>/.aih/chat-images，否则写系统临时目录。
	clipboardImageDirName = "aih-web-chat-images"
	projectAttachmentDir  = ".aih"
	projectChatImageDir   = "chat-images"
)

var unixSafePathPattern = regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)

// handleClipboardImage 把浏览器粘贴的图片落盘，返回可直接粘进终端的路径。
//
// 语义对齐 Node webui-terminal-clipboard.js：
//   - 只接受 png/jpeg/webp/gif，声明 MIME 必须与文件头一致；
//   - 上限 10MB（contracts/chatattachments）；
//   - 文件写 0600，返回 shell 安全的 pasteText；
//   - 优先落到会话 cwd（跨机器路径不存在时回退临时目录）。
func (handler *Handler) handleClipboardImage(response http.ResponseWriter, request *http.Request) {
	var body struct {
		SessionKey string `json:"sessionKey"`
		Cwd        string `json:"cwd"`
		DataURL    string `json:"dataUrl"`
	}
	handler.readJSON(request, maxClipboardBodyBytes, &body)
	dataURL := strings.TrimSpace(body.DataURL)
	if dataURL == "" {
		writeJSON(response, http.StatusBadRequest, errorView{OK: false, Error: "terminal_image_required"})
		return
	}

	cwd := ""
	if key := normalizeSessionKey(body.SessionKey); key != "" {
		if snapshot := handler.findSnapshotByKey(key); snapshot != nil {
			cwd = snapshot.Dir
		}
	}
	if cwd == "" {
		cwd = handler.resolveCwd(body.Cwd)
	}

	path, failure := persistClipboardImage(dataURL, cwd, handler.now())
	if failure != nil {
		status := http.StatusBadRequest
		if strings.Contains(failure.code, "size_exceeded") {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSON(response, status, errorView{OK: false, Error: failure.code, Message: failure.message})
		return
	}
	writeJSON(response, http.StatusCreated, struct {
		OK        bool   `json:"ok"`
		Path      string `json:"path"`
		PasteText string `json:"pasteText"`
		Cwd       string `json:"cwd"`
	}{OK: true, Path: path, PasteText: formatClipboardPath(path, runtime.GOOS), Cwd: cwd})
}

// persistClipboardImage 校验 data URL 并原子写入项目目录。
func persistClipboardImage(dataURL string, cwd string, now time.Time) (string, *terminalError) {
	mimeType, payload, ok := parseDataURL(dataURL)
	if !ok {
		return "", &terminalError{code: "terminal_image_invalid", message: "图片数据格式不正确"}
	}
	buffer, err := decodeBase64(payload)
	if err != nil {
		return "", &terminalError{code: "terminal_image_invalid", message: "图片 base64 解码失败"}
	}
	if int64(len(buffer)) > chatattachments.MaxImageBytes {
		return "", &terminalError{code: "terminal_image_size_exceeded", message: "图片超过大小上限"}
	}
	declared := normalizeImageMime(mimeType)
	actual := detectImageMime(buffer)
	if declared == "" || actual == "" || declared != actual {
		return "", &terminalError{code: "terminal_image_invalid", message: "图片格式与内容不匹配"}
	}
	extension := imageExtension(actual)

	root := clipboardRootDir(cwd)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", &terminalError{code: "terminal_image_persist_failed", message: err.Error()}
	}
	name := "clipboard-" + strconv.FormatInt(now.UnixMilli(), 10) + "-" + randomHex(3) + "-1." + extension
	path := filepath.Join(root, name)
	if err := writeFileAtomic(path, buffer, 0o600); err != nil {
		return "", &terminalError{code: "terminal_image_persist_failed", message: err.Error()}
	}
	return path, nil
}

// clipboardRootDir 与 Node resolveAttachmentRootDir 一致：
// cwd 必须是已存在的绝对目录才写项目内，否则回退系统临时目录。
func clipboardRootDir(cwd string) string {
	if filepath.IsAbs(cwd) {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			return filepath.Join(cwd, projectAttachmentDir, projectChatImageDir)
		}
	}
	return filepath.Join(os.TempDir(), clipboardImageDirName)
}

func parseDataURL(dataURL string) (string, string, bool) {
	if !strings.HasPrefix(dataURL, "data:") {
		return "", "", false
	}
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 {
		return "", "", false
	}
	meta := dataURL[len("data:"):comma]
	payload := dataURL[comma+1:]
	separator := strings.IndexByte(meta, ';')
	mimeType := meta
	if separator >= 0 {
		mimeType = meta[:separator]
		if !strings.Contains(strings.ToLower(meta[separator+1:]), "base64") {
			return "", "", false
		}
	}
	if strings.TrimSpace(mimeType) == "" {
		return "", "", false
	}
	return mimeType, payload, true
}

// decodeBase64 容忍换行与缺失的 padding（浏览器 data URL 与 Node Buffer.from 的宽容度一致）。
func decodeBase64(value string) ([]byte, error) {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\r', ' ', '\t':
			return -1
		}
		return r
	}, value)
	if remainder := len(cleaned) % 4; remainder != 0 {
		cleaned += strings.Repeat("=", 4-remainder)
	}
	return base64.StdEncoding.DecodeString(cleaned)
}

func normalizeImageMime(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif":
		if normalized == "image/jpg" {
			return "image/jpeg"
		}
		return normalized
	}
	return ""
}

func detectImageMime(buffer []byte) string {
	if len(buffer) >= 8 && buffer[0] == 0x89 && buffer[1] == 'P' && buffer[2] == 'N' && buffer[3] == 'G' {
		return "image/png"
	}
	if len(buffer) >= 3 && buffer[0] == 0xFF && buffer[1] == 0xD8 && buffer[2] == 0xFF {
		return "image/jpeg"
	}
	if len(buffer) >= 12 && string(buffer[0:4]) == "RIFF" && string(buffer[8:12]) == "WEBP" {
		return "image/webp"
	}
	if len(buffer) >= 4 && string(buffer[0:4]) == "GIF8" {
		return "image/gif"
	}
	return ""
}

func imageExtension(mimeType string) string {
	switch mimeType {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	}
	return "bin"
}

func randomHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "000000"
	}
	return hex.EncodeToString(buffer)
}

func writeFileAtomic(path string, content []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".clipboard-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

// formatClipboardPath 与 Node 一致：路径含特殊字符时加 shell 引用，
// 让用户粘贴到终端时是一个完整参数。
func formatClipboardPath(path string, platform string) string {
	value := path
	if platform == "windows" {
		if strings.ContainsAny(value, " \\&()[]{}^=;!'+,~\x60") {
			return "\"" + value + "\""
		}
		return value
	}
	if unixSafePathPattern.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
