# Ops On-call Handoff Checklist

## Goal
Use this checklist at every shift handoff to keep incident context, operational risk, and ownership continuity clear.

## Handoff Trigger
- Shift change starts within 30 minutes.
- Any P1/P2 incident is active or under active monitoring.
- Any production-risking change is in-flight (release, migration, rollback, infra mutation).

## Pre-Handoff Preparation (Outgoing)
- Confirm active incidents by severity, owner, and current customer impact.
- Snapshot service health signals: alerts, error rate, latency, saturation, and queue/backlog.
- List open actions with ETA and explicit next owner.
- Capture pending decisions, required approvals, and escalation deadlines.
- Summarize last 4 hours of timeline events with exact timestamps.

## Live Handoff Steps (Outgoing + Incoming)
1. Confirm both engineers are present and have production access.
2. Review active incidents first (highest severity to lowest).
3. Review risky changes in progress and explicit stop/rollback criteria.
4. Transfer ownership for each active item with owner + deadline confirmation.
5. Confirm escalation path for unresolved blockers.
6. Record final handoff note in the incident channel/ticket.

## Required Handoff Note Template
Copy the template below into the ticket/channel and fill every field.

```text
[On-call Handoff]
Time:
Outgoing:
Incoming:

Active incidents:
- ID / Severity / Impact / Current status / Owner / Next update time

Risky changes in-flight:
- Change / Scope / Risk / Stop or rollback trigger / Owner

Open actions:
- Action / Priority / ETA / Owner

Escalations:
- Blocker / Escalation target / Deadline

Acknowledgement:
- Incoming on-call confirms ownership transfer for all listed items.
```

## Post-Handoff Validation (Incoming)
- Verify access to dashboards, logs, pager, and runbooks.
- Re-acknowledge all active pages and silence rules.
- Send first status update within 15 minutes after takeover.
- Re-check top-priority SLO panels and incident timelines.
- Confirm next planned checkpoint time in channel.

## Escalation Rules
- Escalate immediately for customer-impacting P1 without mitigation path.
- Escalate within 15 minutes if P2 is trending worse after takeover.
- If ownership is unclear, escalate to incident commander/on-call manager immediately.

## Completion Criteria
- Handoff note is published and linked to active incidents.
- Incoming owner explicitly acknowledges responsibility.
- No active incident, risky change, or blocker lacks named owner.
