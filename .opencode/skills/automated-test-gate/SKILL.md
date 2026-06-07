---
name: automated-test-gate
description: "Mandatory pre-Sponsor verification gate. TypeScript build and full test suite must pass before presenting any work for manual review."
---

## What I Do

I enforce the **Automated Test Gate** — a mandatory quality checkpoint that MUST pass before any work is presented to the Executive Sponsor for manual verification.

> **Sponsor Protection Doctrine**: The Sponsor's time is the most expensive resource in the project. Automation is the guard. Target: zero issues found during Sponsor manual verification.

## The Gate Sequence

### Gate 1: TypeScript Build Verification
```bash
npx tsc --noEmit
```
- **Pass criteria**: Zero errors, zero warnings
- **If fails**: Fix all type errors before proceeding. Do NOT present to Sponsor.

### Gate 2: Full Test Suite
```bash
npx vitest run --reporter=verbose
```
- **Pass criteria**: ALL tests pass (100% pass rate)
- **If fails**: Fix failing tests before proceeding. Do NOT present to Sponsor.

### Gate 3: Evidence Summary
After both gates pass, generate the verification summary:

```markdown
## Automated Test Gate — PASSED ✅

### Build Verification
- **Command**: `npx tsc --noEmit`
- **Result**: 0 errors
- **Timestamp**: [ISO date]

### Test Suite
- **Command**: `npx vitest run`
- **Total Tests**: [count]
- **Passed**: [count]
- **Failed**: 0
- **Timestamp**: [ISO date]

### Gate Status: CLEAR — Ready for Sponsor Verification
```

## When to Use Me

- Before presenting ANY completed ticket to the Sponsor
- Before marking a feature as COMPLETE in DELIVERY_SCHEDULE.md
- Before triggering Integration Test VERIFY mode
- Before requesting Chief Architect post-implementation REVIEW

## Hard Stop Rule

If either gate fails:
1. **STOP** — Do not proceed to the next step
2. **FIX** — Resolve the failures
3. **RE-RUN** — Execute the full gate sequence again
4. **Only proceed when both gates show zero failures**

No exceptions. No "known failing tests." No "we'll fix it later."
