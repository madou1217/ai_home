# Least Privilege Guideline

## Purpose
This guideline defines minimum-access rules for AI Home runtime, tooling, and operations so every actor (human or service) gets only the permissions required to perform its task.

## Core Principles
- Deny by default: every permission starts as disallowed.
- Grant minimum scope: restrict by resource, action, and time.
- Separate duties: avoid combining approval, execution, and audit in one identity.
- Use short-lived credentials: prefer session tokens over long-lived secrets.
- Require traceability: every privileged action must be attributable and logged.

## Access Model
- Human roles:
  - `viewer`: read-only access to logs, status, and reports.
  - `operator`: run approved operational commands within runbook scope.
  - `admin`: manage policy, credential rotation, and break-glass approvals.
- Service roles:
  - `runtime`: execute workload with sandbox profile and read-only runtime config.
  - `automation`: perform scoped CI/CD and reporting actions only.

## Permission Boundaries
- Filesystem:
  - Mount runtime config and binaries as read-only where possible.
  - Grant write access only to required workspace, tmp, and log paths.
- Network:
  - Default outbound deny; allowlist required destinations and ports.
  - Prevent inbound listening unless explicitly required by design.
- Process/runtime:
  - Run as non-root identity.
  - Apply syscall, capability, and resource limits in sandbox profiles.
- Secrets:
  - Store in managed secret backends, never in source tree.
  - Rotate on schedule and immediately on suspected exposure.

## Implementation Checklist
- Define role-to-action matrix for each subsystem.
- Remove wildcard permissions (`*`) from policies.
- Replace shared credentials with unique principals.
- Enforce TTL on tokens and session credentials.
- Add mandatory approval path for break-glass actions.
- Verify audit logs include actor, action, target, and result.

## Verification
- Monthly access review for human and service roles.
- Quarterly least-privilege regression audit against current policies.
- Incident postmortems must include permission-scope analysis.

## Exception Handling
- Exceptions require documented business justification, owner, and expiry date.
- Expired exceptions are revoked automatically or blocked at policy layer.
- Emergency elevation must be time-boxed and post-reviewed within 24 hours.
