package webuidistributionapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/distributionupdate"
)

const Path = "/v1/management/webui/distribution-update"

type Authorizer interface{ Authorized(*http.Request) bool }
type Handler struct {
	Authorizer Authorizer
	Service    *distributionupdate.Service
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	write := func(code int, v any) { w.WriteHeader(code); _ = json.NewEncoder(w).Encode(v) }
	if h.Authorizer == nil || !h.Authorizer.Authorized(r) {
		write(401, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if h.Service == nil {
		write(503, map[string]any{"ok": false, "error": "distribution_update_unavailable"})
		return
	}
	suffix := strings.TrimPrefix(r.URL.Path, Path)
	var status distributionupdate.Status
	var err error
	switch {
	case r.Method == http.MethodGet && suffix == "":
		status = h.Service.Snapshot()
	case r.Method == http.MethodPost && suffix == "/check":
		status, err = h.Service.Check(r.Context())
	case r.Method == http.MethodPost && suffix == "/cancel":
		status, err = h.Service.Cancel(r.Context())
	case r.Method == http.MethodPost && suffix == "/schedule":
		var in struct {
			At       time.Time `json:"at"`
			Timezone string    `json:"timezone"`
			Confirm  bool      `json:"confirm"`
		}
		d := json.NewDecoder(io.LimitReader(r.Body, 4097))
		d.DisallowUnknownFields()
		if d.Decode(&in) != nil || !in.Confirm {
			write(400, map[string]any{"ok": false, "error": "explicit_confirmation_required"})
			return
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			write(400, map[string]any{"ok": false, "error": "invalid_schedule"})
			return
		}
		status, err = h.Service.Schedule(r.Context(), in.At, in.Timezone)
		if err == nil && in.At.Before(time.Now().Add(time.Second)) {
			go func() { _, _ = h.Service.Tick(context.Background()) }()
		}
	default:
		write(404, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	if err != nil {
		code := 503
		label := "distribution_update_failed"
		switch {
		case errors.Is(err, distributionupdate.ErrNoRelease):
			code = 409
			label = "check_release_first"
		case errors.Is(err, distributionupdate.ErrInvalidSchedule):
			code = 400
			label = "invalid_schedule"
		case errors.Is(err, distributionupdate.ErrNotDistribution):
			code = 409
			label = "distribution_install_required"
		case errors.Is(err, distributionupdate.ErrScheduleActive):
			code = 409
			label = "update_already_scheduled"
		case errors.Is(err, distributionupdate.ErrNotCancellable):
			code = 409
			label = "update_not_cancellable"
		}
		write(code, map[string]any{"ok": false, "error": label, "message": err.Error()})
		return
	}
	write(200, map[string]any{"ok": true, "update": status})
}
