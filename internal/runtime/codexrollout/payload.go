package codexrollout

import "encoding/json"

// Decode the relevant event payload once; avoid a map allocation and repeated
// Unmarshal calls for every known field in the retained history window.
type payload struct {
	Type            string            `json:"type"`
	TurnID          string            `json:"turn_id"`
	Model           json.RawMessage   `json:"model"`
	Message         json.RawMessage   `json:"message"`
	TextElements    json.RawMessage   `json:"text_elements"`
	Images          []json.RawMessage `json:"images"`
	LocalImages     []json.RawMessage `json:"local_images"`
	Phase           json.RawMessage   `json:"phase"`
	MemoryCitation  json.RawMessage   `json:"memory_citation"`
	Command         json.RawMessage   `json:"command"`
	Cwd             string            `json:"cwd"`
	ProcessID       json.RawMessage   `json:"process_id"`
	Source          string            `json:"source"`
	Status          string            `json:"status"`
	Output          json.RawMessage   `json:"aggregated_output"`
	FormattedOutput json.RawMessage   `json:"formatted_output"`
	Stdout          json.RawMessage   `json:"stdout"`
	Stderr          json.RawMessage   `json:"stderr"`
	ExitCode        json.RawMessage   `json:"exit_code"`
	Duration        json.RawMessage   `json:"duration"`
}

type historyEntry struct {
	Type      string          `json:"type"`
	Timestamp json.RawMessage `json:"timestamp"`
	Payload   payload         `json:"payload"`
}
