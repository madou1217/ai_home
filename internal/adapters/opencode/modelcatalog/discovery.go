// Package modelcatalog discovers the OpenCode Go subscription catalog without
// starting the local CLI. Free/CLI-gated Zen models intentionally stay Node-owned.
package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
)

const maxResponseBytes = 1 << 20

var (
	ErrInvalidDependencies   = errors.New("OpenCode 模型目录源依赖无效")
	ErrProviderMismatch      = errors.New("OpenCode 模型目录源凭据归属不符")
	ErrUnsupportedCredential = errors.New("OpenCode 模型目录源凭据形态不支持")
	ErrEmptyCatalog          = errors.New("OpenCode 模型目录响应不含模型清单")
)

type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type Source struct{ client HTTPClient }

var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

func New(client HTTPClient) (*Source, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Source{client: client}, nil
}

func (source *Source) ProviderID() string { return opencoderelay.ProviderID }

func (source *Source) DiscoverModels(ctx context.Context, credential accountapp.Credential) ([]string, error) {
	if source == nil || source.client == nil || ctx == nil || credential == nil {
		return nil, ErrInvalidDependencies
	}
	if credential.ProviderID() != opencoderelay.ProviderID {
		return nil, ErrProviderMismatch
	}
	if !opencoderelay.SupportsCredential(credential) {
		return nil, ErrUnsupportedCredential
	}
	token, err := opencoderelay.AccessTokenFromCredential(credential)
	if err != nil {
		return nil, ErrUnsupportedCredential
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, opencoderelay.GoBaseURL+"/models", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("OpenCode 模型清单请求失败: HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > maxResponseBytes {
		return nil, ErrEmptyCatalog
	}
	models := parseModels(payload)
	if len(models) == 0 {
		return nil, ErrEmptyCatalog
	}
	return models, nil
}

func parseModels(payload []byte) []string {
	var document struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return nil
	}
	models := make([]string, 0, len(document.Data))
	seen := make(map[string]struct{}, len(document.Data))
	for _, item := range document.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		lower := strings.ToLower(id)
		if strings.HasPrefix(lower, "opencode-go/") {
			id = id[len("opencode-go/"):]
		}
		if strings.HasPrefix(strings.ToLower(id), "opencode/") {
			id = id[len("opencode/"):]
		}
		id = "opencode-go/" + strings.TrimSpace(id)
		if id == "opencode-go/" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, id)
	}
	return models
}
