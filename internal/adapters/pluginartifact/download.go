package pluginartifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// 服务端下载插件包的硬边界。
const (
	downloadRedirectLimit = 5
	downloadDialTimeout   = 15 * time.Second
	downloadTotalTimeout  = 2 * time.Minute
)

// ErrDownloadBlocked 表示目标解析到内网、回环或保留地址。
var ErrDownloadBlocked = errors.New("下载地址指向内网或保留地址")

// Download 由宿主侧抓取远程插件包，供无法共享文件系统的场景使用。
//
// 只允许 https + 443；重定向最多 5 次且每次重新校验；连接前解析 DNS 并拒绝
// 回环、私网、链路本地、CGNAT、组播与保留网段，避免管理接口被当成 SSRF 跳板。
// 下载落在 0700 临时目录、文件 0600，cleanup 必须在安装结束后调用。
func Download(ctx context.Context, rawURL string, limit int64) (string, func(), error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", nil, pluginerr.New("plugin_download_invalid", "下载地址不合法")
	}
	if err := validateDownloadURL(parsed); err != nil {
		return "", nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, downloadTotalTimeout)
	client := &http.Client{
		Transport: &http.Transport{
			// 服务端下载刻意不走环境代理：代理地址通常是回环，会绕过下面的
			// 目标 IP 校验；远端宿主要求能直连公网 https。
			DialContext:           safeDialContext,
			TLSHandshakeTimeout:   downloadDialTimeout,
			ResponseHeaderTimeout: 30 * time.Second,
			ExpectContinueTimeout: 5 * time.Second,
		},
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) >= downloadRedirectLimit {
				return errors.New("重定向次数过多")
			}
			return validateDownloadURL(next.URL)
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		cancel()
		return "", nil, pluginerr.New("plugin_download_invalid", "下载请求无法创建")
	}
	request.Header.Set("User-Agent", "aih-plugin-install/1")
	response, err := client.Do(request)
	if err != nil {
		cancel()
		return "", nil, pluginerr.New("plugin_download_failed", "下载失败："+err.Error())
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		cancel()
		return "", nil, pluginerr.New("plugin_download_failed", fmt.Sprintf("下载失败：HTTP %d", response.StatusCode))
	}
	if response.ContentLength > limit {
		cancel()
		return "", nil, pluginerr.New("plugin_download_too_large", "插件包超过大小上限")
	}
	dir, err := os.MkdirTemp("", "aih-plugin-download-")
	if err != nil {
		cancel()
		return "", nil, pluginerr.New("plugin_download_failed", "无法创建临时目录")
	}
	cleanup := func() {
		cancel()
		_ = os.RemoveAll(dir)
	}
	target := filepath.Join(dir, "download")
	handle, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		cleanup()
		return "", nil, pluginerr.New("plugin_download_failed", "无法写入临时文件")
	}
	written, copyErr := io.Copy(handle, io.LimitReader(response.Body, limit+1))
	closeErr := handle.Close()
	if copyErr != nil || closeErr != nil {
		cleanup()
		return "", nil, pluginerr.New("plugin_download_failed", "下载中断")
	}
	if written > limit {
		cleanup()
		return "", nil, pluginerr.New("plugin_download_too_large", "插件包超过大小上限")
	}
	return target, cleanup, nil
}

// FileSHA256 返回文件摘要；安装接口用它判断「服务端看到的本地路径」是否就是
// 客户端下载的那一个包。
func FileSHA256(file string) (string, error) {
	handle, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer func() { _ = handle.Close() }()
	digest := sha256.New()
	if _, err := io.Copy(digest, handle); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func validateDownloadURL(candidate *url.URL) error {
	if candidate == nil {
		return pluginerr.New("plugin_download_invalid", "下载地址不合法")
	}
	if candidate.Scheme != "https" {
		return pluginerr.New("plugin_download_insecure", "服务端只允许 https 下载")
	}
	if candidate.User != nil {
		return pluginerr.New("plugin_download_invalid", "下载地址不能包含凭据")
	}
	if port := candidate.Port(); port != "" && port != "443" {
		return pluginerr.New("plugin_download_insecure", "服务端只允许 https 443 端口")
	}
	return nil
}

func safeDialContext(ctx context.Context, network string, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: downloadDialTimeout}
	var lastErr error
	for _, item := range addresses {
		if blockedDownloadIP(item.IP) {
			lastErr = ErrDownloadBlocked
			continue
		}
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(item.IP.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		lastErr = dialErr
	}
	if lastErr == nil {
		lastErr = ErrDownloadBlocked
	}
	return nil, lastErr
}

var blockedDownloadRanges = mustDownloadRanges(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
	"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
	"192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4",
	"::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
)

func mustDownloadRanges(values ...string) []*net.IPNet {
	ranges := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, block, err := net.ParseCIDR(value)
		if err != nil {
			panic("invalid blocked download range: " + value)
		}
		ranges = append(ranges, block)
	}
	return ranges
}

func blockedDownloadIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	for _, block := range blockedDownloadRanges {
		if block.Contains(ip) {
			return true
		}
	}
	return false
}
