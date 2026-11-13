package tools

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	frpcReleaseAPIURL    = "https://api.github.com/repos/fatedier/frp/releases/latest"
	frpcChecksumAsset    = "frp_sha256_checksums.txt"
	herdrManifestURL     = "https://herdr.dev/latest.json"
	maxReleaseMetaBytes  = 2 * 1024 * 1024
	maxChecksumFileBytes = 1 * 1024 * 1024
	maxArchiveFileBytes  = 256 * 1024 * 1024
)

var (
	semverRx    = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`)
	sha256HexRx = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// HTTPDoer 抽象 HTTP 客户端以支持测试桩。
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

func defaultHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyFromEnvironment
	return &http.Client{
		Timeout:   180 * time.Second,
		Transport: transport,
	}
}

type releaseError struct {
	Code    string
	Message string
}

func (e *releaseError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

type frpcAssetSpec struct {
	Platform        string
	ReleasePlatform string
	Arch            string
	Version         string
	ArchiveFormat   string
	RootName        string
	AssetName       string
	BinaryName      string
}

func normalizeReleaseVersion(v string) string {
	cleaned := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(v), "v"), "V")
	if !semverRx.MatchString(cleaned) {
		return ""
	}
	return cleaned
}

func resolveFrpcAssetSpec(nodePlatform string, goArch string, version string) (frpcAssetSpec, bool) {
	ver := normalizeReleaseVersion(version)
	arch := toGoArch(goArch)
	if ver == "" || arch == "" {
		return frpcAssetSpec{}, false
	}
	if nodePlatform != "darwin" && nodePlatform != "linux" && nodePlatform != "win32" {
		return frpcAssetSpec{}, false
	}
	relPlat := nodePlatform
	format := "tar.gz"
	binName := "frpc"
	if nodePlatform == "win32" {
		relPlat = "windows"
		format = "zip"
		binName = "frpc.exe"
	}
	root := fmt.Sprintf("frp_%s_%s_%s", ver, relPlat, arch)
	return frpcAssetSpec{
		Platform:        nodePlatform,
		ReleasePlatform: relPlat,
		Arch:            arch,
		Version:         ver,
		ArchiveFormat:   format,
		RootName:        root,
		AssetName:       root + "." + format,
		BinaryName:      binName,
	}, true
}

func parseFrpChecksum(content string, assetName string) string {
	expected := strings.TrimSpace(assetName)
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		digest := strings.ToLower(fields[0])
		if !sha256HexRx.MatchString(digest) {
			continue
		}
		name := strings.TrimPrefix(strings.TrimPrefix(fields[1], "*"), "./")
		if name == expected {
			return digest
		}
	}
	return ""
}

func isOfficialFrpAssetURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	return u.Scheme == "https" && u.Hostname() == "github.com" &&
		strings.HasPrefix(u.Path, "/fatedier/frp/releases/download/") && u.User == nil
}

func isOfficialHerdrAssetURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	return u.Scheme == "https" && u.Hostname() == "github.com" &&
		strings.HasPrefix(u.Path, "/herdrdev/herdr/releases/download/") && u.User == nil
}

func downloadBytes(ctx context.Context, client HTTPDoer, rawURL string, accept string, maxBytes int64) ([]byte, error) {
	if client == nil {
		client = defaultHTTPClient()
	}
	current := strings.TrimSpace(rawURL)
	for redirects := 0; redirects <= 5; redirects++ {
		u, err := url.Parse(current)
		if err != nil || u.Scheme != "https" || u.User != nil {
			return nil, &releaseError{Code: "release_download_url_invalid", Message: "下载地址无效"}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, err
		}
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		req.Header.Set("User-Agent", "ai-home-toolkit")
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusMovedPermanently || resp.StatusCode == http.StatusFound ||
			resp.StatusCode == http.StatusSeeOther || resp.StatusCode == http.StatusTemporaryRedirect ||
			resp.StatusCode == http.StatusPermanentRedirect {
			loc := resp.Header.Get("Location")
			_ = resp.Body.Close()
			if loc == "" {
				return nil, &releaseError{Code: "release_http_error", Message: fmt.Sprintf("http_%d", resp.StatusCode)}
			}
			nextURL, err := u.Parse(loc)
			if err != nil {
				return nil, err
			}
			current = nextURL.String()
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			_ = resp.Body.Close()
			return nil, &releaseError{Code: "release_http_error", Message: fmt.Sprintf("http_%d", resp.StatusCode)}
		}
		limited := io.LimitReader(resp.Body, maxBytes+1)
		data, err := io.ReadAll(limited)
		_ = resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > maxBytes {
			return nil, &releaseError{Code: "release_response_too_large", Message: "下载体积超出上限"}
		}
		return data, nil
	}
	return nil, &releaseError{Code: "release_redirect_limit", Message: "重定向次数过多"}
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func atomicPublishBinary(ctx context.Context, binary []byte, targetPath string, spec frpcAssetSpec, o Options) error {
	targetDir := filepath.Dir(targetPath)
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		return err
	}
	ext := filepath.Ext(targetPath)
	base := strings.TrimSuffix(filepath.Base(targetPath), ext)
	nonce := randomHex(6)
	tmpPath := filepath.Join(targetDir, fmt.Sprintf(".%s.tmp-%d-%s%s", base, os.Getpid(), nonce, ext))
	bakPath := filepath.Join(targetDir, fmt.Sprintf(".%s.backup-%d-%s%s", base, os.Getpid(), nonce, ext))
	if err := os.WriteFile(tmpPath, binary, 0o700); err != nil {
		return err
	}
	defer func() {
		_ = os.Remove(tmpPath)
		_ = os.Remove(bakPath)
	}()
	_ = os.Chmod(tmpPath, 0o700)

	verRes := o.Exec.Run(ctx, tmpPath, []string{"--version"}, environment.ExecOptions{Timeout: 5 * time.Second})
	if !verRes.OK {
		return &releaseError{Code: "frpc_release_binary_invalid", Message: firstNonEmpty(verRes.Stderr, verRes.Message, "frpc 二进制校验失败")}
	}
	if spec.Platform == "win32" && envBoolExists(o, targetPath) {
		if err := os.Rename(targetPath, bakPath); err != nil {
			return err
		}
		if err := os.Rename(tmpPath, targetPath); err != nil {
			_ = os.Rename(bakPath, targetPath)
			return err
		}
		_ = os.Remove(bakPath)
	} else if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	_ = os.Chmod(targetPath, 0o700)
	return nil
}

func extractFrpcFromArchive(archive []byte, spec frpcAssetSpec) ([]byte, error) {
	wantedPath := path.Join(spec.RootName, spec.BinaryName)
	if spec.ArchiveFormat == "tar.gz" {
		gz, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			return nil, &releaseError{Code: "frpc_release_extract_failed", Message: err.Error()}
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			hdr, err := tr.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return nil, &releaseError{Code: "frpc_release_extract_failed", Message: err.Error()}
			}
			if hdr.Typeflag != tar.TypeReg {
				continue
			}
			cleanName := path.Clean(strings.TrimPrefix(hdr.Name, "./"))
			if cleanName == wantedPath {
				data, err := io.ReadAll(io.LimitReader(tr, maxArchiveFileBytes))
				if err != nil {
					return nil, err
				}
				if len(data) == 0 {
					return nil, &releaseError{Code: "frpc_release_binary_missing"}
				}
				return data, nil
			}
		}
		return nil, &releaseError{Code: "frpc_release_binary_missing", Message: "压缩包内未找到 " + wantedPath}
	}

	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, &releaseError{Code: "frpc_release_extract_failed", Message: err.Error()}
	}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		cleanName := path.Clean(strings.ReplaceAll(strings.TrimPrefix(f.Name, "./"), `\`, `/`))
		if cleanName == wantedPath {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			data, err := io.ReadAll(io.LimitReader(rc, maxArchiveFileBytes))
			_ = rc.Close()
			if err != nil {
				return nil, err
			}
			if len(data) == 0 {
				return nil, &releaseError{Code: "frpc_release_binary_missing"}
			}
			return data, nil
		}
	}
	return nil, &releaseError{Code: "frpc_release_binary_missing", Message: "zip 包内未找到 " + wantedPath}
}

// InstallFrpcRelease 直接在 Go 内下载 fatedier/frp 最新官方包、核验 SHA256 并原子发布到目标路径。
func InstallFrpcRelease(ctx context.Context, targetPath string, opts Options) error {
	o := opts.withDefaults()
	if strings.TrimSpace(targetPath) == "" {
		targetPath = ResolveManagedFrpcPath(o)
	}
	if strings.TrimSpace(targetPath) == "" {
		return &releaseError{Code: "frpc_managed_target_unavailable", Message: "无法确定 frpc 安装目标路径"}
	}
	metaBytes, err := downloadBytes(ctx, o.HTTPClient, frpcReleaseAPIURL, "application/vnd.github+json", maxReleaseMetaBytes)
	if err != nil {
		return err
	}
	var release struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(metaBytes, &release); err != nil {
		return err
	}
	spec, ok := resolveFrpcAssetSpec(o.nodePlatform(), o.Arch, release.TagName)
	if !ok {
		return &releaseError{Code: "frpc_release_unsupported_target", Message: "当前平台或架构无可用的 frpc 官方包"}
	}
	var archiveURL, checksumURL string
	for _, a := range release.Assets {
		switch a.Name {
		case spec.AssetName:
			archiveURL = a.BrowserDownloadURL
		case frpcChecksumAsset:
			checksumURL = a.BrowserDownloadURL
		}
	}
	if !isOfficialFrpAssetURL(archiveURL) || !isOfficialFrpAssetURL(checksumURL) {
		return &releaseError{Code: "frpc_release_asset_unavailable", Message: "frpc 官方发布资产地址不可用"}
	}
	checksumBytes, err := downloadBytes(ctx, o.HTTPClient, checksumURL, "application/octet-stream", maxChecksumFileBytes)
	if err != nil {
		return err
	}
	expectedDigest := parseFrpChecksum(string(checksumBytes), spec.AssetName)
	if expectedDigest == "" {
		return &releaseError{Code: "frpc_release_checksum_missing", Message: "未找到对应架构的 SHA256 校验值"}
	}
	archiveBytes, err := downloadBytes(ctx, o.HTTPClient, archiveURL, "application/octet-stream", maxArchiveFileBytes)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(archiveBytes)
	if hex.EncodeToString(sum[:]) != expectedDigest {
		return &releaseError{Code: "frpc_release_digest_mismatch", Message: "frpc 安装包 SHA256 校验不一致"}
	}
	binary, err := extractFrpcFromArchive(archiveBytes, spec)
	if err != nil {
		return err
	}
	return atomicPublishBinary(ctx, binary, targetPath, spec, o)
}

// InstallHerdrRelease 直接在 Go 内下载 Herdr 官方发布包、核验 SHA256 并原子发布。
func InstallHerdrRelease(ctx context.Context, targetPath string, opts Options) error {
	o := opts.withDefaults()
	platform := o.nodePlatform()
	if strings.TrimSpace(targetPath) == "" {
		targetPath = ResolveHerdrPath(o)
	}
	if strings.TrimSpace(targetPath) == "" {
		return &releaseError{Code: "herdr_target_unavailable", Message: "无法确定 Herdr 安装目标路径"}
	}
	osName := map[string]string{"darwin": "macos", "linux": "linux", "win32": "windows"}[platform]
	goArch := toGoArch(o.Arch)
	relArch := ""
	if platform == "win32" {
		if goArch == "amd64" || goArch == "arm64" {
			relArch = "x86_64"
		}
	} else if goArch == "amd64" {
		relArch = "x86_64"
	} else if goArch == "arm64" {
		relArch = "aarch64"
	}
	if osName == "" || relArch == "" {
		return &releaseError{Code: "herdr_unsupported_platform", Message: "当前平台或架构不支持 Herdr"}
	}
	manifestBytes, err := downloadBytes(ctx, o.HTTPClient, herdrManifestURL, "application/json", maxReleaseMetaBytes)
	if err != nil {
		return err
	}
	var manifest struct {
		Version string            `json:"version"`
		Assets  map[string]string `json:"assets"`
		SHA256  map[string]string `json:"sha256"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return err
	}
	key := osName + "-" + relArch
	assetURL := strings.TrimSpace(manifest.Assets[key])
	checksum := strings.ToLower(strings.TrimSpace(manifest.SHA256[key]))
	if !isOfficialHerdrAssetURL(assetURL) || !sha256HexRx.MatchString(checksum) {
		return &releaseError{Code: "herdr_release_manifest_invalid", Message: "Herdr 发布清单无效"}
	}
	bytesData, err := downloadBytes(ctx, o.HTTPClient, assetURL, "application/octet-stream", maxArchiveFileBytes)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(bytesData)
	if hex.EncodeToString(sum[:]) != checksum {
		return &releaseError{Code: "herdr_checksum_mismatch", Message: "Herdr 安装包 SHA256 校验不一致"}
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	if platform == "win32" {
		return installHerdrWindowsZip(bytesData, targetPath)
	}
	staging := targetPath + ".aih-" + randomHex(6)
	if err := os.WriteFile(staging, bytesData, 0o755); err != nil {
		return err
	}
	defer func() { _ = os.Remove(staging) }()
	verRes := o.Exec.Run(ctx, staging, []string{"--version"}, environment.ExecOptions{Timeout: 10 * time.Second})
	if !verRes.OK || !strings.Contains(verRes.Stdout, "herdr "+manifest.Version) {
		return &releaseError{Code: "herdr_binary_verification_failed", Message: "Herdr 二进制版本校验失败"}
	}
	return os.Rename(staging, targetPath)
}

func installHerdrWindowsZip(archive []byte, targetPath string) error {
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return err
	}
	herdrCount := 0
	targetDir := filepath.Dir(targetPath)
	stagingDir := targetDir + ".aih-" + randomHex(6)
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(stagingDir)

	var relFiles []string
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		cleanRel := filepath.Clean(f.Name)
		if cleanRel == "." || strings.HasPrefix(cleanRel, "..") || filepath.IsAbs(cleanRel) {
			continue
		}
		if strings.EqualFold(filepath.Base(cleanRel), "herdr.exe") {
			herdrCount++
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxArchiveFileBytes))
		_ = rc.Close()
		if err != nil {
			return err
		}
		dest := filepath.Join(stagingDir, cleanRel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, data, 0o755); err != nil {
			return err
		}
		relFiles = append(relFiles, cleanRel)
	}
	if herdrCount != 1 {
		return &releaseError{Code: "herdr_archive_binary_ambiguous", Message: "Herdr Windows 压缩包结构异常"}
	}
	for _, rel := range relFiles {
		staged := filepath.Join(stagingDir, rel)
		dst := filepath.Join(targetDir, rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := replaceInstalledFile(staged, dst); err != nil {
			return err
		}
	}
	return nil
}

func replaceInstalledFile(staged string, dst string) error {
	err := os.Rename(staged, dst)
	if err == nil {
		return nil
	}
	if _, statErr := os.Stat(dst); statErr != nil {
		return err
	}
	backup := dst + ".aih-old-" + randomHex(6)
	if err := os.Rename(dst, backup); err != nil {
		return err
	}
	if err := os.Rename(staged, dst); err != nil {
		_ = os.Rename(backup, dst)
		return err
	}
	_ = os.Remove(backup)
	return nil
}

// NormalizeExternalFrpcPath 验证外部 frpc 可执行文件删除目标安全性。
func NormalizeExternalFrpcPath(executablePath string, opts Options) string {
	o := opts.withDefaults()
	platform := o.nodePlatform()
	candidate := strings.TrimSpace(executablePath)
	if candidate == "" || !envPlatformIsAbs(platform, candidate) {
		return ""
	}
	normalized := envPlatformNormalize(platform, candidate)
	expected := "frpc"
	if platform == "win32" {
		expected = "frpc.exe"
	}
	if !strings.EqualFold(envPlatformBase(platform, normalized), expected) {
		return ""
	}
	return normalized
}

// IsUnsafeCleanupTarget 拒绝根目录或一级系统路径清理请求（对齐 managed-path-cleaner.js）。
func IsUnsafeCleanupTarget(target string) bool {
	cleaned := filepath.Clean(strings.TrimSpace(target))
	if cleaned == "" || cleaned == "." || cleaned == string(filepath.Separator) {
		return true
	}
	vol := filepath.VolumeName(cleaned)
	rest := strings.TrimPrefix(cleaned, vol)
	if rest == "" || rest == string(filepath.Separator) || len(rest) <= 2 {
		return true
	}
	return false
}

// RemoveManagedPaths 安全清理受管文件及目录树。
func RemoveManagedPaths(files []string, trees []string) error {
	for _, f := range files {
		if strings.TrimSpace(f) == "" {
			continue
		}
		if IsUnsafeCleanupTarget(f) {
			return &releaseError{Code: "managed_cleanup_unsafe_target", Message: "不安全的清理目标：" + f}
		}
		info, err := os.Lstat(f)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			return &releaseError{Code: "managed_cleanup_expected_file", Message: "期望为文件而非目录：" + f}
		}
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, tree := range trees {
		if strings.TrimSpace(tree) == "" {
			continue
		}
		if IsUnsafeCleanupTarget(tree) {
			return &releaseError{Code: "managed_cleanup_unsafe_target", Message: "不安全的清理目录：" + tree}
		}
		if err := os.RemoveAll(tree); err != nil {
			return err
		}
	}
	return nil
}
