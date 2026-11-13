package webuichatattachmentsapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

type stubAuthorizer struct {
	allow bool
}

func (s stubAuthorizer) Authorized(_ *http.Request) bool { return s.allow }

func writeTestFile(t *testing.T, target string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("创建目录失败 %s: %v", target, err)
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		t.Fatalf("写文件失败 %s: %v", target, err)
	}
}

func doAttachmentGet(t *testing.T, h http.Handler, method, targetPath string) *httptest.ResponseRecorder {
	t.Helper()
	reqURL := Path
	if targetPath != "" {
		reqURL += "?path=" + url.QueryEscape(targetPath)
	}
	req := httptest.NewRequest(method, reqURL, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestNewHandlerRejectsNilAuthorizer(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("缺少鉴权器应当报错")
	}
}

func TestAttachmentAuthAndMethodGuards(t *testing.T) {
	root := t.TempDir()
	unauthHandler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: false}, ChatImageRootDir: root})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	rec := doAttachmentGet(t, unauthHandler, http.MethodGet, filepath.Join(root, "a.png"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权期望 401，实际 %d", rec.Code)
	}
	if got := rec.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("WWW-Authenticate 期望 Bearer，实际 %q", got)
	}

	authHandler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: true}, ChatImageRootDir: root})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	postRec := doAttachmentGet(t, authHandler, http.MethodPost, filepath.Join(root, "a.png"))
	if postRec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 期望 405，实际 %d", postRec.Code)
	}
	if got := postRec.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("Allow 头期望 GET，实际 %q", got)
	}
}

func TestServesAllowedImageAndVideoTypesWithCacheHeader(t *testing.T) {
	base := t.TempDir()
	hostHome := filepath.Join(base, "host")
	aiHome := filepath.Join(hostHome, ".ai_home")
	chatRoot := filepath.Join(base, "tmp-images")
	workspace := filepath.Join(base, "repo")

	cases := []struct {
		name     string
		filePath string
		mime     string
		payload  []byte
	}{
		{"png", filepath.Join(chatRoot, "a.png"), "image/png", []byte("pngdata")},
		{"jpg", filepath.Join(hostHome, ".codex", "attachments", "b.jpg"), "image/jpeg", []byte("jpgdata")},
		{"jpeg", filepath.Join(hostHome, ".claude", "artifacts", "c.jpeg"), "image/jpeg", []byte("jpegdata")},
		{"webp", filepath.Join(hostHome, ".gemini", "antigravity-cli", "brain", "d.webp"), "image/webp", []byte("webpdata")},
		{"gif", filepath.Join(workspace, ".aih", "chat-images", "e.gif"), "image/gif", []byte("gifdata")},
		{"mp4", filepath.Join(hostHome, "tmp", "model", "images", "clip.mp4"), "video/mp4", []byte("mp4data")},
		{"mov", filepath.Join(chatRoot, "clip.mov"), "video/quicktime", []byte("movdata")},
		{"webm", filepath.Join(chatRoot, "clip.webm"), "video/webm", []byte("webmdata")},
		{"m4v", filepath.Join(chatRoot, "clip.m4v"), "video/x-m4v", []byte("m4vdata")},
	}

	for _, tc := range cases {
		writeTestFile(t, tc.filePath, tc.payload)
	}

	h, err := NewHandler(Dependencies{
		Authorizer:       stubAuthorizer{allow: true},
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		ChatImageRootDir: chatRoot,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doAttachmentGet(t, h, http.MethodGet, tc.filePath)
			if rec.Code != http.StatusOK {
				t.Fatalf("期望 200，实际 %d body=%s", rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Content-Type"); got != tc.mime {
				t.Fatalf("Content-Type 期望 %q，实际 %q", tc.mime, got)
			}
			if got := rec.Header().Get("Cache-Control"); got != "private, max-age=300" {
				t.Fatalf("Cache-Control 期望 private, max-age=300，实际 %q", got)
			}
			if rec.Body.String() != string(tc.payload) {
				t.Fatalf("响应体不符: got %q want %q", rec.Body.String(), string(tc.payload))
			}
		})
	}

	// 投影路径应映射为宿主原生目录后再放行
	projected := filepath.Join(aiHome, "run", "auth-projections", "claude", "acct_1", ".claude", "artifacts", "c.jpeg")
	projRec := doAttachmentGet(t, h, http.MethodGet, projected)
	if projRec.Code != http.StatusOK || projRec.Body.String() != "jpegdata" {
		t.Fatalf("投影路径解析失败: code=%d body=%s", projRec.Code, projRec.Body.String())
	}
}

func TestRejectsConfinementPrivateSymlinkAndUnsupportedTypes(t *testing.T) {
	base := t.TempDir()
	hostHome := filepath.Join(base, "host")
	aiHome := filepath.Join(hostHome, ".ai_home")
	chatRoot := filepath.Join(base, "tmp-images")
	outsideFile := filepath.Join(hostHome, "Pictures", "secret.png")
	bareHomeFile := filepath.Join(hostHome, "secret.png")

	writeTestFile(t, outsideFile, []byte("secret"))
	writeTestFile(t, bareHomeFile, []byte("secret-home"))
	writeTestFile(t, filepath.Join(hostHome, ".claude", ".credentials.json"), []byte(`{"token":"x"}`))
	writeTestFile(t, filepath.Join(hostHome, ".codex", "electron-user-data", "leak.png"), []byte("png"))
	writeTestFile(t, filepath.Join(hostHome, ".kimi-code", "credentials", "qr.png"), []byte("png"))
	writeTestFile(t, filepath.Join(hostHome, ".codebuddy", "sessions", "shot.png"), []byte("png"))
	writeTestFile(t, filepath.Join(base, "repo", ".aih", "chat-images-evil", "bad.png"), []byte("png"))
	writeTestFile(t, filepath.Join(chatRoot, "note.txt"), []byte("text"))
	writeTestFile(t, filepath.Join(chatRoot, "vector.svg"), []byte("<svg/>"))
	if err := os.MkdirAll(filepath.Join(chatRoot, "subdir.png"), 0o755); err != nil {
		t.Fatal(err)
	}

	// 符号链接越界与指向私密目录
	symlinkEscape := filepath.Join(chatRoot, "escape.png")
	if err := os.Symlink(outsideFile, symlinkEscape); err != nil {
		t.Fatal(err)
	}
	symlinkPrivate := filepath.Join(hostHome, ".codex", "leak-link.png")
	if err := os.Symlink(filepath.Join(hostHome, ".codex", "electron-user-data", "leak.png"), symlinkPrivate); err != nil {
		t.Fatal(err)
	}

	h, err := NewHandler(Dependencies{
		Authorizer:       stubAuthorizer{allow: true},
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		ChatImageRootDir: chatRoot,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}

	notFoundPaths := []string{
		"",
		"relative/file.png",
		filepath.Join(chatRoot, "missing.png"),
		filepath.Join(chatRoot, "subdir.png"),
		outsideFile,
		bareHomeFile,
		filepath.Join(hostHome, ".claude", ".credentials.json"),
		filepath.Join(aiHome, "run", "auth-projections", "claude", "acct_1", ".claude", ".credentials.json"),
		filepath.Join(hostHome, ".codex", "electron-user-data", "leak.png"),
		filepath.Join(hostHome, ".kimi-code", "credentials", "qr.png"),
		filepath.Join(hostHome, ".codebuddy", "sessions", "shot.png"),
		filepath.Join(base, "repo", ".aih", "chat-images-evil", "bad.png"),
		symlinkEscape,
		symlinkPrivate,
	}
	for _, p := range notFoundPaths {
		rec := doAttachmentGet(t, h, http.MethodGet, p)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("路径 %q 期望 404，实际 %d body=%s", p, rec.Code, rec.Body.String())
		}
		var body errorResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.OK || body.Error != "chat_attachment_not_found" {
			t.Fatalf("路径 %q 错误响应不符: %s", p, rec.Body.String())
		}
	}

	for _, p := range []string{
		filepath.Join(chatRoot, "note.txt"),
		filepath.Join(chatRoot, "vector.svg"),
	} {
		rec := doAttachmentGet(t, h, http.MethodGet, p)
		if rec.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("不支持类型 %q 期望 415，实际 %d body=%s", p, rec.Code, rec.Body.String())
		}
		var body errorResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.OK || body.Error != "unsupported_chat_attachment_type" {
			t.Fatalf("不支持类型 %q 错误响应不符: %s", p, rec.Body.String())
		}
	}
}
