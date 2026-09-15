# Branch consolidation — 2026-09-15

The user requested merging and keeping only main. PR #1 was merged after CI passed. Two already-integrated temporary branches were deleted. The five historical branches below contained unique commits and merge conflicts; several included obsolete removal of current proxy-pool/mihomo features. Their code was **not** silently merged or discarded. Each exact tip was preserved as a verified remote tag before deleting its branch with an expected-tip lease. Current native credential synchronization work is merged separately after full regression.

| Former branch | Preserved commit | Recoverable tag |
|---|---|---|
| `automation/models-dev-sync` | `53f7c298ce0169a8931f9aeac35b1029d5cf54c1` | `archive/20260915/automation/models-dev-sync` |
| `codex/account-egress-all-providers` | `1de190ece2624ee9b1973678ca544f4b298fae39` | `archive/20260915/codex/account-egress-all-providers` |
| `codex/live-toolkit-egress-integration-20260824` | `8919a7bf57a518a08a12846b8dad99d9ce6efe87` | `archive/20260915/codex/live-toolkit-egress-integration-20260824` |
| `codex/request-details-delivery-20260824` | `e16a5431fe886a6d44a89c5ccccb900772460f56` | `archive/20260915/codex/request-details-delivery-20260824` |
| `codex/toolkit-lifecycle-delivery-20260824` | `25f44bbf682e07a7032153bcc90214ea2059198a` | `archive/20260915/codex/toolkit-lifecycle-delivery-20260824` |

Restore one branch explicitly when its remaining changes are selected for reconciliation:

```sh
git fetch origin --tags
git switch -c restored-branch <archive-tag>
```

This record does not claim that all historical feature code is present in main. No force-push to main, credential data, private runtime files, or repository-visibility changes were involved.
