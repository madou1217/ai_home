package distributionupdate

import (
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/distributionrelease"
)

var (
	stablePattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
	digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func newer(version, current string) bool {
	parts := stablePattern.FindStringSubmatch(version)
	core := strings.Split(strings.SplitN(strings.SplitN(current, "+", 2)[0], "-", 2)[0], ".")
	if parts == nil || len(core) != 3 {
		return false
	}
	for i, component := range core {
		if len(parts[i+1]) != len(component) {
			return len(parts[i+1]) > len(component)
		}
		if parts[i+1] != component {
			return parts[i+1] > component
		}
	}
	return strings.Contains(strings.SplitN(current, "+", 2)[0], "-")
}

func releaseFile(info distributionrelease.ReleaseInfo) string {
	extension := ".run"
	if strings.HasPrefix(info.Target, "win32-") {
		extension = ".exe"
	}
	return "aih-" + info.Version + "-" + info.Target + extension
}

func validReleaseShape(info distributionrelease.ReleaseInfo) bool {
	if len(info.Version) > 128 || !stablePattern.MatchString(info.Version) || info.Repository != distributionrelease.DefaultRepository ||
		info.Tag != "v"+info.Version || info.PublishedAt.IsZero() || info.CheckedAt.IsZero() ||
		info.Available != newer(info.Version, info.CurrentVersion) {
		return false
	}
	if _, err := distributionrelease.New(distributionrelease.Options{CurrentVersion: info.CurrentVersion, Target: info.Target}); err != nil {
		return false
	}
	if !info.Available {
		return info.Artifact == (distributionrelease.ArtifactInfo{})
	}
	return info.Artifact.File == releaseFile(info) && info.Artifact.Bytes > 0 && info.Artifact.Bytes <= distributionrelease.MaxArtifactBytes && digestPattern.MatchString(info.Artifact.SHA256)
}

func (s *Service) validRelease(info distributionrelease.ReleaseInfo, requireUpdate bool) bool {
	return validReleaseShape(info) && info.CurrentVersion == s.current.Version && info.Target == s.current.Target &&
		(!requireUpdate || info.Available)
}

func validStoredSchedule(schedule *ScheduledUpdate) bool {
	if schedule.ID == "" || len(schedule.ID) > 128 || !schedule.Confirmed || schedule.Version != schedule.FixedReleaseInfo.Version ||
		!validReleaseShape(schedule.FixedReleaseInfo) || !schedule.FixedReleaseInfo.Available ||
		schedule.At.IsZero() || schedule.CreatedAt.IsZero() || schedule.Timezone == "" || schedule.Timezone == "Local" {
		return false
	}
	if _, err := time.LoadLocation(schedule.Timezone); err != nil {
		return false
	}
	if pending(schedule.Status) && (schedule.NextAttemptAt.IsZero() || schedule.NextAttemptAt.Before(schedule.At)) {
		return false
	}
	if running(schedule.Status) && (schedule.StartedAt.IsZero() ||
		(schedule.Status == StatusDownloading && schedule.Stage != StageDownload) ||
		(schedule.Status == StatusInstalling && schedule.Stage != StageInstall)) {
		return false
	}
	switch schedule.Status {
	case StatusQueued, StatusDeferred, StatusDownloading, StatusInstalling, StatusSucceeded, StatusFailed, StatusCancelled:
		return true
	}
	return false
}

func (s *Service) fixedValid(schedule *ScheduledUpdate) bool {
	return s.current.Source == "distribution" && s.validRelease(schedule.FixedReleaseInfo, true) &&
		schedule.Confirmed && schedule.Version == schedule.FixedReleaseInfo.Version && !schedule.NextAttemptAt.IsZero() &&
		!schedule.NextAttemptAt.Before(schedule.At)
}
