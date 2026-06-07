---
name: sdd-specify
description: "Create feature specifications that capture the What and Why. Maps to SpecKit's /speckit.specify phase. Specifications define the problem, vision, and capabilities before any technical planning begins."
---

## What I Do

I enforce the **Specify** phase of Spec-Driven Development. This phase captures the *what* and *why* of a feature — the problem statement, the vision, and the core capabilities — before any technical design begins.

In BBP Assistant, specifications are authored as feature files in `MASTERPLAN/FEATURES/*.md` following the template from the `masterplan-templates` skill.

---

## When to Use

- **Product Owner**: When a Sponsor selects a feature from NEXT for development
- **Product Owner**: When a new feature idea needs formalisation
- **Any Agent**: When asked "what does this feature do?" — point to the spec

---

## Workflow

```
1. LOAD the masterplan-templates skill for the Feature Spec template
2. CREATE a new file: MASTERPLAN/FEATURES/<feature-slug>.md
3. COMPLETE Section 1 — PROBLEM STATEMENT
   - What specific problem is this feature solving?
   - Who suffers from this problem today?
   - What is the cost of inaction?
4. COMPLETE Section 2 — VISION
   - The "What" and "Why"
   - How does this serve the mission in MASTER_VISION.md?
5. COMPLETE Section 3 — CORE CAPABILITIES
   - For each capability: Trigger, Input, Output, Behaviour
   - Be specific about data formats and edge cases
6. COMPLETE Section 8 — DELIVERY & STATUS
   - Set Phase to NEXT
   - Set all Co-Signs to PENDING
   - List dependencies
7. UPDATE ROADMAP.md — add the feature to the appropriate NEXT category
8. PRESENT to Sponsor for initial review
```

---

## Quality Checklist

Before a specification is considered complete:

- [ ] Problem statement is specific and measurable (not "improve X")
- [ ] Vision clearly links to a MASTER_VISION.md philosophy
- [ ] Each capability has explicit Trigger, Input, Output, and Behaviour
- [ ] Output formats are concrete (JSON schema, specific fields, exact responses)
- [ ] Edge cases and boundary conditions are documented in capabilities
- [ ] No technical implementation details in §1-3 (that's the Plan phase)
- [ ] Feature added to ROADMAP.md under NEXT with correct status
- [ ] Dependencies explicitly listed

---

## Anti-Patterns

❌ **Vague specs**: "Make it better" — specify *what* "better" means measurably
❌ **Solution-first specs**: "Use WebSocket for X" — describe the *need*, not the *how*
❌ **Missing boundaries**: Always state what the feature does NOT do
❌ **Orphaned specs**: Every spec MUST be referenced in ROADMAP.md

---

## Key Principle

> "A specification that an engineer cannot implement without asking clarifying questions is incomplete. The spec is the contract — ambiguity in the spec becomes ambiguity in the code."
