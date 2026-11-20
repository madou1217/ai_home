# Codex image 401 failover repair and AWS proxy hotfix

## Ownership and scope

This repair covers the Image Studio edit path for `codex:gpt-image-2` when the upstream proxy rejects an account OAuth session. It was driven by the local Image Studio session and the AWS proxy at `proxy.meadeo.com`. The local server and the AWS proxy now run the same source revision.

## Confirmed causes

1. **401 was not retryable.** `internal/adapters/images/registry.go` classified only 429 and 5xx as retryable. A 401/403 returned immediately, so the executor never asked for the next account even when healthy accounts existed.
2. **The proxy was running old code.** The AWS proxy package was built from `729a5bf5`, before the failover fix. Its image path therefore returned the first account's `invalidated oauth token` to the local client.
3. **Explicit `moderation=auto` changed routing.** The OpenAI-compatible parser kept the default value as an explicit parameter. On the proxy this led to a different image path that returned 401/403, while omitting the field succeeded. `moderation=auto` is the API default and must be normalized to absent.
4. **Three attempts were too few.** The proxy account pool had several OAuth sessions intermittently rejected at the same time. With `maxAttempts=3`, a healthy account later in the pool could be missed and the request reported failure.
5. **Failed revisions lost the account identity.** The Studio only recorded `accountRef` after a successful execution, so a failed revision could not show which account was attempted.

## Fixes

- `87ca93f4` — treat 401/403 as account-level failures that may fail over to the next candidate. Already-attempted accounts remain excluded by the executor.
- `a5ea96e2`, `89a0751d` — omit default `moderation=auto` from passthrough requests, including the raw client body path.
- `96d3b3bd` — normalize explicit `moderation=auto` to the default in the image request parser, so every client gets the same behavior.
- `d2239d55` — carry the last attempted account through `imageexecution.Result` and persist it on failed Studio revisions.
- `c80d4648` — raise the image account attempt cap from 3 to 5.

## Verification

- Local gateway `POST /v1/images/edits` with `moderation=auto`: 200, image returned.
- AWS proxy `POST /v1/images/edits` with `moderation=auto`: 200, image returned.
- Studio edit with a benign prompt (`把衣服颜色改成蓝色`): revision `rev_4d1538fe-7a7d-4aa8-b05a-5f7052330d21` succeeded, 1.98 MB PNG output.
- The original prompt that triggered the investigation is now rejected by the upstream safety system (400), not by authentication. This is a content-policy result and was not bypassed.
- All seven enabled Codex accounts on the AWS proxy were probed individually with `X-Account-Ref`; each returned 200. Accounts that had been marked `credential_rejected` were recovered by the token refresh daemon.
- Failed Studio revisions now record the attempted account; a safety-rejected retry recorded `acct_c016fd7eee0f64163068`.

## Credential self-heal

The image executor already carries the per-attempt `CredentialObservation` into `ObservedAttemptRecorder.RecordFailureWithReceipt`. For a non-static account whose 401 is classified as `FailureCredentialRejected` with account scope and `RecoveryCredentialsUpdated`, the recorder calls `BeginObservedCredentialRejection` and `TryScheduleCredentialRejection`; the token refresh daemon then force-refreshes that credential.

Static api_key credentials are deliberately excluded: they have no refresh token, so the image path records `static_credential_rejected` and relies on cooldown/failover instead of pretending a refresh is possible.

AWS evidence from the same incident: the token refresh daemon reported `credentialRejections.accepted=16` and `completed=16`, and the five OAuth accounts that had recorded `credential_rejected` were later probed individually with `X-Account-Ref` and all returned 200. The five-attempt image budget remains as a fallback for static-key/proxy races and for the window before a forced refresh lands.

## Deployment

- Local server: build stamp `source_sha c80d4648`, binary `08cacffb...`, `/readyz` 200.
- AWS proxy: build stamp `source_sha c80d4648`, binary `921e4d87...`, systemd unit `com.meadeo.ai_home` active/running.
- AWS rollback backup: `~/aih-hotfix-c80d4648/backup-20261120-161520/` (previous binary and build stamp).
- Older hotfix staging directories and temporary probe files were removed.

## Operational notes

- The AWS package directory and its `BUILD_INFO.json` / install receipt still describe the previous full installation. This was a binary hotfix; the supervisor-verified build stamp was updated. A future full package installation should refresh the package metadata.
- A separate agent's `tmpsmoke` test servers on the AWS host were left untouched.
