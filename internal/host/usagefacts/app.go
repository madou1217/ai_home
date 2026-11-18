// Package usagefacts is the bounded stdio adapter for a pure usage plan.
// It has no database, credential, HTTP, account-adoption or server dependency.
package usagefacts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
)

const Capability = "aih-usage-facts-v1"
const MaxInput int64 = 8 << 20
const MaxOutput = 256 << 10

type request struct {
	Version          int                        `json:"version"`
	Provider         json.RawMessage            `json:"provider,omitempty"`
	Snapshot         json.RawMessage            `json:"snapshot,omitempty"`
	QuotaDescriptors []usageapp.QuotaDescriptor `json:"quotaDescriptors,omitempty"`
}

// Compile validates framing only. All quota and JS compatibility rules remain
// in application/accountusage. Error messages contain no submitted values.
func Compile(ctx context.Context, raw []byte) ([]byte, error) {
	if ctx == nil {
		return nil, errors.New("usage_facts_context_required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(raw) == 0 || int64(len(raw)) > MaxInput || !json.Valid(raw) {
		return nil, errors.New("usage_facts_request_invalid")
	}
	var input request
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return nil, errors.New("usage_facts_request_invalid")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("usage_facts_request_invalid")
	}
	if input.Version != 1 || len(input.QuotaDescriptors) > 1024 {
		return nil, errors.New("usage_facts_request_invalid")
	}
	facts, err := usageapp.CompileUsageFacts(ctx, input.Snapshot, input.Provider, input.QuotaDescriptors)
	if err != nil {
		return nil, errors.New("usage_facts_compile_failed")
	}
	response := struct {
		Version int                  `json:"version"`
		Facts   *usageapp.UsageFacts `json:"facts"`
	}{1, facts}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, errors.New("usage_facts_output_invalid")
	}
	if len(encoded)+1 > MaxOutput {
		clear(encoded)
		return nil, errors.New("usage_facts_output_limit")
	}
	return append(encoded, '\n'), nil
}
