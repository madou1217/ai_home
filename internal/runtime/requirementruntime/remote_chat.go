package requirementruntime

import (
	"bufio"
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

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

// ServerProfile is the resolved management connection to another AIH Server.
// The key never leaves this process and is never returned to the browser.
type ServerProfile struct {
	ID            string
	Label         string
	Endpoint      string
	ManagementKey string
}

// ServerProfileResolver loads a saved control-plane profile by id.
type ServerProfileResolver interface {
	Resolve(ctx context.Context, profileID string) (ServerProfile, error)
}

// RemoteChatFactory creates a chat-session port bound to one target Server.
type RemoteChatFactory struct {
	Profiles   ServerProfileResolver
	HTTPClient *http.Client
}

// For resolves the profile and returns a port for its management chat API.
func (factory *RemoteChatFactory) For(ctx context.Context, profileID string) (*RemoteChatSession, error) {
	if factory == nil || factory.Profiles == nil {
		return nil, fmt.Errorf("remote_chat_unavailable")
	}
	profile, err := factory.Profiles.Resolve(ctx, profileID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(profile.Endpoint) == "" || strings.TrimSpace(profile.ManagementKey) == "" {
		return nil, fmt.Errorf("remote_server_profile_incomplete")
	}
	client := factory.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &RemoteChatSession{
		profile: profile,
		baseURL: strings.TrimRight(strings.TrimSpace(profile.Endpoint), "/"),
		key:     strings.TrimSpace(profile.ManagementKey),
		client:  client,
	}, nil
}

// RemoteChatSession implements ChatSessionPort against another AIH Server.
type RemoteChatSession struct {
	profile ServerProfile
	baseURL string
	key     string
	client  *http.Client
}

func (remote *RemoteChatSession) Profile() ServerProfile { return remote.profile }

func (remote *RemoteChatSession) CreateSession(ctx context.Context, in chatruntime.CreateSessionInput) (*chatruntime.Session, error) {
	var response struct {
		OK      bool                `json:"ok"`
		Session chatruntime.Session `json:"session"`
		Error   string              `json:"error"`
		Message string              `json:"message"`
	}
	if err := remote.doJSON(ctx, http.MethodPost, "/v1/management/webui/chat/sessions", in, &response); err != nil {
		return nil, err
	}
	if strings.TrimSpace(response.Session.SessionID) == "" {
		return nil, fmt.Errorf("remote_chat_session_missing")
	}
	return &response.Session, nil
}

func (remote *RemoteChatSession) DispatchCommand(ctx context.Context, sessionID string, input map[string]any) (map[string]any, error) {
	var response map[string]any
	if err := remote.doJSON(ctx, http.MethodPost, remote.sessionPath(sessionID)+"/commands", input, &response); err != nil {
		return nil, err
	}
	return response, nil
}

func (remote *RemoteChatSession) GetSnapshot(ctx context.Context, sessionID string) (*chatruntime.Snapshot, error) {
	var response struct {
		OK       bool                  `json:"ok"`
		Snapshot *chatruntime.Snapshot `json:"snapshot"`
		Error    string                `json:"error"`
		Message  string                `json:"message"`
	}
	if err := remote.doJSON(ctx, http.MethodGet, remote.sessionPath(sessionID)+"/snapshot", nil, &response); err != nil {
		return nil, err
	}
	if response.Snapshot == nil {
		return nil, fmt.Errorf("remote_chat_snapshot_missing")
	}
	return response.Snapshot, nil
}

// Subscribe opens the target Server's canonical SSE stream and forwards events.
// A dropped connection reconnects from the last observed sequence; a cancelled
// subscription stops without reopening it.
func (remote *RemoteChatSession) Subscribe(sessionID string, listener chatruntime.EventListener) (func(), error) {
	if remote == nil || remote.client == nil || strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("remote_chat_subscribe_unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	go remote.streamLoop(ctx, sessionID, listener)
	return cancel, nil
}

func (remote *RemoteChatSession) streamLoop(ctx context.Context, sessionID string, listener chatruntime.EventListener) {
	var lastSeq int64
	for ctx.Err() == nil {
		lastSeq = remote.streamOnce(ctx, sessionID, lastSeq, listener)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (remote *RemoteChatSession) streamOnce(ctx context.Context, sessionID string, after int64, listener chatruntime.EventListener) int64 {
	requestURL := remote.baseURL + remote.sessionPath(sessionID) + "/events"
	if after > 0 {
		requestURL += "?after=" + url.QueryEscape(fmt.Sprintf("%d", after))
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return after
	}
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Authorization", "Bearer "+remote.key)
	client := &http.Client{}
	response, err := client.Do(request)
	if err != nil {
		return after
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return after
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var data strings.Builder
	flush := func() {
		if data.Len() == 0 {
			return
		}
		var event chatruntime.EventEnvelope
		if json.Unmarshal([]byte(data.String()), &event) == nil {
			if event.Seq > after {
				after = event.Seq
			}
			if listener != nil {
				listener(event)
			}
		}
		data.Reset()
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	flush()
	return after
}

func (remote *RemoteChatSession) ResolveAccount(ctx context.Context, provider, model string) (string, error) {
	if remote == nil {
		return "", fmt.Errorf("remote_chat_unavailable")
	}
	query := url.Values{}
	if value := strings.TrimSpace(provider); value != "" {
		query.Set("provider", value)
	}
	if value := strings.TrimSpace(model); value != "" {
		query.Set("model", value)
	}
	requestURL := remote.baseURL + "/v1/management/webui/remote-targets"
	if encoded := query.Encode(); encoded != "" {
		requestURL += "?" + encoded
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+remote.key)
	response, err := remote.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", decodeRemoteChatError(response.StatusCode, raw)
	}
	var payload struct {
		Candidates []struct {
			Account struct {
				AccountRef string `json:"accountRef"`
			} `json:"account"`
		} `json:"candidates"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return "", fmt.Errorf("remote_targets_invalid_response")
	}
	for _, candidate := range payload.Candidates {
		if value := strings.TrimSpace(candidate.Account.AccountRef); value != "" {
			return value, nil
		}
	}
	return "", fmt.Errorf("远程 Server 没有支持 %s / %s 的可用账号", provider, model)
}

// StartMirror asks the target Server to materialize one connector workspace.
// The returned path is on the target host and is the project path for the
// remote work session.
func (remote *RemoteChatSession) StartMirror(ctx context.Context, workspaceID string) (MirrorInfo, error) {
	var envelope mirrorEnvelope
	if err := remote.doJSON(ctx, http.MethodPost, "/v1/management/webui/workspace-connectors/"+url.PathEscape(strings.TrimSpace(workspaceID))+"/mirror", map[string]any{}, &envelope); err != nil {
		return MirrorInfo{}, err
	}
	if strings.TrimSpace(envelope.Mirror.Path) == "" {
		return MirrorInfo{}, fmt.Errorf("remote_workspace_mirror_path_missing")
	}
	return envelope.Mirror, nil
}

// SyncMirror writes the remote mirror changes back to the target connector.
func (remote *RemoteChatSession) SyncMirror(ctx context.Context, workspaceID, mirrorID string) (MirrorSyncResult, error) {
	var envelope mirrorEnvelope
	path := "/v1/management/webui/workspace-connectors/" + url.PathEscape(strings.TrimSpace(workspaceID)) +
		"/mirror/" + url.PathEscape(strings.TrimSpace(mirrorID)) + "/sync"
	if err := remote.doJSON(ctx, http.MethodPost, path, map[string]any{}, &envelope); err != nil {
		return MirrorSyncResult{}, err
	}
	if envelope.Result == nil {
		return MirrorSyncResult{}, fmt.Errorf("remote_workspace_mirror_sync_missing")
	}
	return *envelope.Result, nil
}

// RemoveMirror deletes a remote mirror after a failed dispatch.
func (remote *RemoteChatSession) RemoveMirror(ctx context.Context, workspaceID, mirrorID string) error {
	path := "/v1/management/webui/workspace-connectors/" + url.PathEscape(strings.TrimSpace(workspaceID)) +
		"/mirror/" + url.PathEscape(strings.TrimSpace(mirrorID))
	return remote.doJSON(ctx, http.MethodDelete, path, nil, nil)
}

func (remote *RemoteChatSession) sessionPath(sessionID string) string {
	return "/v1/management/webui/chat/sessions/" + url.PathEscape(strings.TrimSpace(sessionID))
}

func (remote *RemoteChatSession) doJSON(ctx context.Context, method, path string, body any, destination any) error {
	if remote == nil || remote.client == nil || remote.baseURL == "" {
		return fmt.Errorf("remote_chat_unavailable")
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, remote.baseURL+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+remote.key)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := remote.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return decodeRemoteChatError(response.StatusCode, raw)
	}
	if destination == nil {
		return nil
	}
	if err := json.Unmarshal(raw, destination); err != nil {
		return errors.Join(fmt.Errorf("remote_chat_invalid_response"), err)
	}
	return nil
}

func decodeRemoteChatError(status int, raw []byte) error {
	var payload struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
	}
	_ = json.Unmarshal(raw, &payload)
	code := ""
	var flat string
	if json.Unmarshal(payload.Error, &flat) == nil {
		code = flat
	} else {
		var nested struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(payload.Error, &nested) == nil {
			code = nested.Code
			if strings.TrimSpace(payload.Message) == "" {
				payload.Message = nested.Message
			}
		}
	}
	if strings.TrimSpace(code) == "" {
		code = "remote_chat_request_failed"
	}
	if strings.TrimSpace(payload.Message) == "" {
		payload.Message = fmt.Sprintf("remote chat returned HTTP %d", status)
	}
	return fmt.Errorf("%s: %s", code, strings.TrimSpace(payload.Message))
}

// Ensure the interface stays aligned with the canonical runtime subset.
var _ ChatSessionPort = (*RemoteChatSession)(nil)
