---
name: sdd-constitution
description: "Establish or review the project's governing principles. Maps to SpecKit's /speckit.constitution phase. The constitution defines immutable rules that every agent and every feature must respect."
---

## What I Do

I enforce the **Constitution** phase of Spec-Driven Development. The constitution captures the project's non-negotiable principles, coding standards, architectural mandates, and quality thresholds. It is established once at project inception and updated only by Sponsor directive.

In BBP Assistant, the constitution is split across two authoritative files:

1. **`MASTERPLAN/MASTER_VISION.md`** — Mission, persona, core philosophies, product boundaries, operating tone
2. **`MASTERPLAN/TECHNICAL_GUIDANCE.md`** — Approved topologies, protocols, security controls, runtime mandates

---

## When to Use

- **Project Initiator**: When bootstrapping a new initiative — create both files
- **Product Owner**: Before beginning any co-sign cycle — verify the feature aligns with constitutional principles
- **Chief Architect**: In INITIATE mode — cite specific constitutional clauses that constrain the feature's design
- **Any Agent**: When unsure whether a decision is permissible — check the constitution first

---

## Workflow

### Creating a Constitution (New Project)
```
1. READ the Sponsor's vision and constraints
2. DRAFT MASTER_VISION.md using the masterplan-templates skill
   - Mission, Persona, Core Philosophies, Tactical Objectives, Operating Tone, Product Boundaries
3. DRAFT TECHNICAL_GUIDANCE.md
   - Runtime, stack, schema enforcement, testing mandates, security controls
4. PRESENT to Sponsor for review
5. ITERATE until Sponsor signs off
6. COMMIT — these files are now immutable without Sponsor approval
```

### Reviewing Against Constitution (Existing Project)
```
1. READ MASTER_VISION.md — internalise core philosophies and boundaries
2. READ TECHNICAL_GUIDANCE.md — internalise technical mandates
3. EVALUATE the proposed feature/change against each philosophy and mandate
4. FLAG any violations with specific clause references
5. REPORT constitutional compliance status
```

---

## Constitutional Compliance Checklist

When evaluating any feature against the constitution, verify:

- [ ] Does this serve the mission statement in MASTER_VISION.md §I?
- [ ] Does this respect all core philosophies in §III?
- [ ] Is this within the product boundaries in §VI?
- [ ] Does the technical approach follow TECHNICAL_GUIDANCE.md mandates?
- [ ] Does the testing approach meet the verification mandate?
- [ ] Does the schema approach follow the schema enforcement mandate?

---

## Key Principle

> "The constitution is not a suggestion — it is the law. Features that violate constitutional principles are rejected, regardless of how clever the implementation."
