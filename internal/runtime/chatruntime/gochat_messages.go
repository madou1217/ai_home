package chatruntime

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"slices"
	"strings"
)

const gatewayChatInstructions = "You are an AI assistant in AIH Chat. Answer using the conversation and supplied attachments. You have no terminal or local tool access. Do not claim to have executed tools or changed files."

// gatewayUserContent is shared by current input and persisted history. Files
// reach this boundary only after the session-owned attachment lookup.
func gatewayUserContent(session *Session, content string, paths []string) (any, error) {
	input, err := SessionAttachmentTurnInput(session, content, paths)
	if err != nil {
		return nil, err
	}
	if len(input.ImagePaths) == 0 {
		return input.Prompt, nil
	}
	parts := make([]any, 0, len(input.ImagePaths)+1)
	if input.Prompt != "" {
		parts = append(parts, map[string]any{"type": "text", "text": input.Prompt})
	}
	for _, path := range input.ImagePaths {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, NewError("chat_attachment_not_found", http.StatusNotFound, nil)
		}
		parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{
			"url": "data:" + GuessImageMimeType(path) + ";base64," + base64.StdEncoding.EncodeToString(raw),
		}})
	}
	return parts, nil
}

func defaultReadChatHistory(publisher *PublishingStore) func(context.Context, string) ([]map[string]any, error) {
	return func(ctx context.Context, sessionID string) ([]map[string]any, error) {
		store := publisher.store
		page, err := store.ReadTimeline(ctx, sessionID, "", 200)
		if err != nil || page == nil {
			return nil, err
		}
		session, err := store.RequireSession(ctx, sessionID)
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0)
		err = store.db.withRead(ctx, func(db *sql.DB) error {
			for _, item := range page.Items {
				role := asString(item.Detail["role"])
				if item.Kind != "message" || (role != "user" && role != "assistant") {
					continue
				}
				entry := map[string]any{"role": role, "itemID": item.ID, "status": item.Status}
				if item.Content != nil {
					entry["content"] = *item.Content
				}
				if item.TurnID != "" {
					cmd, err := store.FailedTurns.findSubmissionWithQuerier(ctx, db, sessionID, item.TurnID)
					if err != nil {
						return err
					}
					if cmd != nil {
						entry["submissionCommandId"] = cmd.CommandID
					}
				}
				if role == "user" {
					sub, err := messageSubmissionWithQuerier(ctx, db, store, session, item)
					if err != nil {
						return err
					}
					// Resolve bytes only for messages retained by the history window.
					entry["content"] = asString(sub["content"])
					entry["attachmentIds"] = sub["attachmentIds"]
				}
				out = append(out, entry)
			}
			return nil
		})
		return out, err
	}
}

func (d *GoChatDriver) buildMessages(ctx context.Context, active *goChatActiveTurn, content any, policy map[string]any) ([]map[string]any, error) {
	entries, err := d.readChatHistory(ctx, d.sessionID())
	if err != nil {
		return nil, err
	}
	var history []map[string]any
	chars, bytes := 0, 0
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		role := asString(entry["role"])
		if active.submissionID != "" && asString(entry["submissionCommandId"]) == active.submissionID {
			if role == "user" {
				active.userItemID = asString(entry["itemID"])
			}
			continue
		}
		if status := asString(entry["status"]); status != "" && status != "completed" {
			continue
		}
		if role != "user" && role != "assistant" {
			continue
		}
		text := asString(entry["content"])
		if len(history) >= GoChatMaxHistoryMessages || chars+len(text) > GoChatMaxHistoryChars {
			break
		}
		var value any = text
		ids, err := NormalizeAttachmentIDs(entry["attachmentIds"], false)
		if err != nil {
			return nil, err
		}
		if role == "user" && len(ids) > 0 {
			paths, err := d.store.ResolveAttachmentPaths(ctx, d.sessionID(), ids)
			if err != nil {
				return nil, err
			}
			value, err = gatewayUserContent(d.session, text, paths)
			if err != nil {
				return nil, err
			}
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		if bytes+len(encoded) > 32*1024*1024 {
			break
		}
		if strings.TrimSpace(text) == "" && len(ids) == 0 {
			continue
		}
		history = append(history, map[string]any{"role": role, "content": value})
		chars += len(text)
		bytes += len(encoded)
	}
	slices.Reverse(history)
	// A truncated window should start with a user turn.
	for len(history) > 0 && history[0]["role"] != "user" {
		history = history[1:]
	}
	messages := []map[string]any{{"role": "system", "content": gatewayChatInstructions}}
	if prompt := strings.TrimSpace(asString(policy["systemPrompt"])); prompt != "" {
		messages = append(messages, map[string]any{"role": "system", "content": prompt})
	}
	messages = append(messages, history...)
	return append(messages, map[string]any{"role": "user", "content": content}), nil
}
