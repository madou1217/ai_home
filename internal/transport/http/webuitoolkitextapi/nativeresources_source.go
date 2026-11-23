package webuitoolkitextapi

import (
	"io"
	"net/http"

	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
)

const (
	nativeSourceUploadLimit = 32 << 20
	nativeSourceFileLimit   = 4 << 20
)

// serveNativeResourceSourceFiles 接收浏览器通过文件夹选择上传的文件集合。
//
// 前端按序号成对提交 paths 与 files 字段；Go 的 multipart 解析会保持同名
// 字段的先后顺序，因此可以按索引配对。
func (h *Handler) serveNativeResourceSourceFiles(w http.ResponseWriter, r *http.Request) {
	if h.nativeResources == nil {
		writeError(w, http.StatusServiceUnavailable, "native_resources_unavailable", "原生资源服务不可用")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, nativeSourceUploadLimit)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "native_resource_source_upload_invalid", "上传内容无法解析")
		return
	}
	paths := r.MultipartForm.Value["paths"]
	headers := r.MultipartForm.File["files"]
	if len(headers) == 0 || len(paths) != len(headers) {
		writeError(w, http.StatusBadRequest, "native_resource_source_upload_invalid", "缺少文件或路径")
		return
	}
	files := make([]nativeresources.SourceFile, 0, len(headers))
	for index, header := range headers {
		opened, err := header.Open()
		if err != nil {
			writeError(w, http.StatusBadRequest, "native_resource_source_upload_invalid", "文件无法读取")
			return
		}
		content, readErr := io.ReadAll(io.LimitReader(opened, nativeSourceFileLimit+1))
		_ = opened.Close()
		if readErr != nil || len(content) > nativeSourceFileLimit {
			writeError(w, http.StatusRequestEntityTooLarge, "native_resource_source_limit", "单个文件超过上传上限")
			return
		}
		files = append(files, nativeresources.SourceFile{Path: paths[index], Content: content})
	}
	result, err := h.nativeResources.ImportSourceFiles(
		r.FormValue("kind"),
		files,
		r.FormValue("name"),
	)
	if err != nil {
		writeNativeResourceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// serveNativeResourceSourceURL 下载远程归档并导入为一次性安装源。
func (h *Handler) serveNativeResourceSourceURL(w http.ResponseWriter, r *http.Request) {
	if h.nativeResources == nil {
		writeError(w, http.StatusServiceUnavailable, "native_resources_unavailable", "原生资源服务不可用")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	var input struct {
		Kind string `json:"kind"`
		URL  string `json:"url"`
	}
	if err := readJSONTarget(w, r, &input, 8*1024); err != nil {
		writeError(w, http.StatusBadRequest, "native_resource_source_url_invalid", "请求体无效")
		return
	}
	result, err := h.nativeResources.ImportSourceURL(r.Context(), input.Kind, input.URL)
	if err != nil {
		writeNativeResourceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
