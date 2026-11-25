package acpclient

import (
	"context"
	"fmt"
	"strings"

	acp "github.com/coder/acp-go-sdk"
)

// Client translates ACP client methods into workspace capabilities and
// normalized events. It deliberately has no provider-specific branching.
type Client struct {
	files       FileSystem
	terminals   TerminalHost
	permissions PermissionBroker
	events      EventSink
}

var _ acp.Client = (*Client)(nil)

func NewClient(files FileSystem, terminals TerminalHost, permissions PermissionBroker, events EventSink) *Client {
	return &Client{files: files, terminals: terminals, permissions: permissions, events: events}
}

func (client *Client) ReadTextFile(ctx context.Context, params acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	if client.files == nil {
		return acp.ReadTextFileResponse{}, fmt.Errorf("filesystem capability is not configured")
	}
	content, err := client.files.ReadTextFile(ctx, params.Path, params.Line, params.Limit)
	if err != nil {
		return acp.ReadTextFileResponse{}, err
	}
	return acp.ReadTextFileResponse{Content: content}, nil
}

func (client *Client) WriteTextFile(ctx context.Context, params acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	if client.files == nil {
		return acp.WriteTextFileResponse{}, fmt.Errorf("filesystem capability is not configured")
	}
	if err := client.files.WriteTextFile(ctx, params.Path, params.Content); err != nil {
		return acp.WriteTextFileResponse{}, err
	}
	return acp.WriteTextFileResponse{}, nil
}

func (client *Client) RequestPermission(ctx context.Context, params acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	if client.permissions == nil {
		return cancelledPermission(), nil
	}
	request := PermissionRequest{
		SessionID: string(params.SessionId),
		ToolCall:  toolCallFromUpdate(params.ToolCall),
		Options:   permissionOptions(params.Options),
	}
	decision, err := client.permissions.Authorize(ctx, request)
	if err != nil {
		return acp.RequestPermissionResponse{}, err
	}
	if decision.Cancelled || strings.TrimSpace(decision.OptionID) == "" {
		return cancelledPermission(), nil
	}
	for _, option := range params.Options {
		if string(option.OptionId) == decision.OptionID {
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{
					Selected: &acp.RequestPermissionOutcomeSelected{OptionId: option.OptionId},
				},
			}, nil
		}
	}
	// A decision that does not match any option is a client bug. Fail closed.
	return cancelledPermission(), nil
}

func (client *Client) SessionUpdate(ctx context.Context, params acp.SessionNotification) error {
	if client.events == nil {
		return nil
	}
	update := params.Update
	sessionID := string(params.SessionId)
	switch {
	case update.AgentMessageChunk != nil:
		_ = client.events.Publish(ctx, Event{Kind: EventMessageDelta, SessionID: sessionID, Text: contentText(update.AgentMessageChunk.Content)})
	case update.AgentThoughtChunk != nil:
		_ = client.events.Publish(ctx, Event{Kind: EventThoughtDelta, SessionID: sessionID, Text: contentText(update.AgentThoughtChunk.Content)})
	case update.ToolCall != nil:
		_ = client.events.Publish(ctx, Event{Kind: EventToolCall, SessionID: sessionID, ToolCall: toolCallFromNew(*update.ToolCall)})
	case update.ToolCallUpdate != nil:
		_ = client.events.Publish(ctx, Event{Kind: EventToolUpdate, SessionID: sessionID, ToolCall: toolCallFromWrapper(*update.ToolCallUpdate)})
	case update.Plan != nil:
		_ = client.events.Publish(ctx, Event{Kind: EventPlan, SessionID: sessionID, Plan: planEntries(update.Plan.Entries)})
	case update.Notice != nil:
		notice := Notice{Title: update.Notice.Title, Severity: string(update.Notice.Severity)}
		if update.Notice.Description != nil {
			notice.Description = *update.Notice.Description
		}
		_ = client.events.Publish(ctx, Event{Kind: EventNotice, SessionID: sessionID, Notice: &notice})
	}
	return nil
}

func (client *Client) CreateTerminal(ctx context.Context, params acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	if client.terminals == nil {
		return acp.CreateTerminalResponse{}, fmt.Errorf("terminal capability is not configured")
	}
	cwd := ""
	if params.Cwd != nil {
		cwd = *params.Cwd
	}
	env := make([]string, 0, len(params.Env))
	for _, item := range params.Env {
		env = append(env, item.Name+"="+item.Value)
	}
	id, err := client.terminals.Create(ctx, TerminalSpec{
		Command:         params.Command,
		Args:            params.Args,
		Cwd:             cwd,
		Env:             env,
		OutputByteLimit: params.OutputByteLimit,
	})
	if err != nil {
		return acp.CreateTerminalResponse{}, err
	}
	return acp.CreateTerminalResponse{TerminalId: acp.TerminalId(id)}, nil
}

func (client *Client) TerminalOutput(ctx context.Context, params acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	if client.terminals == nil {
		return acp.TerminalOutputResponse{}, fmt.Errorf("terminal capability is not configured")
	}
	output, err := client.terminals.Output(ctx, string(params.TerminalId))
	if err != nil {
		return acp.TerminalOutputResponse{}, err
	}
	response := acp.TerminalOutputResponse{Output: output.Output, Truncated: output.Truncated}
	if output.ExitCode != nil || output.Signal != "" {
		response.ExitStatus = &acp.TerminalExitStatus{ExitCode: output.ExitCode}
		if output.Signal != "" {
			signal := output.Signal
			response.ExitStatus.Signal = &signal
		}
	}
	return response, nil
}

func (client *Client) WaitForTerminalExit(ctx context.Context, params acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	if client.terminals == nil {
		return acp.WaitForTerminalExitResponse{}, fmt.Errorf("terminal capability is not configured")
	}
	exit, err := client.terminals.Wait(ctx, string(params.TerminalId))
	if err != nil {
		return acp.WaitForTerminalExitResponse{}, err
	}
	response := acp.WaitForTerminalExitResponse{ExitCode: exit.ExitCode}
	if exit.Signal != "" {
		signal := exit.Signal
		response.Signal = &signal
	}
	return response, nil
}

func (client *Client) KillTerminal(ctx context.Context, params acp.KillTerminalRequest) (acp.KillTerminalResponse, error) {
	if client.terminals == nil {
		return acp.KillTerminalResponse{}, fmt.Errorf("terminal capability is not configured")
	}
	return acp.KillTerminalResponse{}, client.terminals.Kill(ctx, string(params.TerminalId))
}

func (client *Client) ReleaseTerminal(ctx context.Context, params acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	if client.terminals == nil {
		return acp.ReleaseTerminalResponse{}, fmt.Errorf("terminal capability is not configured")
	}
	return acp.ReleaseTerminalResponse{}, client.terminals.Release(ctx, string(params.TerminalId))
}

func (client *Client) CreateElicitation(context.Context, acp.CreateElicitationRequest) (acp.CreateElicitationResponse, error) {
	return acp.CreateElicitationResponse{}, &acp.RequestError{Code: -32601, Message: "elicitation is not supported"}
}

func (client *Client) CompleteElicitation(context.Context, acp.CompleteElicitationNotification) error {
	return nil
}

func cancelledPermission() acp.RequestPermissionResponse {
	return acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
	}
}

func contentText(content acp.ContentBlock) string {
	if content.Text != nil {
		return content.Text.Text
	}
	return ""
}

func permissionOptions(options []acp.PermissionOption) []PermissionOption {
	result := make([]PermissionOption, 0, len(options))
	for _, option := range options {
		result = append(result, PermissionOption{
			ID:   string(option.OptionId),
			Name: option.Name,
			Kind: string(option.Kind),
		})
	}
	return result
}

func toolCallFromNew(call acp.SessionUpdateToolCall) *ToolCall {
	name := ""
	if call.Name != nil {
		name = *call.Name
	}
	return &ToolCall{
		ID:        string(call.ToolCallId),
		Title:     call.Title,
		Name:      name,
		Kind:      string(call.Kind),
		Status:    string(call.Status),
		RawInput:  call.RawInput,
		RawOutput: call.RawOutput,
	}
}

func toolCallFromWrapper(call acp.SessionToolCallUpdate) *ToolCall {
	title, _ := call.Title.Value()
	name, _ := call.Name.Value()
	kind, _ := call.Kind.Value()
	status, _ := call.Status.Value()
	rawInput, _ := call.RawInput.Value()
	rawOutput, _ := call.RawOutput.Value()
	return &ToolCall{
		ID:        string(call.ToolCallId),
		Title:     title,
		Name:      name,
		Kind:      string(kind),
		Status:    string(status),
		RawInput:  rawInput,
		RawOutput: rawOutput,
	}
}

func toolCallFromUpdate(call acp.ToolCallUpdate) ToolCall {
	title, _ := call.Title.Value()
	name, _ := call.Name.Value()
	kind, _ := call.Kind.Value()
	status, _ := call.Status.Value()
	rawInput, _ := call.RawInput.Value()
	rawOutput, _ := call.RawOutput.Value()
	return ToolCall{
		ID:        string(call.ToolCallId),
		Title:     title,
		Name:      name,
		Kind:      string(kind),
		Status:    string(status),
		RawInput:  rawInput,
		RawOutput: rawOutput,
	}
}

func planEntries(entries []acp.PlanEntry) []PlanEntry {
	result := make([]PlanEntry, 0, len(entries))
	for _, entry := range entries {
		result = append(result, PlanEntry{
			Content:  entry.Content,
			Priority: string(entry.Priority),
			Status:   string(entry.Status),
		})
	}
	return result
}
