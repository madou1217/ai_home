package requirementruntime

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

// sendPeer 把需求任务写入 peer 收件箱并立即投递到刚创建的 chat 会话。
// peer 投递失败时返回错误，由调用方决定是否直接派发 turn。
func (dispatcher *WorkDispatcher) sendPeer(ctx context.Context, sessionID, provider, title, prompt string) (string, error) {
	if strings.TrimSpace(dispatcher.AIHomeDir) == "" {
		return "", fmt.Errorf("peer_store_home_missing")
	}
	store := peer.NewDispatchStore(dispatcher.AIHomeDir, peer.StoreOptions{})
	from := peer.RecordParty{
		Channel:  "requirements",
		Provider: "aih",
		Name:     "需求调度器",
		Address:  "requirements-scheduler",
	}
	to := peer.RecordParty{
		Channel:   "webui-chat",
		Provider:  provider,
		Name:      title,
		Address:   sessionID,
		SessionID: sessionID,
	}
	record, err := store.CreateMessageDeduplicated(peer.CreateMessageInput{
		From:        from,
		To:          to,
		Body:        prompt,
		Subject:     "[需求] " + title,
		Summary:     "需求调度器派发执行任务",
		Purpose:     "requirement.dispatch",
		Action:      "execute",
		ReplyPolicy: "none",
		FromMode:    "server",
		NoEnvelope:  true,
		Priority:    peer.PriorityNormal,
	}, 30*time.Second)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	options := peer.DeliveryOptions{
		AIHomeDir:     dispatcher.AIHomeDir,
		HostHomeDir:   dispatcher.HostHomeDir,
		Getenv:        os.Getenv,
		HTTPClient:    client,
		ServerBaseURL: dispatcher.SelfBaseURL,
		ManagementKey: dispatcher.ManagementKey,
		NoEnvelope:    true,
	}
	if record.State != "pending" || record.NotificationState != "ready" {
		return record.ID, nil
	}
	claimed, ok, err := store.Claim(record.ID)
	if err != nil {
		return record.ID, err
	}
	if !ok {
		return record.ID, nil
	}
	result := peer.DeliverRecord(ctx, *claimed, options)
	switch {
	case result.OK:
		_, _ = store.SettleDeliveryResult(claimed, result)
		return record.ID, nil
	case peer.IsTerminalDeliveryError(result.Error):
		_, _ = store.SettleFailed(claimed, result.Error)
	default:
		_, _ = store.SettlePending(claimed, result.Error, peer.BackoffFor(peer.DeliveryFailureCount(*claimed)+1))
	}
	message := strings.TrimSpace(result.Message)
	if message == "" {
		message = result.Error
	}
	return record.ID, fmt.Errorf("peer_delivery_failed: %s", message)
}
