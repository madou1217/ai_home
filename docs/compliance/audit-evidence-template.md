# Audit Evidence Template

## Scope
This template standardizes audit evidence collection for security, compliance, and release controls in the AI Home ecosystem.
Use one evidence package per control assessment window (for example monthly, quarterly, or release-based reviews).

## Document Metadata
- Evidence package ID:
- Control framework:
- Control ID:
- Control title:
- Evidence period start:
- Evidence period end:
- Service / system:
- Environment: Production / Staging / Development
- Prepared by:
- Reviewer:
- Approval date:
- Version:

## Control Statement
- Control objective:
- Risk addressed:
- Policy / standard reference:
- In-scope assets:
- Out-of-scope assets:

## Evidence Index
| Evidence ID | Evidence type | Source system | Collection date | Owner | Integrity hash / reference | Storage location |
| --- | --- | --- | --- | --- | --- | --- |
| E-001 |  |  |  |  |  |  |
| E-002 |  |  |  |  |  |  |
| E-003 |  |  |  |  |  |  |

## Collection Procedure
1. Confirm control scope, period, and required data sources with control owner.
2. Collect raw evidence directly from authoritative systems.
3. Record command/query/export method and timestamp for each artifact.
4. Compute and record artifact integrity hash where applicable.
5. Store evidence in approved repository path with least-privilege access.
6. Complete reviewer validation and finalize approval.

## Evidence Details
### Evidence Item: E-001
- Description:
- Why this evidence supports the control:
- Collection method:
- Raw command / query / workflow:
```bash
# example
aih doctor
```
- Output snapshot reference:
- Timestamp (UTC):
- Collected by:
- Reviewer validation result:

### Evidence Item: E-002
- Description:
- Why this evidence supports the control:
- Collection method:
- Raw command / query / workflow:
```bash
# example
aih proxy status
```
- Output snapshot reference:
- Timestamp (UTC):
- Collected by:
- Reviewer validation result:

## Sampling and Coverage
- Population definition:
- Sampling strategy:
- Sample size:
- Coverage rationale:
- Known exclusions:

## Exceptions and Compensating Controls
| Exception ID | Description | Impact | Compensating control | Owner | Target remediation date | Status |
| --- | --- | --- | --- | --- | --- | --- |
| X-001 |  |  |  |  |  | Open |

## Review and Approval
- Reviewer checklist:
  - [ ] Evidence is complete and traceable to control requirements.
  - [ ] Integrity references are recorded and reproducible.
  - [ ] Data handling follows retention and confidentiality policy.
  - [ ] Exceptions are documented with owners and target dates.
- Reviewer name:
- Reviewer decision: Approved / Rework required
- Decision timestamp (UTC):
- Approver name:
- Final approval timestamp (UTC):

## Retention and Access
- Retention policy reference:
- Required retention period:
- Disposal date:
- Storage class:
- Access group(s):
- Last access review date:

## Change Log
| Date (UTC) | Author | Change summary | Version |
| --- | --- | --- | --- |
| 2026-03-01 | sca07 | Initial audit evidence template for roadmap task T007. | v1 |

