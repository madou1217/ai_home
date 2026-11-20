package managementops

import (
	"strings"
)

type timeRange struct {
	FromMS int64
	ToMS   int64 // inclusive [FromMS, ToMS]
}

type usagePanelOptions struct {
	provider         string
	model            string
	needStats        bool
	needModels       bool
	needModelOptions bool
	needSessions     bool
	needPrompts      bool
	needTrend        bool
	trendOriginMS    int64
	trendBucketMS    int64
	trendFromMS      int64
	trendToMS        int64
}

type panelModelAcc struct {
	provider                 string
	model                    string
	calls                    int
	inputTokens              int64
	outputTokens             int64
	cacheReadInputTokens     int64
	cacheCreationInputTokens int64
	reasoningOutputTokens    int64
	totalTokens              int64
	costUSD                  usageCostSum
	unattributedCalls        int
	accountRefs              map[string]struct{}
}

type panelSessionAcc struct {
	part         UsageSessionPart
	costUSD      usageCostSum
	hasTimestamp bool
	accountRefs  map[string]struct{}
}

type usagePanelAccumulator struct {
	opts             usagePanelOptions
	stats            UsageStatsSummary
	statsCostUSD     usageCostSum
	sessionKeys      map[string]struct{}
	models           map[string]*panelModelAcc
	modelOptions     map[string]*panelModelAcc
	sessions         map[string]*panelSessionAcc
	promptCounts     map[string]int
	trendByStart     map[int64]*UsageTrendPoint
	trendCostByStart map[int64]usageCostSum
}

func newUsagePanelAccumulator(opts usagePanelOptions) *usagePanelAccumulator {
	acc := &usagePanelAccumulator{opts: opts}
	if opts.needStats && !opts.needSessions {
		acc.sessionKeys = make(map[string]struct{})
	}
	if opts.needModels {
		acc.models = make(map[string]*panelModelAcc)
	}
	if opts.needModelOptions {
		acc.modelOptions = make(map[string]*panelModelAcc)
	}
	if opts.needSessions {
		acc.sessions = make(map[string]*panelSessionAcc)
	}
	if opts.needPrompts && opts.needSessions {
		acc.promptCounts = make(map[string]int)
	}
	if opts.needTrend {
		acc.trendByStart = make(map[int64]*UsageTrendPoint)
		acc.trendCostByStart = make(map[int64]usageCostSum)
	}
	return acc
}

func addToPanelModelMap(
	dst map[string]*panelModelAcc,
	provider, model, accountRef string,
	calls int,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costSum usageCostSum,
) {
	key := provider + "\x00" + model
	item := dst[key]
	if item == nil {
		item = &panelModelAcc{
			provider:    provider,
			model:       model,
			accountRefs: make(map[string]struct{}),
		}
		dst[key] = item
	}
	item.calls += calls
	item.inputTokens += input
	item.outputTokens += output
	item.cacheReadInputTokens += cacheRead
	item.cacheCreationInputTokens += cacheCreate
	item.reasoningOutputTokens += reasoning
	item.totalTokens += total
	item.costUSD.addSum(costSum)
	if accountRef == "" {
		item.unattributedCalls += calls
	} else if trimmed := strings.TrimSpace(accountRef); isValidAccountRef(trimmed) {
		item.accountRefs[trimmed] = struct{}{}
	}
}

func (a *usagePanelAccumulator) addTrendBucket(
	tsMS int64,
	calls int,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costUSD float64,
) {
	a.addTrendBucketSum(tsMS, calls, input, output, cacheRead, cacheCreate, reasoning, total, usageCostSum{sum: costUSD})
}

func (a *usagePanelAccumulator) addTrendBucketSum(
	tsMS int64,
	calls int,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costSum usageCostSum,
) {
	if !a.opts.needTrend || a.opts.trendOriginMS <= 0 || a.opts.trendBucketMS <= 0 {
		return
	}
	idx := (tsMS - a.opts.trendOriginMS) / a.opts.trendBucketMS
	start := a.opts.trendOriginMS + idx*a.opts.trendBucketMS
	pt := a.trendByStart[start]
	if pt == nil {
		pt = &UsageTrendPoint{BucketStartMS: start}
		a.trendByStart[start] = pt
	}
	pt.Calls += calls
	pt.InputTokens += input
	pt.OutputTokens += output
	pt.CacheReadInputTokens += cacheRead
	pt.CacheCreationInputTokens += cacheCreate
	pt.ReasoningOutputTokens += reasoning
	pt.TotalTokens += total
	tc := a.trendCostByStart[start]
	tc.addSum(costSum)
	a.trendCostByStart[start] = tc
	pt.CostUSD = tc.value()
}

func (a *usagePanelAccumulator) addCanonicalRow(
	provider, model, accountRef, sessionID, project, cwd, gitBranch string,
	tsMS int64,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costUSD float64,
	includeTrend bool,
) {
	if a.opts.provider != "" && provider != a.opts.provider {
		return
	}
	costSum := usageCostSum{sum: costUSD}
	if a.opts.needModelOptions {
		addToPanelModelMap(
			a.modelOptions, provider, model, accountRef, 1,
			input, output, cacheRead, cacheCreate, reasoning, total, costSum,
		)
	}
	if a.opts.model != "" && model != a.opts.model {
		return
	}
	if a.opts.needStats {
		a.stats.TotalCalls++
		a.stats.InputTokens += input
		a.stats.OutputTokens += output
		a.stats.CacheReadInputTokens += cacheRead
		a.stats.CacheCreationInputTokens += cacheCreate
		a.stats.ReasoningOutputTokens += reasoning
		a.stats.TotalTokens += total
		a.statsCostUSD.add(costUSD)
		if !a.opts.needSessions && sessionID != "" {
			a.sessionKeys[provider+"\x00"+sessionID] = struct{}{}
		}
	}
	if a.opts.needModels {
		addToPanelModelMap(
			a.models, provider, model, accountRef, 1,
			input, output, cacheRead, cacheCreate, reasoning, total, costSum,
		)
	}
	if a.opts.needSessions && sessionID != "" {
		a.addSessionAggregateSum(
			provider, sessionID, accountRef, 1,
			input, output, cacheRead, cacheCreate, reasoning, total, costSum,
			tsMS, tsMS, project, cwd, gitBranch,
		)
	}
	if includeTrend && a.opts.needTrend {
		a.addTrendBucketSum(tsMS, 1, input, output, cacheRead, cacheCreate, reasoning, total, costSum)
	}
}

func (a *usagePanelAccumulator) addRollupModelRow(
	hourMS int64,
	provider, model, accountRef string,
	calls int,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costUSD float64,
	includeTrend bool,
) {
	a.addRollupModelRowSum(
		hourMS, provider, model, accountRef, calls,
		input, output, cacheRead, cacheCreate, reasoning, total,
		usageCostSum{sum: costUSD}, includeTrend,
	)
}

func (a *usagePanelAccumulator) addRollupModelRowSum(
	hourMS int64,
	provider, model, accountRef string,
	calls int,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costSum usageCostSum,
	includeTrend bool,
) {
	if a.opts.provider != "" && provider != a.opts.provider {
		return
	}
	if a.opts.needModelOptions {
		addToPanelModelMap(
			a.modelOptions, provider, model, accountRef, calls,
			input, output, cacheRead, cacheCreate, reasoning, total, costSum,
		)
	}
	if a.opts.model != "" && model != a.opts.model {
		return
	}
	if a.opts.needStats {
		a.stats.TotalCalls += calls
		a.stats.InputTokens += input
		a.stats.OutputTokens += output
		a.stats.CacheReadInputTokens += cacheRead
		a.stats.CacheCreationInputTokens += cacheCreate
		a.stats.ReasoningOutputTokens += reasoning
		a.stats.TotalTokens += total
		a.statsCostUSD.addSum(costSum)
	}
	if a.opts.needModels {
		addToPanelModelMap(
			a.models, provider, model, accountRef, calls,
			input, output, cacheRead, cacheCreate, reasoning, total, costSum,
		)
	}
	if includeTrend && a.opts.needTrend {
		a.addTrendBucketSum(hourMS, calls, input, output, cacheRead, cacheCreate, reasoning, total, costSum)
	}
}

func (a *usagePanelAccumulator) addSessionAggregate(
	provider, sessionID, accountRef string,
	calls int,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costUSD float64,
	minTS, maxTS int64,
	maxProject, maxCWD, maxGitBranch string,
) {
	a.addSessionAggregateSum(
		provider, sessionID, accountRef, calls,
		input, output, cacheRead, cacheCreate, reasoning, total,
		usageCostSum{sum: costUSD}, minTS, maxTS, maxProject, maxCWD, maxGitBranch,
	)
}

func (a *usagePanelAccumulator) addSessionAggregateSum(
	provider, sessionID, accountRef string,
	calls int,
	input, output, cacheRead, cacheCreate, reasoning, total int64,
	costSum usageCostSum,
	minTS, maxTS int64,
	maxProject, maxCWD, maxGitBranch string,
) {
	if sessionID == "" {
		return
	}
	key := provider + "\x00" + sessionID
	if !a.opts.needSessions {
		if a.opts.needStats {
			a.sessionKeys[key] = struct{}{}
		}
		return
	}
	sa := a.sessions[key]
	if sa == nil {
		sa = &panelSessionAcc{
			part:        UsageSessionPart{Provider: provider, SessionID: sessionID},
			accountRefs: make(map[string]struct{}),
		}
		a.sessions[key] = sa
	}
	p := &sa.part
	p.Calls += calls
	p.InputTokens += input
	p.OutputTokens += output
	p.CacheReadInputTokens += cacheRead
	p.CacheCreationInputTokens += cacheCreate
	p.ReasoningOutputTokens += reasoning
	p.TotalTokens += total
	sa.costUSD.addSum(costSum)
	if !sa.hasTimestamp {
		sa.hasTimestamp = true
		p.UsageStartedAtMS = minTS
		p.UsageUpdatedAtMS = maxTS
	} else {
		if minTS < p.UsageStartedAtMS {
			p.UsageStartedAtMS = minTS
		}
		if maxTS > p.UsageUpdatedAtMS {
			p.UsageUpdatedAtMS = maxTS
		}
	}
	if maxProject != "" && (p.UsageProject == "" || maxProject > p.UsageProject) {
		p.UsageProject = maxProject
	}
	if maxCWD != "" && (p.UsageCWD == "" || maxCWD > p.UsageCWD) {
		p.UsageCWD = maxCWD
	}
	if maxGitBranch != "" && (p.UsageGitBranch == "" || maxGitBranch > p.UsageGitBranch) {
		p.UsageGitBranch = maxGitBranch
	}
	if accountRef == "" {
		p.UnattributedCalls += calls
	} else if trimmed := strings.TrimSpace(accountRef); isValidAccountRef(trimmed) {
		sa.accountRefs[trimmed] = struct{}{}
	}
}

func (a *usagePanelAccumulator) addPromptCount(provider, sessionID string, count int) {
	if count <= 0 {
		return
	}
	if a.opts.provider != "" && provider != a.opts.provider {
		return
	}
	a.stats.TotalPrompts += count
	if a.opts.needSessions && sessionID != "" {
		a.promptCounts[provider+"\x00"+sessionID] += count
	}
}
