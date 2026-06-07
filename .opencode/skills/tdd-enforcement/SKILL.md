---
name: tdd-enforcement
description: "Enforces the Test-Driven Development red-green-refactor cycle. Must be activated when implementing any new feature behaviour."
---

## What I Do

I enforce the **Test-Driven Development** (TDD) workflow for all implementation work. When active, the Engineering agent MUST follow this strict sequence for every new behaviour.

## The Red-Green-Refactor Cycle

### Step 1: RED — Write the Failing Test
Before writing ANY production code:
1. Create the test file (or add to existing) in the appropriate `test/` directory
2. Write the test that describes the expected behaviour
3. Run `npx vitest run --reporter=verbose` to confirm the test **FAILS**
4. If the test passes without implementation → your test is wrong (it's testing nothing)

### Step 2: GREEN — Minimal Implementation
1. Write the **minimum** code needed to make the test pass
2. Do NOT add extra features, optimizations, or "nice-to-haves"
3. Run `npx vitest run --reporter=verbose` to confirm the test **PASSES**
4. If tests fail → fix the implementation, not the test

### Step 3: REFACTOR — Clean Up
1. Review the implementation for simplicity and pattern consistency
2. Remove duplication, improve naming, extract shared logic
3. Run `npx vitest run` to confirm all tests still pass
4. Run `npx tsc --noEmit` to verify type safety

### Step 4: VERIFY — Full Build
1. Run `npx tsc --noEmit` — zero type errors
2. Run `npx vitest run` — all tests pass (existing + new)
3. Only proceed to the next ticket if BOTH pass

## When to Use Me

- Every time the Engineering agent starts implementing a new ticket
- Every time a new behaviour is being added to an existing module
- Every time a bug fix introduces a regression test

## When NOT to Use Me

- Documentation-only changes
- Configuration file updates
- Infrastructure/Terraform changes (these have their own validation)

## Evidence Format

After completing TDD for a ticket, include this evidence:
```markdown
### TDD Evidence — Ticket [ID]
- **Test File**: [path]
- **New Tests**: [count]
- **Red Phase**: Confirmed failing ✅
- **Green Phase**: Confirmed passing ✅
- **Build**: `npx tsc --noEmit` — 0 errors ✅
- **Full Suite**: `npx vitest run` — [X] passed, 0 failed ✅
```
