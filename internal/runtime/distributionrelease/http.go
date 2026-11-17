package distributionrelease

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxReleaseJSON = int64(4 << 20)
	maxManifest    = int64(1 << 20)
	maxChecksum    = int64(1024)
)

func releaseHTTPClient(input *http.Client) *http.Client {
	client := http.Client{}
	if input != nil {
		client = *input
	}
	client.Jar = nil
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !safeReleaseURL(request.URL) {
			return fmt.Errorf("release redirect rejected")
		}
		first := via[0].URL
		if first.Host == "api.github.com" {
			if request.URL.Host != first.Host || request.URL.EscapedPath() != first.EscapedPath() || request.URL.RawQuery != "" {
				return fmt.Errorf("release metadata redirect rejected")
			}
		} else if request.URL.Host == "api.github.com" || (request.URL.Host == "github.com" && request.URL.EscapedPath() != first.EscapedPath()) {
			return fmt.Errorf("release asset redirect rejected")
		}
		request.Header.Del("Authorization")
		request.Header.Del("Proxy-Authorization")
		request.Header.Del("Cookie")
		request.Header.Del("Referer")
		return nil
	}
	return &client
}

func safeReleaseURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return false
	}
	// Exact hosts only: no ports, suffix matches, arbitrary repositories or URLs.
	switch u.Host {
	case "api.github.com":
		return strings.HasPrefix(u.Path, "/repos/"+DefaultRepository+"/releases/")
	case "github.com":
		return strings.HasPrefix(u.Path, "/"+DefaultRepository+"/releases/download/")
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com":
		return true
	}
	return false
}

func (s *Service) get(ctx context.Context, endpoint, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil || !safeReleaseURL(req.URL) {
		return nil, fmt.Errorf("release endpoint rejected")
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("User-Agent", "ai-home-distribution-release")
	if req.URL.Host == "api.github.com" {
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	response, err := s.client.Do(req)
	if err != nil {
		// url.Error may contain signed redirect URLs. Never expose or cache them.
		var requestError *url.Error
		if errors.As(err, &requestError) {
			err = requestError.Err
		}
		return nil, fmt.Errorf("release request failed: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, fmt.Errorf("release request returned HTTP %d", response.StatusCode)
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		response.Body.Close()
		return nil, fmt.Errorf("%w: unexpected HTTP content encoding", ErrInvalidRelease)
	}
	return response, nil
}

func (s *Service) getBytes(ctx context.Context, endpoint string, limit int64, accept string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	response, err := s.get(ctx, endpoint, accept)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.ContentLength > limit {
		return nil, fmt.Errorf("%w: metadata exceeds size limit", ErrInvalidRelease)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read release metadata: %w", err)
	}
	if int64(len(body)) > limit || (response.ContentLength >= 0 && int64(len(body)) != response.ContentLength) {
		return nil, fmt.Errorf("%w: invalid metadata size", ErrInvalidRelease)
	}
	return body, nil
}

func decodeJSON(body []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: malformed JSON", ErrInvalidRelease)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("%w: trailing JSON", ErrInvalidRelease)
	}
	return nil
}

func assetURL(tag, name string) string {
	// Neither value originates from an incoming download URL. Names are derived
	// from a validated semver and the fixed packaging target matrix.
	return "https://github.com/" + DefaultRepository + "/releases/download/" + url.PathEscape(tag) + "/" + url.PathEscape(name)
}
