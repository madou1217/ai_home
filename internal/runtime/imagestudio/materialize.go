package imagestudio

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/imagedata"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

const defaultRemoteFetchTimeout = 120 * time.Second

func validateImageBytesAndMIME(payload []byte, mimeHint string, revisedPrompt string) (StoredImage, error) {
	if len(payload) < 1 {
		return StoredImage{}, NewError(502, "empty_image_output", "generated image output is empty")
	}
	if len(payload) > MaxStudioAssetBytes {
		return StoredImage{}, NewError(413, "image_asset_too_large", "generated image exceeds 20 MiB limit")
	}
	detected := imagedata.DetectMIME(payload)
	if detected == "" || !imagedata.IsSupportedMIME(detected) {
		return StoredImage{}, NewError(502, "invalid_image_output", "generated image output is not a supported image")
	}
	if strings.TrimSpace(mimeHint) != "" {
		normalizedHint := imagedata.NormalizeMIME(mimeHint)
		if normalizedHint == "" || normalizedHint != detected {
			return StoredImage{}, NewError(502, "invalid_image_output", "generated image mime type does not match its bytes")
		}
	}
	return StoredImage{
		MIME:          string(detected),
		Bytes:         payload,
		RevisedPrompt: strings.TrimSpace(revisedPrompt),
	}, nil
}

func sameURLOrigin(left string, right string) bool {
	u1, err1 := url.Parse(strings.TrimSpace(left))
	u2, err2 := url.Parse(strings.TrimSpace(right))
	if err1 != nil || err2 != nil || u1.Host == "" || u2.Host == "" {
		return false
	}
	return strings.EqualFold(u1.Scheme, u2.Scheme) && strings.EqualFold(u1.Host, u2.Host)
}

func mapFetchErrorToStudioError(err error) *Error {
	if err == nil {
		return nil
	}
	var studioErr *Error
	if errorsAsStudio(err, &studioErr) {
		return studioErr
	}
	if imgErr, ok := images.AsError(err); ok {
		code := imgErr.Code
		switch code {
		case "image_fetch_forbidden":
			code = "image_asset_url_blocked"
		case "image_fetch_too_large":
			return NewError(413, "image_asset_too_large", imgErr.Detail)
		case "image_fetch_failed":
			code = "image_asset_fetch_failed"
		}
		status := imgErr.StatusCode
		if status <= 0 {
			status = 502
		}
		return NewError(status, code, imgErr.Detail)
	}
	return NewError(502, "image_asset_fetch_failed", err.Error())
}

func errorsAsStudio(err error, target **Error) bool {
	if se, ok := err.(*Error); ok {
		*target = se
		return true
	}
	return false
}

// MaterializeOutputs 把上游策略返回的 base64、已重宿主字节或远程 URL 实体化为持久化字节。
func MaterializeOutputs(
	ctx context.Context,
	execution images.Execution,
	fetcher images.ImageFetcher,
	timeout time.Duration,
) ([]StoredImage, error) {
	if len(execution.Result.Images) < 1 {
		return nil, NewError(502, "image_output_missing", "image generation returned no persistent output")
	}
	if timeout <= 0 {
		timeout = defaultRemoteFetchTimeout
	}
	out := make([]StoredImage, 0, len(execution.Result.Images))
	isPassthrough := execution.Strategy != nil && execution.Strategy.Kind() == "passthrough"

	for _, item := range execution.Result.Images {
		revised := strings.TrimSpace(item.RevisedPrompt)
		if len(item.Rehosted) > 0 {
			stored, err := validateImageBytesAndMIME(item.Rehosted, item.MIME, revised)
			if err != nil {
				return nil, err
			}
			out = append(out, stored)
			continue
		}
		if strings.TrimSpace(item.B64JSON) != "" {
			decoded, ok := imagedata.DecodeCanonicalBase64(item.B64JSON)
			if !ok {
				return nil, NewError(502, "invalid_image_output", "generated image output has invalid base64")
			}
			stored, err := validateImageBytesAndMIME(decoded.Bytes, item.MIME, revised)
			if err != nil {
				return nil, err
			}
			out = append(out, stored)
			continue
		}
		if strings.TrimSpace(item.URL) != "" {
			if fetcher == nil {
				fetcher = images.NewFetcher(http.DefaultClient)
			}
			opts := images.FetchOptions{
				Timeout:  timeout,
				MaxBytes: MaxStudioAssetBytes,
			}
			// 仅透传策略且图片链接与账号自身配置的上游同源时允许私网回取并附带账号鉴权。
			if isPassthrough && sameURLOrigin(item.URL, execution.Account.BaseURL) {
				opts.AllowPrivate = true
				headers := make(http.Header)
				if key := strings.TrimSpace(execution.Account.APIKey); key != "" {
					headers.Set("Authorization", "Bearer "+key)
				}
				if tok := strings.TrimSpace(execution.Account.AccessToken); tok != "" && len(headers) == 0 {
					headers.Set("Authorization", "Bearer "+tok)
				}
				opts.Headers = headers
			}
			fetched, fetchErr := fetcher.Fetch(ctx, item.URL, opts)
			if fetchErr != nil {
				return nil, mapFetchErrorToStudioError(fetchErr)
			}
			stored, valErr := validateImageBytesAndMIME(fetched.Bytes, string(fetched.MIME), revised)
			if valErr != nil {
				return nil, valErr
			}
			out = append(out, stored)
			continue
		}
	}

	if len(out) < 1 {
		return nil, NewError(502, "image_output_missing", "image generation returned no persistent output")
	}
	return out, nil
}
