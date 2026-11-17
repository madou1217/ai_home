package claudedesktopconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/configsnapshot"
)

// Prepare validates the complete input set before creating or publishing any
// native setting. An interrupted operation is resumed only for the same request;
// conflicting native edits retain the journal and are never automatically undone.
func Prepare(ctx context.Context, o Options) Result {
	return prepare(ctx, o, "")
}

// PrepareBoundProfile binds a previously admitted canonical profile to the
// transaction's first resolution while retaining subsequent path drift guards.
func PrepareBoundProfile(ctx context.Context, o Options, expectedProfile string) Result {
	if !filepath.IsAbs(expectedProfile) || filepath.Clean(expectedProfile) != expectedProfile {
		return Result{Status: "failed", Reason: "desktop_profile_changed", Mode: o.Mode, ProfileDir: o.ProfileDir, DryRun: o.DryRun}
	}
	return prepare(ctx, o, expectedProfile)
}

func prepare(ctx context.Context, o Options, expectedProfile string) Result {
	result := Result{Status: "failed", Mode: o.Mode, ProfileDir: o.ProfileDir, DryRun: o.DryRun}
	failure := func(err error, recovery bool) Result {
		result.Reason = err.Error()
		result.RecoveryRequired = recovery
		if recovery {
			result.RecoveryPath = filepath.Join(result.ProfileDir, journalName)
		}
		return result
	}
	if ctx == nil {
		return failure(fail("desktop_context_required"), false)
	}
	if err := ctx.Err(); err != nil {
		return failure(fail("desktop_preparation_cancelled"), false)
	}
	if err := validate(o); err != nil {
		return failure(err, false)
	}
	profile, err := configsnapshot.Resolve(o.ProfileDir)
	if err != nil {
		return failure(err, false)
	}
	if expectedProfile != "" && profile != expectedProfile {
		return failure(fail("desktop_profile_changed"), false)
	}
	result.ProfileDir = profile
	marker := filepath.Join(profile, journalName)
	if _, err = os.Lstat(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		return failure(err, true)
	}
	pending := err == nil
	var plan transaction
	if !pending {
		plan, err = buildPlan(o, profile)
		if err != nil {
			return failure(err, false)
		}
		result.ConfigID = plan.ConfigID
		result.Changed = len(plan.Changes) > 0
		if o.DryRun {
			if ctx.Err() != nil {
				return failure(fail("desktop_preparation_cancelled"), false)
			}
			result.OK = true
			result.Status = "preview"
			if o.Mode == "api" {
				result.GatewayBaseURL = o.GatewayBaseURL
			}
			return result
		}
	} else if o.DryRun {
		return failure(fail("desktop_preparation_recovery_required"), true)
	}
	_, release, err := configsnapshot.Acquire(marker)
	if err != nil {
		return failure(err, pending)
	}
	defer release()
	// A profile alias changed while acquiring its lock: don't publish elsewhere.
	bound, err := configsnapshot.Resolve(o.ProfileDir)
	if err != nil || bound != profile {
		return failure(fail("desktop_profile_changed"), true)
	}
	// Re-read under the coordinator lock. Another cooperating writer may have
	// finished between the preliminary read-only check and this acquisition.
	plan, exists, err := readTransaction(marker, profile)
	if err != nil {
		return failure(err, true)
	}
	signature, err := requestSignature(o, profile)
	if err != nil {
		return failure(err, false)
	}
	if exists {
		if plan.RequestSHA256 != signature {
			return failure(fail("desktop_pending_request_conflict"), true)
		}
	} else {
		plan, err = buildPlan(o, profile)
		if err != nil {
			return failure(err, false)
		}
		plan.RequestSHA256 = signature
		if len(plan.Changes) == 0 {
			if err = publish(ctx, plan); err != nil {
				return failure(err, false)
			}
			if ctx.Err() != nil {
				return failure(fail("desktop_preparation_cancelled"), false)
			}
			finalProfile, resolveErr := configsnapshot.Resolve(o.ProfileDir)
			if resolveErr != nil || finalProfile != profile {
				return failure(fail("desktop_profile_changed"), false)
			}
			result.OK = true
			result.Status = o.Mode + "_configured"
			result.ConfigID = plan.ConfigID
			result.Changed = false
			if o.Mode == "api" {
				result.GatewayBaseURL = o.GatewayBaseURL
			}
			return result
		}
		if err = writeTransaction(marker, plan); err != nil {
			return failure(err, true)
		}
	}
	result.ConfigID = plan.ConfigID
	result.Changed = len(plan.Changes) > 0
	if err = publish(ctx, plan); err != nil {
		return failure(err, true)
	}
	if ctx.Err() != nil {
		return failure(fail("desktop_preparation_cancelled"), true)
	}
	if err = finishTransaction(marker, plan); err != nil {
		return failure(err, true)
	}
	if ctx.Err() != nil {
		return failure(fail("desktop_preparation_cancelled"), false)
	}
	finalProfile, resolveErr := configsnapshot.Resolve(o.ProfileDir)
	if resolveErr != nil || finalProfile != profile {
		return failure(fail("desktop_profile_changed"), false)
	}
	result.OK = true
	result.Status = o.Mode + "_configured"
	if o.Mode == "api" {
		result.GatewayBaseURL = o.GatewayBaseURL
	}
	return result
}
func requestSignature(o Options, profile string) (string, error) {
	raw, err := json.Marshal(struct {
		Profile string
		Mode    string
		Gateway string
		Helper  string
		Args    []string
	}{profile, o.Mode, o.GatewayBaseURL, o.CredentialHelper, o.CredentialHelperArgs})
	if err != nil {
		return "", err
	}
	return fingerprint(raw), nil
}
func beforeMatches(snapshot configsnapshot.Snapshot, c change) bool {
	return snapshot.Path == c.Resolved && snapshot.Exists == c.Existed && bytes.Equal(snapshot.Content, c.Before) && (!c.Existed || uint32(snapshot.Mode.Perm()) == c.Mode)
}
func afterMatches(snapshot configsnapshot.Snapshot, c change) bool {
	return snapshot.Path == c.Resolved && snapshot.Exists && bytes.Equal(snapshot.Content, c.After) && uint32(snapshot.Mode.Perm()) == c.Mode
}
