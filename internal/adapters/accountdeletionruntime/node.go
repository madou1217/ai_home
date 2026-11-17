package accountdeletionruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
)

const nodePath = "/v0/internal/accounts/deletion-runtime"

var validNodeLease = regexp.MustCompile(`^[a-f0-9]{64}$`)

// NodeOwner bridges only resources still held in the private Node process. A
// configured but unavailable Node is unknown, not evidence that it has no work.
type NodeOwner struct {
	AIHomeDir     string
	BaseURL       string
	ManagementKey func() string
}

func (o NodeOwner) Inspect(ctx context.Context, a accountcore.Account) ([]accountapp.DeletionBlocker, error) {
	action := "inspect"
	if state, _ := ctx.Value(stateKey{}).(*requestState); state != nil && state.nodeLease == "" {
		action = "begin"
	}
	response, err := o.call(ctx, a, action)
	return response.Occupants, err
}
func (o NodeOwner) Release(ctx context.Context, a accountcore.Account) error {
	_, err := o.call(ctx, a, "release")
	return err
}
func (o NodeOwner) Prepare(ctx context.Context, a accountcore.Account) error {
	_, err := o.call(ctx, a, "prepare")
	return err
}
func (o NodeOwner) Finish(ctx context.Context, a accountcore.Account, committed bool) error {
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil || state.nodeLease == "" {
		return nil
	}
	action := "cancel"
	if committed {
		action = "complete"
	}
	_, err := o.call(ctx, a, action)
	return err
}

type nodeResponse struct {
	OK        bool                         `json:"ok"`
	Lease     string                       `json:"lease"`
	Prepared  bool                         `json:"prepared"`
	ExpiresAt *int64                       `json:"expiresAt"`
	Occupants []accountapp.DeletionBlocker `json:"occupants"`
	Error     string                       `json:"error"`
}

func (o NodeOwner) call(ctx context.Context, a accountcore.Account, action string) (nodeResponse, error) {
	var out nodeResponse
	if strings.TrimSpace(o.BaseURL) == "" {
		return nodeResponse{OK: true}, nil
	}
	parsed, err := url.Parse(o.BaseURL)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return out, accountapp.ErrAccountRuntimeUnverifiable
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip == nil || !ip.IsLoopback() || parsed.Port() == "" || o.ManagementKey == nil || o.ManagementKey() == "" {
		return out, accountapp.ErrAccountRuntimeUnverifiable
	}
	table, err := accountrefmap.LoadStrict(ctx, o.AIHomeDir)
	if err != nil {
		return out, errors.Join(accountapp.ErrAccountRuntimeUnverifiable, err)
	}
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil {
		return out, accountapp.ErrAccountRuntimeUnverifiable
	}
	payload := map[string]string{"action": action, "provider": a.ProviderID(), "accountRef": table.NodeRef(a.Ref().String())}
	if state.nodeLease != "" {
		payload["lease"] = state.nodeLease
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return out, err
	}
	op, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(op, http.MethodPost, strings.TrimRight(o.BaseURL, "/")+nodePath, bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	request.Header.Set("Authorization", "Bearer "+o.ManagementKey())
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return out, errors.Join(accountapp.ErrAccountRuntimeUnverifiable, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return out, accountapp.ErrAccountRuntimeUnverifiable
	}
	if err = json.Unmarshal(raw, &out); err != nil || response.StatusCode != http.StatusOK || !out.OK {
		return out, fmt.Errorf("%w: private runtime action %s status=%d", accountapp.ErrAccountRuntimeUnverifiable, action, response.StatusCode)
	}
	// Retain the issued capability even if a later validity check fails so the
	// coordinator's finally can release that exact lease instead of waiting TTL.
	if validNodeLease.MatchString(out.Lease) && (state.nodeLease == "" || state.nodeLease == out.Lease) {
		state.nodeLease = out.Lease
	}
	if action != "cancel" && action != "complete" {
		if !validNodeLease.MatchString(out.Lease) || (state.nodeLease != "" && state.nodeLease != out.Lease) {
			return out, accountapp.ErrAccountRuntimeUnverifiable
		}
		if action == "prepare" && !out.Prepared {
			return out, accountapp.ErrAccountRuntimeUnverifiable
		}
		if !out.Prepared && (out.ExpiresAt == nil || *out.ExpiresAt <= time.Now().Add(5*time.Second).UnixMilli()) {
			return out, accountapp.ErrAccountRuntimeUnverifiable
		}
	}
	if out.Lease != "" {
		state.nodeLease = out.Lease
	}
	for i := range out.Occupants {
		out.Occupants[i].Provider = a.ProviderID()
		out.Occupants[i].AccountRef = a.Ref().String()
	}
	return out, nil
}
