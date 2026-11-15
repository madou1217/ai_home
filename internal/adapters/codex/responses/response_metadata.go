package responses

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// observedFailureMetadata reads only an explicit failed Response snapshot. Bare
// errors and interrupted streams have no final tier. Invalid optional metadata
// must not replace an already established failure classification.
func observedFailureMetadata(payload []byte) inference.ResponseMetadata {
	var envelope struct {
		Type     string          `json:"type"`
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return inference.ResponseMetadata{}
	}
	if envelope.Type != "" {
		if envelope.Type != "response.failed" {
			return inference.ResponseMetadata{}
		}
		payload = envelope.Response
	}
	var snapshot struct {
		Status      string  `json:"status"`
		ServiceTier *string `json:"service_tier"`
	}
	if json.Unmarshal(payload, &snapshot) != nil || snapshot.Status != "failed" {
		return inference.ResponseMetadata{}
	}
	metadata, err := inference.NewResponseMetadata(snapshot.ServiceTier)
	if err != nil {
		return inference.ResponseMetadata{}
	}
	return metadata
}
