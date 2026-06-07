---
name: sdd-implement
description: "Execute implementation tickets with TDD enforcement. Maps to SpecKit's /speckit.implement phase. Implementation follows the red-green-refactor cycle with mandatory test gates before completion."
---

## What I Do

I enforce the **Implement** phase of Spec-Driven Development. This is where code is written — but only after the Constitution, Specification, Plan, and Tasks phases are complete. Implementation follows strict TDD and must pass the automated test gate before Sponsor presentation.

---

## When to Use

- **Engineering**: When executing tickets from DELIVERY_SCHEDULE.md
- **Product Owner**: To verify that implementation is following the approved plan

---

## Pre-Implementation Checklist

Before writing ANY code, verify:

- [ ] Feature has a complete spec in `MASTERPLAN/FEATURES/*.md` (§1-7 filled)
- [ ] All required co-signs are recorded in §8 (Architect INITIATE, Engineering, Test, UI/UX if applicable)
- [ ] Feature is in NOW status in ROADMAP.md
- [ ] Tickets are listed in DELIVERY_SCHEDULE.md with correct ordering
- [ ] The specific ticket being worked is set to `IN PROGRESS`
- [ ] No other ticket is `IN PROGRESS` (one at a time)

---

## Workflow (Per Ticket)

```
1. READ the ticket from DELIVERY_SCHEDULE.md — understand file target and description
2. READ the feature spec — specifically the relevant capability and acceptance criteria
3. READ the architectural guidance (§7) for constraints
4. LOAD the tdd-enforcement skill
5. EXECUTE Red-Green-Refactor:
   a. RED: Write a failing test that captures the acceptance criterion
   b. GREEN: Write the minimum code to make the test pass
   c. REFACTOR: Clean up while keeping tests green
6. UPDATE ticket status to DONE in DELIVERY_SCHEDULE.md
7. IF this is the last ticket:
   a. LOAD the automated-test-gate skill
   b. RUN: npx tsc --noEmit (must be zero errors)
   c. RUN: npx vitest run (all tests must pass)
   d. UPDATE feature spec §8 — mark Engineering verification complete
   e. REPORT to Product Owner: ready for Sponsor presentation
```

---

## Implementation Rules

### Code Quality
- Follow patterns established in existing codebase (check `AGENTS.md` for architecture)
- Use Zod for all runtime schema validation
- TypeScript strict mode — no `any` types, no `@ts-ignore`
- Preserve existing comments and docstrings unrelated to changes

### File Discipline
- Only modify files listed in the ticket's file target
- If you need to modify an unlisted file, update DELIVERY_SCHEDULE.md first
- New files MUST be [NEW] tagged in the ticket

### Testing
- Every ticket that adds logic MUST have corresponding test coverage
- Tests go in the same directory structure under `test/`
- Use Vitest (not Jest, not Mocha)

### Completion
- Never mark a ticket DONE without running `npx tsc --noEmit`
- Never present to Sponsor without `npx vitest run` passing
- The automated-test-gate skill is the final guardian

---

## Cross-References

This skill works in concert with:
- **`tdd-enforcement`** — The red-green-refactor cycle for each ticket
- **`automated-test-gate`** — The build + test verification before Sponsor presentation
- **`co-sign-protocol`** — The multi-agent review that precedes implementation
- **`feature-lifecycle`** — The phase transitions (NEXT → NOW → DONE)

---

## Key Principle

> "Implementation is the last mile, not the first. By the time you write code, the what (specify), the how (plan), and the sequence (tasks) are already decided. Your job is to execute with precision."
