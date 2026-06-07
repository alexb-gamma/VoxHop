---
name: sdd-tasks
description: "Break feature plans into actionable delivery tickets. Maps to SpecKit's /speckit.tasks phase. Tasks are tracked in DELIVERY_SCHEDULE.md with clear file targets, dependencies, and execution order."
---

## What I Do

I enforce the **Tasks** phase of Spec-Driven Development. This phase transforms the technical plan (from the Plan phase) into a concrete, ordered list of implementation tickets tracked in `MASTERPLAN/DELIVERY_SCHEDULE.md`.

---

## When to Use

- **Product Owner**: After all co-signs are complete and the feature is promoted to NOW
- **Engineering**: To understand the execution sequence before beginning implementation
- **Integration Test**: To understand what to verify after implementation

---

## Workflow

```
1. READ the feature spec — specifically §4.4 (Engineering Strategy / Ticket Breakdown)
2. READ the current DELIVERY_SCHEDULE.md to understand the format
3. LOAD the masterplan-templates skill for the Delivery Schedule template
4. CREATE a new section in DELIVERY_SCHEDULE.md:

   ## [Feature Name] — [Brief Description] (NOW) — *Entered [Date]*
   
   > **Sponsor Directive**: [What the Sponsor asked for]
   > **Feature Spec**: `MASTERPLAN/FEATURES/[filename].md`
   > **All Co-Signs**: [List co-sign status]
   
   | Ticket | File(s) | Status | Description |
   | :--- | :--- | :--- | :--- |
   | **[PREFIX]-T01** | `[file]` [NEW/MODIFY] | `NOT STARTED` | [Description] |
   | **[PREFIX]-T02** | `[file]` [NEW/MODIFY] | `NOT STARTED` | [Description] |
   
   > **Strategy**: [Execution order and rationale]
   > **Complexity**: [1-10 Score from Engineering §4.4]
   > **Risks**: [From Engineering §4.4]

5. UPDATE the Summary Table at the top of DELIVERY_SCHEDULE.md
6. UPDATE ROADMAP.md — move the feature from NEXT to NOW
```

---

## Ticket Formatting Rules

Each ticket MUST have:
- **Unique ID**: `[PREFIX]-T01` format (e.g., `SHV-T01`, `CTC-T01`)
- **File target**: Exact file path with `[NEW]` or `[MODIFY]` tag
- **Status**: One of `NOT STARTED`, `IN PROGRESS`, `DONE`
- **Description**: One-line description of what the ticket produces

Ticket ordering MUST respect dependencies:
- Infrastructure/interface tickets before implementation tickets
- Schema/type tickets before logic tickets
- Core functionality before edge cases
- Tests alongside or immediately after their implementation ticket (TDD)

---

## Quality Checklist

- [ ] Every ticket from §4.4 is present in the delivery schedule
- [ ] Tickets have correct [NEW]/[MODIFY] file tags
- [ ] Execution order respects dependency chain
- [ ] Summary table updated at top of DELIVERY_SCHEDULE.md
- [ ] ROADMAP.md updated: feature moved from NEXT to NOW
- [ ] Feature spec §8 Phase updated to `NOW`
- [ ] Only ONE feature in NOW (Single-Feature NOW Rule)

---

## Key Principle

> "A ticket that cannot be completed in a single engineering session is too large. Break it down until each ticket produces a testable, committable unit of work."
