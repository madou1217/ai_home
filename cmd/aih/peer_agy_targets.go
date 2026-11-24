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

// listAGYSessionTargets 把常驻 AGY 会话纳入 peer 目标表，与 chat 会话并列。
// 一个会话对应一条需求，因此 Channel 固定为 agy-session；发送走
// /v1/management/agy-sessions/{id}/messages，与 `aih agy session say` 同源。
func listAGYSessionTargets(ctx context.Context, runtime commandRuntime) []peer.Target {
	key := envValue(runtime, "AIH_SERVER_MANAGEMENT_KEY")
	if key == "" {
		return nil
	}
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(probe, http.MethodGet,
		strings.TrimRight(resolveManagementBaseURL(runtime), "/")+"/v1/management/agy-sessions", nil)
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
			ID         string `json:"id"`
			Title      string `json:"title"`
			Status     string `json:"status"`
			RemoteRoot string `json:"remoteRoot"`
		} `json:"sessions"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4*1024*1024)).Decode(&result) != nil {
		return nil
	}
	targets := []peer.Target{}
	for _, session := range result.Sessions {
		if session.ID == "" || session.Status == "closed" {
			continue
		}
		name := session.Title
		if name == "" {
			name = session.ID
		}
		targets = append(targets, peer.Target{
			ID: "agy-session:" + session.ID,
			RecordParty: peer.RecordParty{
				Channel: "agy-session", Provider: "agy", Name: name, Address: session.ID, SessionID: session.ID,
			},
			CWD:    session.RemoteRoot,
			Status: session.Status,
		})
	}
	return targets
}
