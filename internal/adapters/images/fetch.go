package images

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/imagedata"
)

// 本文件是图片链接的字节取回器，对应 Node 的 createImageBlobFetcher 与
// image-generation-blob-rehost.js 的取回部分。两处调用方：
//
//   - 透传策略：只取回与账号上游同源的链接（那条链接是运营方自己配的上游，可能本来就在私网，
//     因此带账号自己的鉴权头、允许私网地址）；
//   - 图片入口：流式事件只能带 b64_json，对剩下的匿名链接取一次（不带任何凭据，禁私网）。

// maxFetchBytes 与上游响应体同一天花板：取回的字节最终还要再编码成 base64 放进响应/事件。
const maxFetchBytes int64 = maxUpstreamBodyBytes

// errPrivateAddress 表示匿名取回被私网地址闸门拒绝。
var errPrivateAddress = errors.New("image fetch targets a private address")

// ImageFetcher 取回上游图片链接的字节。
type ImageFetcher interface {
	Fetch(ctx context.Context, rawURL string, options FetchOptions) (FetchedImage, error)
}

// FetchOptions 声明一次取回的边界；零值即「匿名、禁私网、默认超时、默认上限」。
type FetchOptions struct {
	// Headers 只发往账号自己的上游源（同源路径）；匿名路径必须留空。
	Headers http.Header
	// Timeout 为 0 时使用图片上游时限。
	Timeout time.Duration
	// MaxBytes 为 0 时使用 maxFetchBytes。
	MaxBytes int64
	// AllowPrivate 只对「与账号上游同源」的链接打开：那条链接是运营方自己配的上游，
	// 可能本来就在私网。匿名路径必须保持 false。
	AllowPrivate bool
}

// FetchedImage 是一次取回的结果。
type FetchedImage struct {
	Bytes []byte
	MIME  imagedata.MIME
}

// Fetcher 是唯一的取回实现：client 走宿主注入的客户端（同源、可私网），
// guarded 是自建的拨号闸门客户端（匿名、禁私网）。
type Fetcher struct {
	client  HTTPDoer
	guarded HTTPDoer
}

// NewFetcher 创建取回器；client 为 nil 时退回 http.DefaultClient。
func NewFetcher(client HTTPDoer) Fetcher {
	if client == nil {
		client = http.DefaultClient
	}
	return Fetcher{client: client, guarded: guardedClient()}
}

// Fetch 取回一张图片的字节。
func (fetcher Fetcher) Fetch(
	ctx context.Context,
	rawURL string,
	options FetchOptions,
) (FetchedImage, error) {
	target := NormalizeImageOutputURL(rawURL)
	if target == "" {
		return FetchedImage{}, newError(502, "invalid_image_output_url", "upstream image url is not fetchable")
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = upstreamTimeout()
	}
	limit := options.MaxBytes
	if limit <= 0 {
		limit = maxFetchBytes
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return FetchedImage{}, newError(502, "image_fetch_failed", "image fetch request is not constructable")
	}
	for key, values := range options.Headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	request.Header.Set("Accept", "image/*")

	doer := fetcher.guarded
	if options.AllowPrivate {
		doer = fetcher.client
	}
	if doer == nil {
		return FetchedImage{}, newError(502, "image_fetch_failed", "image fetch transport is not configured")
	}
	response, err := doer.Do(request)
	if err != nil {
		if errors.Is(err, errPrivateAddress) {
			return FetchedImage{}, newError(502, "image_fetch_forbidden", "image fetch targets a private address")
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return FetchedImage{}, upstreamTimeoutError("image fetch did not finish")
		}
		return FetchedImage{}, newError(502, "image_fetch_failed", "image fetch failed: "+err.Error())
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return FetchedImage{}, newError(
			502,
			"image_fetch_failed",
			"image fetch returned HTTP "+response.Status,
		)
	}
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if readErr != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return FetchedImage{}, upstreamTimeoutError("image fetch body read did not finish")
		}
		return FetchedImage{}, newError(502, "image_fetch_failed", "image fetch body is not readable")
	}
	if int64(len(payload)) > limit {
		return FetchedImage{}, newError(502, "image_fetch_too_large", "fetched image exceeds the size limit")
	}
	mime := imagedata.DetectMIME(payload)
	if !imagedata.IsSupportedMIME(mime) {
		return FetchedImage{}, newError(502, "image_fetch_failed", "fetched bytes are not a supported image")
	}
	return FetchedImage{Bytes: payload, MIME: mime}, nil
}

// sameOrigin 判断两个地址是否同源（scheme + host + 有效端口）。
func sameOrigin(left string, right string) bool {
	leftURL, err := url.Parse(strings.TrimSpace(left))
	if err != nil || leftURL.Host == "" {
		return false
	}
	rightURL, err := url.Parse(strings.TrimSpace(right))
	if err != nil || rightURL.Host == "" {
		return false
	}
	return strings.EqualFold(leftURL.Scheme, rightURL.Scheme) &&
		strings.EqualFold(leftURL.Host, rightURL.Host)
}

// guardedClient 返回禁私网的匿名取回客户端。
//
// 闸门放在拨号层（Control），校验的是实际要连的 IP，因此 DNS rebinding 也拦得住；
// Proxy 必须为 nil，否则拨号目标是代理，闸门看不到真实目标。
func guardedClient() *http.Client {
	dialer := &net.Dialer{
		Timeout: 30 * time.Second,
		Control: func(network string, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(host)
			if ip == nil || isPrivateAddress(ip) {
				return errPrivateAddress
			}
			return nil
		},
	}
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: upstreamTimeout(),
		},
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many image fetch redirects")
			}
			return nil
		},
	}
}

// isPrivateAddress 判断地址是否落在私网、回环、链路本地或未指定段。
func isPrivateAddress(ip net.IP) bool {
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() ||
		ip.IsUnspecified() ||
		ip.IsMulticast()
}
