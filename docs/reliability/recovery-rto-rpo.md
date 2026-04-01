# Recovery RTO/RPO Guide

## Purpose
This guide defines recovery time objective (RTO) and recovery point objective (RPO) targets for AI Home core services, and the operational procedure to meet those targets during incidents.

## Definitions
- `RTO`: Maximum acceptable service unavailability duration before users are materially impacted.
- `RPO`: Maximum acceptable data loss window measured as time between latest durable copy and incident point.

## Service Tiers And Objectives

| Tier | Service Scope | RTO Target | RPO Target | Recovery Strategy |
| --- | --- | --- | --- | --- |
| `Tier 0` | Auth/session control plane, command dispatch path | `<= 15 min` | `<= 1 min` | Active-standby failover + replicated metadata store |
| `Tier 1` | Task/session state, project runtime metadata | `<= 60 min` | `<= 5 min` | Point-in-time restore + replay from append-only logs |
| `Tier 2` | Audit/export archives, analytics snapshots | `<= 24 h` | `<= 24 h` | Scheduled backup restore |

## Recovery Modes

| Incident Class | Trigger Condition | Target Tier | Recovery Mode | Owner |
| --- | --- | --- | --- | --- |
| `SEV-1` | Global outage or control plane unavailable | Tier 0 | Regional failover and traffic cutover | Incident commander + platform on-call |
| `SEV-2` | Major feature path degraded, partial task execution failure | Tier 1 | Stateful service restart and log replay restore | Runtime on-call |
| `SEV-3` | Non-critical workflows impacted, no core data loss | Tier 2 | Batch restore and deferred rebuild | Service owner |

## Recovery Procedure
1. Declare incident severity and freeze risky rollouts.
2. Confirm current data durability point from backups, snapshots, and append logs.
3. Select recovery mode based on impacted tier and incident class.
4. Execute failover or restore workflow with explicit start timestamp.
5. Validate control-plane health, task execution path, and session consistency.
6. Record achieved RTO and measured RPO in incident timeline.
7. Communicate status every 10 minutes until all acceptance checks pass.
8. Run post-incident review and create corrective actions for objective misses.

## Acceptance Checks Before Incident Closure
- Auth/session lifecycle succeeds for smoke accounts.
- Command execution success rate is back within normal baseline.
- No unreconciled task/session records remain in recovery window.
- Audit trail includes incident timeline, recovery command logs, and owner sign-off.

## Measurement And Evidence
- RTO is measured from incident declaration timestamp to production health restoration timestamp.
- RPO is measured from incident timestamp to latest confirmed durable data point.
- Evidence artifacts:
  - incident timeline with UTC timestamps
  - backup/restore job IDs
  - replay range and checksum records
  - verification outputs from smoke checks

## Drill Cadence
- `Tier 0`: monthly failover drill.
- `Tier 1`: bi-weekly restore and replay drill.
- `Tier 2`: quarterly backup recovery audit.
- Any missed drill must be rescheduled within 7 calendar days and tracked in ops review.

## Escalation Policy
- If projected RTO breach risk exceeds 50% of target budget, page secondary on-call immediately.
- If RPO cannot meet target after first restore attempt, escalate to incident commander and data owner.
- If both RTO and RPO breach, open a mandatory corrective-action item with due date and executive review.
