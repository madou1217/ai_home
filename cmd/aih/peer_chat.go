package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

func listPeerChatTargets(ctx context.Context, runtime commandRuntime) []peer.Target {
	key := envValue(runtime, "AIH_SERVER_MANAGEMENT_KEY")
	if key == "" {
		return nil
	}
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(probe, http.MethodGet, strings.TrimRight(resolveManagementBaseURL(runtime), "/")+"/v1/management/webui/chat/sessions", nil)
	if err != nil {
		return nil
	}
	request.Header.Set("Authorization", "Bearer "+key)
	response, err := runtime.managementAPI.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	var result struct {
		Sessions []struct {
			ID       string `json:"sessionId"`
			Provider string `json:"provider"`
			State    string `json:"state"`
			Path     string `json:"projectPath"`
			Policy   struct {
				Title string `json:"title"`
			} `json:"policy"`
		} `json:"sessions"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024)).Decode(&result) != nil {
		return nil
	}
	targets := []peer.Target{}
	for _, session := range result.Sessions {
		if session.ID == "" || session.State == "closed" {
			continue
		}
		name := session.Policy.Title
		if name == "" {
			name = session.ID
		}
		targets = append(targets, peer.Target{ID: "chat:" + session.ID, RecordParty: peer.RecordParty{Channel: "webui-chat", Provider: session.Provider, Name: name, Address: session.ID, SessionID: session.ID}, CWD: session.Path, Status: session.State})
	}
	return targets
}
