package harnessrun

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

const modelsCatalogPath = "/v1/management/webui/openai-models/catalog"

// Only decode the public model projection. Account profile, pricing and other
// catalog fields are intentionally not forwarded to CLI output.
type publishedModelsCatalog struct {
	OK         bool                `json:"ok"`
	UpdatedAt  int64               `json:"updatedAt"`
	Data       []ListedModel       `json:"data"`
	ByProvider map[string][]string `json:"byProvider"`
}

func readModelsCatalog(ctx context.Context, client managementapi.HTTPClient, config managementapi.Config, accountRef string) (publishedModelsCatalog, error) {
	var catalog publishedModelsCatalog
	// Config was validated by managementapi.New: root HTTP(S) URL, no userinfo,
	// query or fragment. Credentials belong only in the Authorization header.
	endpoint := strings.TrimRight(config.BaseURL, "/") + modelsCatalogPath
	if accountRef != "" {
		endpoint += "?" + url.Values{"accountRef": {accountRef}}.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return catalog, fmt.Errorf("models_catalog_request_invalid")
	}
	request.Header.Set("Authorization", "Bearer "+config.ManagementKey)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return catalog, fmt.Errorf("models_catalog_unavailable: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		// Do not print arbitrary upstream bodies: they may contain credentials.
		return catalog, fmt.Errorf("models_catalog_http_%d", response.StatusCode)
	}
	const maximumBytes = 16 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumBytes+1))
	if err != nil || len(body) > maximumBytes {
		return catalog, fmt.Errorf("models_catalog_read_failed")
	}
	if json.Unmarshal(body, &catalog) != nil || !catalog.OK || catalog.Data == nil {
		return catalog, fmt.Errorf("models_catalog_response_invalid")
	}
	return catalog, nil
}
