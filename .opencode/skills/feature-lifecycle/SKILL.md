---
name: feature-lifecycle
description: "Manages the LATER to NEXT to NOW to DONE feature lifecycle with 3 Sponsor approval gates and single-feature NOW constraint."
---

## What I Do

I codify the **Feature Lifecycle** — the governance framework that controls how features progress from idea to completion in the BBP Assistant project.

## The Lifecycle Phases

```
LATER → NEXT → NOW → DONE
```

### LATER (Backlog)
- Features with initial descriptions but no active analysis
- May be promoted to NEXT by Sponsor directive
- No co-sign required

### NEXT (Analysis Queue)
- Features undergoing co-sign analysis
- Status: `AWAITING CO-SIGN` or `CO-SIGN COMPLETE`
- Multiple features MAY be in NEXT simultaneously (with Sponsor approval)

### NOW (Active Implementation)
- **⚠️ SINGLE-FEATURE RULE**: Only ONE feature in NOW at any time
- Requires: All co-signs approved + Sponsor explicit approval
- Engineering implements against DELIVERY_SCHEDULE.md tickets

### DONE (Completed)
- Feature is verified, reviewed, and signed off
- Archived in DELIVERY_SCHEDULE_ARCHIVE.md

## The 3 Sponsor Gates

### Gate 1: Begin Co-Sign
**Trigger**: Sponsor selects which NEXT feature to analyse
**Action**: PO initiates co-sign protocol
**Rule**: Sponsor must explicitly approve before analysis begins

### Gate 2: Promote to NOW
**Trigger**: All co-signs approved, FEATURE.md is complete
**Action**: PO presents complete FEATURE.md to Sponsor
**Rule**: Sponsor must explicitly approve before feature moves to NOW

### Gate 3: Close as DONE
**Trigger**: Engineering COMPLETE + Test VERIFIED + Architect REVIEWED
**Action**: PO presents verification report to Sponsor
**Rule**: Sponsor must explicitly approve before feature moves to DONE

## Post-Closure Procedures

When a feature moves to DONE:
1. Update `MASTERPLAN/ROADMAP.md` — move feature to DONE section
2. Archive delivery details to `MASTERPLAN/DELIVERY_SCHEDULE_ARCHIVE.md`
3. Clear `MASTERPLAN/DELIVERY_SCHEDULE.md` for next feature
4. Update FEATURE.md status to `DONE — SPONSOR CLOSED [date]`

## Single-Feature Rule Enforcement

If a feature is in NOW:
- ❌ No other feature may enter NOW
- ✅ Other features may be in NEXT (analysis/co-sign)
- ✅ The NOW feature must complete or return to NEXT before another enters

## Parallel Analysis Exception

On explicit Sponsor instruction:
- Multiple NEXT features MAY be analysed simultaneously
- This does NOT affect the single-feature NOW constraint
- Each analysis still requires the full co-sign protocol
