package requirementruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// MirrorClient talks to the Server-local workspace connector mirror endpoint.
// It is intentionally HTTP-based so the scheduler does not need the connector
// store or hub and can run in the same process as the management surface.
type MirrorClient struct {
	BaseURL       func() string
	ManagementKey func() string
	HTTPClient    *http.Client
}

type MirrorInfo struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Root        string   `json:"root"`
	Path        string   `json:"path"`
	Files       int      `json:"files"`
	Bytes       int64    `json:"bytes"`
	Skipped     []string `json:"skipped,omitempty"`
	CreatedAt   int64    `json:"createdAt"`
}

type MirrorSyncResult struct {
	Written   int      `json:"written"`
	Deleted   int      `json:"deleted"`
	Unchanged int      `json:"unchanged"`
	Conflicts int      `json:"conflicts"`
	Errors    int      `json:"errors"`
	Skipped   int      `json:"skipped"`
	Messages  []string `json:"messages,omitempty"`
}

type mirrorEnvelope struct {
	OK          bool              `json:"ok"`
	WorkspaceID string            `json:"workspaceId"`
	Mirror      MirrorInfo        `json:"mirror"`
	Result      *MirrorSyncResult `json:"result"`
	Error       string            `json:"error"`
	Message     string            `json:"message"`
}

func (client *MirrorClient) Start(ctx context.Context, workspaceID string) (MirrorInfo, error) {
	var envelope mirrorEnvelope
	if err := client.do(ctx, http.MethodPost, "/mirror", workspaceID, "", &envelope); err != nil {
		return MirrorInfo{}, err
	}
	if strings.TrimSpace(envelope.Mirror.Path) == "" {
		return MirrorInfo{}, fmt.Errorf("workspace mirror response has no path")
	}
	return envelope.Mirror, nil
}

func (client *MirrorClient) Sync(ctx context.Context, workspaceID, mirrorID string) (MirrorSyncResult, error) {
	var envelope mirrorEnvelope
	if err := client.do(ctx, http.MethodPost, "/mirror/"+url.PathEscape(mirrorID)+"/sync", workspaceID, "", &envelope); err != nil {
		return MirrorSyncResult{}, err
	}
	if envelope.Result == nil {
		return MirrorSyncResult{}, fmt.Errorf("workspace mirror response has no sync result")
	}
	return *envelope.Result, nil
}

func (client *MirrorClient) Remove(ctx context.Context, workspaceID, mirrorID string) error {
	return client.do(ctx, http.MethodDelete, "/mirror/"+url.PathEscape(mirrorID), workspaceID, "", nil)
}

func (client *MirrorClient) do(ctx context.Context, method, suffix, workspaceID, body string, destination any) error {
	if client == nil {
		return fmt.Errorf("workspace_mirror_client_unavailable")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(client.BaseURL()), "/")
	workspaceID = strings.TrimSpace(workspaceID)
	if baseURL == "" || workspaceID == "" {
		return fmt.Errorf("workspace_mirror_client_unavailable")
	}
	requestURL := baseURL + "/v1/management/webui/workspace-connectors/" + url.PathEscape(workspaceID) + suffix
	request, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader([]byte(body)))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if key := strings.TrimSpace(client.ManagementKey()); key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Minute}
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure mirrorEnvelope
		_ = json.Unmarshal(raw, &failure)
		code := strings.TrimSpace(failure.Error)
		if code == "" {
			code = "workspace_mirror_failed"
		}
		message := strings.TrimSpace(failure.Message)
		if message == "" {
			message = fmt.Sprintf("workspace mirror returned HTTP %d", response.StatusCode)
		}
		return fmt.Errorf("%s: %s", code, message)
	}
	if destination == nil {
		return nil
	}
	return json.Unmarshal(raw, destination)
}
