package codeassist

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
)

var ErrInvalidUpstreamResponse = errors.New("AGY Code Assist 上游响应无效")

type responseDecoder struct {
	model       string
	emit        inferencegateway.EventSink
	sequence    uint64
	started     bool
	messageOpen bool
	textOpen    bool
	terminal    bool
	responseID  string
	text        string
	usage       inference.Usage
	nextOutput  uint32
	toolCalls   map[string]decodedToolCall
}

type decodedToolCall struct {
	outputIndex uint32
	callID      string
	name        string
	arguments   []byte
}

type streamEnvelope struct {
	Response streamResponse `json:"response"`
}

type streamResponse struct {
	Candidates    []streamCandidate `json:"candidates"`
	UsageMetadata *usageMetadata    `json:"usageMetadata"`
}

type streamCandidate struct {
	Content      streamContent `json:"content"`
	FinishReason string        `json:"finishReason"`
}

type streamContent struct {
	Parts []streamPart `json:"parts"`
}

type streamPart struct {
	Text         *string             `json:"text"`
	FunctionCall *streamFunctionCall `json:"functionCall"`
	Thought      bool                `json:"thought"`
	Signature    string              `json:"thoughtSignature"`
}

type streamFunctionCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

type usageMetadata struct {
	PromptTokenCount     uint64 `json:"promptTokenCount"`
	CandidatesTokenCount uint64 `json:"candidatesTokenCount"`
	ThoughtsTokenCount   uint64 `json:"thoughtsTokenCount"`
}

func newResponseDecoder(
	model string,
	emit inferencegateway.EventSink,
) *responseDecoder {
	return &responseDecoder{
		model:      model,
		emit:       emit,
		responseID: "agy_response",
		toolCalls:  make(map[string]decodedToolCall),
	}
}

func (decoder *responseDecoder) Terminal() bool {
	return decoder != nil && decoder.terminal
}

func (decoder *responseDecoder) Apply(payload []byte) error {
	if decoder == nil || decoder.emit == nil || decoder.terminal {
		return fmt.Errorf("%w: decoder state", ErrInvalidUpstreamResponse)
	}
	var envelope streamEnvelope
	jsonDecoder := json.NewDecoder(bytes.NewReader(payload))
	if err := jsonDecoder.Decode(&envelope); err != nil ||
		len(envelope.Response.Candidates) == 0 {
		return fmt.Errorf("%w: envelope %v", ErrInvalidUpstreamResponse, err)
	}
	if err := decoder.start(); err != nil {
		return err
	}
	for _, candidate := range envelope.Response.Candidates {
		for _, part := range candidate.Content.Parts {
			if part.Thought || part.Signature != "" {
				return fmt.Errorf("%w: unsupported thought", ErrInvalidUpstreamResponse)
			}
			if part.Text != nil && *part.Text != "" {
				if err := decoder.appendText(*part.Text); err != nil {
					return err
				}
			}
			if part.FunctionCall != nil {
				if err := decoder.appendToolCall(*part.FunctionCall); err != nil {
					return err
				}
			}
		}
		if envelope.Response.UsageMetadata != nil {
			usage, err := inference.NewUsage(inference.UsageInput{
				InputTokens:     envelope.Response.UsageMetadata.PromptTokenCount,
				OutputTokens:    envelope.Response.UsageMetadata.CandidatesTokenCount,
				ReasoningTokens: envelope.Response.UsageMetadata.ThoughtsTokenCount,
			})
			if err != nil {
				return fmt.Errorf(
					"%w: usage input=%d output=%d reasoning=%d",
					ErrInvalidUpstreamResponse,
					envelope.Response.UsageMetadata.PromptTokenCount,
					envelope.Response.UsageMetadata.CandidatesTokenCount,
					envelope.Response.UsageMetadata.ThoughtsTokenCount,
				)
			}
			decoder.usage = usage
		}
		if candidate.FinishReason != "" {
			return decoder.complete(candidate.FinishReason)
		}
	}
	return nil
}

func (decoder *responseDecoder) start() error {
	if decoder.started {
		return nil
	}
	event, err := inference.NewResponseStartedEvent(
		decoder.sequence,
		decoder.responseID,
		decoder.model,
	)
	if err != nil {
		return fmt.Errorf("%w: tool item", ErrInvalidUpstreamResponse)
	}
	decoder.started = true
	return decoder.emitEvent(event)
}

func (decoder *responseDecoder) appendText(text string) error {
	if !decoder.messageOpen {
		item, err := inference.NewOutputItemStartedEvent(
			decoder.sequence,
			0,
			"agy_message",
			inference.OutputItemMessage,
		)
		if err != nil {
			return fmt.Errorf("%w: message item", ErrInvalidUpstreamResponse)
		}
		decoder.messageOpen = true
		decoder.nextOutput = 1
		if err := decoder.emitEvent(item); err != nil {
			return err
		}
	}
	if !decoder.textOpen {
		decoder.textOpen = true
		if err := decoder.emitEvent(inference.ContentBlockStartedEvent(
			mustContentBlockStarted(decoder.sequence, 0, 0, inference.ContentText),
		)); err != nil {
			return err
		}
	}
	event, err := inference.NewTextDeltaEvent(decoder.sequence, 0, 0, text)
	if err != nil {
		return fmt.Errorf("%w: tool start", ErrInvalidUpstreamResponse)
	}
	decoder.text += text
	return decoder.emitEvent(event)
}

func mustContentBlockStarted(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	kind inference.ContentKind,
) inference.ContentBlockStartedEvent {
	event, _ := inference.NewContentBlockStartedEvent(sequence, outputIndex, blockIndex, kind)
	return event
}

func (decoder *responseDecoder) appendToolCall(call streamFunctionCall) error {
	if !validOpaque(call.ID) || !validOpaque(call.Name) ||
		len(call.Args) == 0 || call.Args[0] != '{' ||
		!json.Valid(call.Args) {
		return fmt.Errorf("%w: invalid tool fields", ErrInvalidUpstreamResponse)
	}
	arguments := bytes.TrimSpace(call.Args)
	if previous, found := decoder.toolCalls[call.ID]; found {
		if previous.name != call.Name || !bytes.Equal(previous.arguments, arguments) {
			return fmt.Errorf("%w: conflicting tool", ErrInvalidUpstreamResponse)
		}
		return nil
	}
	outputIndex := decoder.nextOutput
	decoder.nextOutput++
	itemID := "agy_tool_" + call.ID
	item, err := inference.NewOutputItemStartedEvent(
		decoder.sequence,
		outputIndex,
		itemID,
		inference.OutputItemToolCall,
	)
	if err != nil {
		return fmt.Errorf("%w: tool arguments", ErrInvalidUpstreamResponse)
	}
	if err := decoder.emitEvent(item); err != nil {
		return err
	}
	started, err := inference.NewToolCallStartedEvent(
		decoder.sequence,
		outputIndex,
		0,
		call.ID,
		call.Name,
	)
	if err != nil {
		return fmt.Errorf("%w: tool complete", ErrInvalidUpstreamResponse)
	}
	if err := decoder.emitEvent(started); err != nil {
		return err
	}
	delta, err := inference.NewToolArgumentsDeltaEvent(
		decoder.sequence,
		outputIndex,
		0,
		call.ID,
		string(arguments),
	)
	if err != nil {
		return fmt.Errorf("%w: tool delta", ErrInvalidUpstreamResponse)
	}
	if err := decoder.emitEvent(delta); err != nil {
		return err
	}
	completed, err := inference.NewToolCallCompletedEvent(
		decoder.sequence,
		outputIndex,
		0,
		call.ID,
		call.Name,
		arguments,
	)
	if err != nil {
		return fmt.Errorf("%w: tool completed", ErrInvalidUpstreamResponse)
	}
	if err := decoder.emitEvent(completed); err != nil {
		return err
	}
	if err := decoder.emitEvent(inference.NewContentBlockCompletedEvent(
		decoder.sequence,
		outputIndex,
		0,
	)); err != nil {
		return err
	}
	if err := decoder.emitEvent(mustOutputCompleted(
		decoder.sequence,
		outputIndex,
		itemID,
	)); err != nil {
		return err
	}
	decoder.toolCalls[call.ID] = decodedToolCall{
		outputIndex: outputIndex,
		callID:      call.ID,
		name:        call.Name,
		arguments:   append([]byte(nil), arguments...),
	}
	return nil
}

func mustOutputCompleted(
	sequence uint64,
	outputIndex uint32,
	itemID string,
) inference.OutputItemCompletedEvent {
	event, _ := inference.NewOutputItemCompletedEvent(sequence, outputIndex, itemID)
	return event
}

func (decoder *responseDecoder) complete(reason string) error {
	if decoder.textOpen {
		if decoder.text == "" {
			return fmt.Errorf("%w: empty text", ErrInvalidUpstreamResponse)
		}
		completed, err := inference.NewTextCompletedEvent(
			decoder.sequence,
			0,
			0,
			decoder.text,
		)
		if err != nil {
			return fmt.Errorf("%w: text complete", ErrInvalidUpstreamResponse)
		}
		if err := decoder.emitEvent(completed); err != nil {
			return err
		}
		if err := decoder.emitEvent(inference.NewContentBlockCompletedEvent(
			decoder.sequence, 0, 0,
		)); err != nil {
			return err
		}
	}
	if decoder.messageOpen {
		if err := decoder.emitEvent(mustOutputCompleted(
			decoder.sequence, 0, "agy_message",
		)); err != nil {
			return err
		}
	}
	stopReason, err := mapFinishReason(reason, len(decoder.toolCalls) > 0)
	if err != nil {
		return err
	}
	completed, err := inference.NewResponseCompletedEvent(
		decoder.sequence,
		stopReason,
		"",
		decoder.usage,
	)
	if err != nil {
		return fmt.Errorf("%w: response complete", ErrInvalidUpstreamResponse)
	}
	decoder.terminal = true
	return decoder.emitEvent(completed)
}

func mapFinishReason(reason string, hasTools bool) (inference.StopReason, error) {
	switch reason {
	case "STOP":
		if hasTools {
			return inference.StopReasonToolUse, nil
		}
		return inference.StopReasonEndTurn, nil
	case "MAX_TOKENS":
		return inference.StopReasonMaxTokens, nil
	case "SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT":
		return inference.StopReasonContentFilter, nil
	default:
		return "", fmt.Errorf("%w: finishReason", ErrInvalidUpstreamResponse)
	}
}

func (decoder *responseDecoder) emitEvent(event inference.StreamEvent) error {
	if event.Sequence() != decoder.sequence {
		return fmt.Errorf(
			"%w: event sequence got=%d want=%d kind=%s",
			ErrInvalidUpstreamResponse,
			event.Sequence(),
			decoder.sequence,
			event.Kind(),
		)
	}
	if err := decoder.emit(event); err != nil {
		return err
	}
	decoder.sequence++
	return nil
}
