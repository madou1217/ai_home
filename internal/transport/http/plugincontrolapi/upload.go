package plugincontrolapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/plugincontrol"
	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	"github.com/madou1217/ai_home/internal/adapters/pluginartifact"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	// UploadPath 接收原始 .aih-plugin 字节流；远程 server 看不到客户端本地
	// 文件时，CLI 用这条路由把包直接推上来。
	UploadPath = "/v1/management/plugins/install-upload"

	uploadHeaderSHA256        = "X-Aih-Package-Sha256"
	uploadHeaderTrustKey      = "X-Aih-Trust-Key-Pem"
	uploadHeaderFingerprint   = "X-Aih-Expect-Fingerprint"
	uploadHeaderReplaceKey    = "X-Aih-Replace-Key"
	uploadHeaderRequireSigned = "X-Aih-Require-Signed"
)

// upload 把请求体落成临时 .aih-plugin，再复用与 JSON 安装相同的校验、
// 公钥登记、签名策略和审计路径。
func (handler *Handler) upload(response http.ResponseWriter, request *http.Request) {
	if !requireMethod(response, request, http.MethodPost) {
		return
	}
	requireSigned := headerBool(request.Header.Get(uploadHeaderRequireSigned)) ||
		request.URL.Query().Get("requireSigned") == "1"
	expected := strings.ToLower(strings.TrimSpace(request.Header.Get(uploadHeaderSHA256)))
	trustKeyPEM := ""
	if encoded := strings.TrimSpace(request.Header.Get(uploadHeaderTrustKey)); encoded != "" {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			decoded, err = base64.RawStdEncoding.DecodeString(encoded)
		}
		if err != nil {
			writeControlError(response, pluginerr.New("plugin_signature_key_invalid", "公钥头无法解码"))
			return
		}
		trustKeyPEM = string(decoded)
	}
	dir, err := os.MkdirTemp("", "aih-plugin-upload-")
	if err != nil {
		writeControlError(response, pluginerr.New("plugin_package_missing", "无法创建上传临时目录"))
		return
	}
	defer func() { _ = os.RemoveAll(dir) }()
	file := filepath.Join(dir, "package.aih-plugin")
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		writeControlError(response, pluginerr.New("plugin_package_missing", "无法写入上传临时文件"))
		return
	}
	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(handle, digest), io.LimitReader(request.Body, plugincontract.MaxPackageBytes+1))
	closeErr := handle.Close()
	if copyErr != nil || closeErr != nil {
		writeControlError(response, pluginerr.New("plugin_package_missing", "上传中断"))
		return
	}
	if written == 0 {
		writeControlError(response, pluginerr.New("plugin_package_missing", "上传内容为空"))
		return
	}
	if written > plugincontract.MaxPackageBytes {
		writeControlError(response, pluginerr.New("plugin_download_too_large", "插件包超过大小上限"))
		return
	}
	computed := hex.EncodeToString(digest.Sum(nil))
	if expected != "" && computed != expected {
		writeControlError(response, pluginerr.New("plugin_package_digest_mismatch", "上传的插件包与客户端摘要不一致"))
		return
	}
	if strings.TrimSpace(trustKeyPEM) != "" {
		if strings.TrimSpace(handler.aiHomeDir) == "" {
			writeControlError(response, pluginerr.New("plugin_home_unavailable", "服务端插件数据根不可用"))
			return
		}
		if _, trustErr := pluginartifact.TrustPackageKey(file, trustKeyPEM,
			strings.TrimSpace(request.Header.Get(uploadHeaderFingerprint)),
			headerBool(request.Header.Get(uploadHeaderReplaceKey)),
			handler.aiHomeDir); trustErr != nil {
			writeControlError(response, trustErr)
			return
		}
	}
	options := plugincontrol.AcceptOptions{
		HostVersion:    headerOr(request, HostVersionHeader, "1.0.0"),
		NodeVersion:    firstHeader(request, RuntimeVersionHeader),
		RequireSigned:  requireSigned,
		AllowUntrusted: !requireSigned,
	}
	result, installErr := handler.installer.Install(request.Context(), file, options)
	handler.respondInstall(response, result, installErr)
}

func headerBool(value string) bool {
	trimmed := strings.TrimSpace(value)
	return strings.EqualFold(trimmed, "true") || trimmed == "1"
}
