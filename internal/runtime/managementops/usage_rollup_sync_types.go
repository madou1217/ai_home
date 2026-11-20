package managementops

import (
	"errors"
	"strings"
)

var errRollupCapabilitiesNotReady = errors.New("rollup_capabilities_not_ready")

type hourRange struct {
	StartHour int64
	EndHour   int64 // half-open [StartHour, EndHour)
}

type hourAttrDigest struct {
	count  int
	digest int64
}

type tokenPairKey struct {
	ctx int64
	out int64
}

type rollupModelKey struct {
	provider        string
	model           string
	accountRef      string
	accountProvider string
}

type rollupModelAgg struct {
	calls                    int
	inputTokens              int64
	outputTokens             int64
	cacheReadInputTokens     int64
	cacheCreationInputTokens int64
	reasoningOutputTokens    int64
	totalTokens              int64
	costUSD                  usageCostSum
}

type rollupSessionKey struct {
	provider        string
	sessionID       string
	model           string
	accountRef      string
	accountProvider string
}

type rollupSessionAgg struct {
	calls                    int
	inputTokens              int64
	outputTokens             int64
	cacheReadInputTokens     int64
	cacheCreationInputTokens int64
	reasoningOutputTokens    int64
	totalTokens              int64
	costUSD                  usageCostSum
	hasTimestamp             bool
	minTimestampMS           int64
	maxTimestampMS           int64
	maxProject               string
	maxCWD                   string
	maxGitBranch             string
}

type rollupPromptKey struct {
	provider  string
	sessionID string
}

type rollupHourBuild struct {
	hourMS               int64
	maxRecordID          int64
	maxPromptRowID       int64
	hasCodexFile         bool
	hasLeftBoundaryAttr  bool
	hasRightBoundaryAttr bool
	attrs                []usageAttribution
	models               map[rollupModelKey]*rollupModelAgg
	sessions             map[rollupSessionKey]*rollupSessionAgg
	prompts              map[rollupPromptKey]int
}

func hourFloorMS(ts int64) int64 {
	if ts <= 0 {
		return 0
	}
	return (ts / rollupHourMS) * rollupHourMS
}

func getOrCreateHourBuild(byHour map[int64]*rollupHourBuild, h int64) *rollupHourBuild {
	b := byHour[h]
	if b != nil {
		return b
	}
	b = &rollupHourBuild{
		hourMS:   h,
		models:   make(map[rollupModelKey]*rollupModelAgg),
		sessions: make(map[rollupSessionKey]*rollupSessionAgg),
		prompts:  make(map[rollupPromptKey]int),
	}
	byHour[h] = b
	return b
}

func accumulateCanonicalRowIntoHour(
	hb *rollupHourBuild,
	r observationRow,
	attr *usageAttribution,
	forksByHash map[string]forkDescriptor,
) {
	if r.ID > hb.maxRecordID {
		hb.maxRecordID = r.ID
	}
	sessID, project, cwd, keep, isCodexFile := applyCodexForkToUsageRow(
		r.Provider, r.EventKey, r.SessionID, r.Project, r.CWD, forksByHash,
	)
	if isCodexFile {
		hb.hasCodexFile = true
	}
	if !keep {
		return
	}

	acctRef := r.AccountRef
	acctProv := r.Provider
	if strings.TrimSpace(acctRef) == "" {
		if attr != nil {
			acctRef = attr.AccountRef
			acctProv = attr.AccountProvider
		} else {
			acctRef = ""
			acctProv = ""
		}
	}
	model := r.Model
	if attr != nil && attr.Model != "" {
		model = attr.Model
	}
	model = strings.TrimSpace(model)
	if model == "" {
		model = legacyUnknownModel
	}
	costUSD := r.CostUSD
	if attr != nil {
		costUSD = attr.CostUSD
	}

	mk := rollupModelKey{provider: r.Provider, model: model, accountRef: acctRef, accountProvider: acctProv}
	mAgg := hb.models[mk]
	if mAgg == nil {
		mAgg = &rollupModelAgg{}
		hb.models[mk] = mAgg
	}
	mAgg.calls++
	mAgg.inputTokens += r.InputTokens
	mAgg.outputTokens += r.OutputTokens
	mAgg.cacheReadInputTokens += r.CacheReadInputTokens
	mAgg.cacheCreationInputTokens += r.CacheCreationInputTokens
	mAgg.reasoningOutputTokens += r.ReasoningOutputTokens
	mAgg.totalTokens += r.TotalTokens
	mAgg.costUSD.add(costUSD)

	if sessID != "" {
		sk := rollupSessionKey{provider: r.Provider, sessionID: sessID, model: model, accountRef: acctRef, accountProvider: acctProv}
		sAgg := hb.sessions[sk]
		if sAgg == nil {
			sAgg = &rollupSessionAgg{}
			hb.sessions[sk] = sAgg
		}
		sAgg.calls++
		sAgg.inputTokens += r.InputTokens
		sAgg.outputTokens += r.OutputTokens
		sAgg.cacheReadInputTokens += r.CacheReadInputTokens
		sAgg.cacheCreationInputTokens += r.CacheCreationInputTokens
		sAgg.reasoningOutputTokens += r.ReasoningOutputTokens
		sAgg.totalTokens += r.TotalTokens
		sAgg.costUSD.add(costUSD)
		if !sAgg.hasTimestamp {
			sAgg.hasTimestamp = true
			sAgg.minTimestampMS = r.TimestampMS
			sAgg.maxTimestampMS = r.TimestampMS
		} else {
			if r.TimestampMS < sAgg.minTimestampMS {
				sAgg.minTimestampMS = r.TimestampMS
			}
			if r.TimestampMS > sAgg.maxTimestampMS {
				sAgg.maxTimestampMS = r.TimestampMS
			}
		}
		if project != "" && (sAgg.maxProject == "" || project > sAgg.maxProject) {
			sAgg.maxProject = project
		}
		if cwd != "" && (sAgg.maxCWD == "" || cwd > sAgg.maxCWD) {
			sAgg.maxCWD = cwd
		}
		if r.GitBranch != "" && (sAgg.maxGitBranch == "" || r.GitBranch > sAgg.maxGitBranch) {
			sAgg.maxGitBranch = r.GitBranch
		}
	}
}
