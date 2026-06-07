---
name: sdd-plan
description: "Create technical implementation plans within feature specs. Maps to SpecKit's /speckit.plan phase. Plans define the How — architecture, components, logic flows, and engineering strategy."
---

## What I Do

I enforce the **Plan** phase of Spec-Driven Development. This phase adds the *how* to the *what* — defining the architecture, components, logic flows, and engineering strategy for an already-specified feature.

In BBP Assistant, technical plans are embedded directly in the feature spec file (`MASTERPLAN/FEATURES/*.md`) in sections §4 (Technical Implementation) and §7 (Architectural Guidance).

---

## When to Use

- **Chief Architect (INITIATE mode)**: Add §7 Architectural Guidance — alignment, constraints, dependencies
- **Engineering Team**: Add §4.4 Engineering Strategy — approach, complexity, risks, ticket breakdown
- **Product Owner**: Orchestrate the plan phase during co-sign by dispatching to `@chief-architect` then `@engineering`

---

## Workflow

### Architect INITIATE (§7 — Architectural Guidance)
```
1. READ the feature spec §1-3 (Problem, Vision, Capabilities)
2. READ TECHNICAL_GUIDANCE.md for applicable mandates
3. LOAD the sdd-constitution skill and verify constitutional compliance
4. WRITE §7 — Architectural Guidance:
   a. Alignment: How this fits with existing patterns and interfaces
   b. Constraints: Patterns to follow, patterns to avoid, non-negotiables
   c. Dependencies: Other features or infrastructure required
5. IDENTIFY risks and document mitigations
6. CO-SIGN: Add Architect INITIATE sign-off to §8 Co-Signs table
```

### Engineering Strategy (§4 — Technical Implementation)
```
1. READ §1-3 (what to build) and §7 (architectural constraints)
2. WRITE §4.1 — Architecture: modules affected, package placement
3. WRITE §4.2 — New/Modified Components: specific files and interfaces
4. WRITE §4.3 — Logic Flow: step-by-step algorithm
5. WRITE §4.4 — Engineering Strategy:
   a. Technical Approach: concise description
   b. Complexity: 1-10 score with reasoning
   c. Risks: identified risks with mitigations
   d. Ticket Breakdown: list of implementation tickets (PREFIX-T01, T02, etc.)
6. CO-SIGN: Add Engineering sign-off to §8 Co-Signs table
```

---

## Quality Checklist

Before a plan is considered complete:

- [ ] Architect INITIATE §7 is filled with alignment, constraints, and dependencies
- [ ] Engineering §4.1-4.3 describes architecture, components, and logic flow
- [ ] Engineering §4.4 has complexity score, risks, and ticket breakdown
- [ ] All tickets have clear file targets ([NEW] or [MODIFY]) and descriptions
- [ ] Plan respects all constraints from TECHNICAL_GUIDANCE.md
- [ ] No orphan dependencies — every dependency is either DONE or explicitly listed
- [ ] Both Architect INITIATE and Engineering co-signs recorded in §8

---

## Key Principle

> "A plan without constraints is a wish. The architect defines the boundaries; the engineer fills the space within them."
