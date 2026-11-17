package modelalias

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ErrDisplaySourceUnavailable means a wildcard write has no authoritative
// display source. It must not be persisted as an empty display projection.
var ErrDisplaySourceUnavailable = errors.New("model_alias_display_source_unavailable")

// DisplaySource returns authoritative display names, not executable routes.
// A successful empty result is valid; an unavailable/corrupt source is an error.
// Infrastructure supplies this port without the application importing adapters.
type DisplaySource func(context.Context, string) ([]string, error)

// SetDisplaySource installs the wildcard display authority before serving writes.
func (service *Service) SetDisplaySource(source DisplaySource) {
	service.displaySource = source
}

func (service *Service) withDisplayModels(ctx context.Context, record Record) (Record, error) {
	if ctx == nil {
		return Record{}, ErrInvalidProjection
	}
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	// Never retain an old pattern's display names, including wildcard -> concrete.
	record.DisplayModels = nil
	if !strings.HasSuffix(record.Alias, "*") {
		return record, nil
	}
	if service.displaySource == nil {
		return Record{}, ErrDisplaySourceUnavailable
	}
	display, err := service.displaySource(ctx, record.Alias)
	if err != nil {
		return Record{}, fmt.Errorf("%w: %w", ErrDisplaySourceUnavailable, err)
	}
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	record.DisplayModels = append([]string(nil), display...)
	return record, nil
}
