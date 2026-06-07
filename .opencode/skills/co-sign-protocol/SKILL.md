---
name: co-sign-protocol
description: "Multi-agent co-sign sequence for feature approval. Orchestrates Architect INITIATE, UI/UX, Engineering, Test, and Architect REVIEW co-signs in strict order."
---

## What I Do

I define the **Co-Sign Protocol** — the mandatory multi-agent review sequence that every feature must pass before it can move from NEXT to NOW status.

## The Co-Sign Sequence

The Product Owner orchestrates this sequence in strict order:

### Step 1: Chief Architect — INITIATE Mode
```
@chief-architect Please review [FEATURE.md path] in INITIATE mode. 
Provide architectural guidance, constraints, and simplicity directives.
```
**Output**: Architectural Guidance section added to FEATURE.md

### Step 2: UI/UX Specialist — CO-SIGN Mode
*(Skip for backend-only features — annotate as "N/A — Backend Only")*
```
@ui-ux-specialist Please review [FEATURE.md path] in CO-SIGN mode.
Provide wireframes, interaction flows, component hierarchy, and user journey maps.
```
**Output**: UI/UX Design section + User Journey Maps added to FEATURE.md

### Step 3: Engineering Team — CO-SIGN Mode
```
@engineering Please review [FEATURE.md path] in CO-SIGN mode.
Provide complexity score, technical approach, risks, and ticket breakdown.
```
**Output**: Engineering Strategy section added to FEATURE.md

### Step 4: Integration Test Team — CO-SIGN Mode
```
@integration-test Please review [FEATURE.md path] in CO-SIGN mode.
Provide negative acceptance criteria, unhappy paths, and adversarial test scenarios.
```
**Output**: Negative Acceptance Criteria section added to FEATURE.md

### Step 5: Chief Architect — REVIEW Mode (Quality Gate)
```
@chief-architect Please review [FEATURE.md path] in REVIEW mode.
Evaluate ALL co-signs for alignment, simplicity, consistency, and holistic fit.
```
**Output**: Either `ARCHITECT CO-SIGN: ✅ APPROVED` or specific rejection feedback

### Rejection Loop
If the Architect rejects any co-sign:
1. PO routes rejection feedback to the relevant agent
2. Agent revises their co-sign
3. PO re-triggers Architect REVIEW
4. Repeat until Architect approves

## Completion Criteria
All 5 steps must be completed before presenting FEATURE.md to the Sponsor for NOW approval:
- [ ] Architect INITIATE guidance ✅
- [ ] UI/UX design co-sign ✅ (or N/A)
- [ ] Engineering strategy co-sign ✅
- [ ] Integration Test negative criteria ✅
- [ ] Architect REVIEW approval ✅

## Sponsor Gate
After all co-signs are approved, present the complete FEATURE.md to the Sponsor. The Sponsor must explicitly approve before the feature moves to NOW.
