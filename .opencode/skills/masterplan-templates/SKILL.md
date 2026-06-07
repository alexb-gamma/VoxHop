---
name: masterplan-templates
description: "Reference templates for MASTERPLAN governance documents: Feature Spec, Feature Contract, Delivery Schedule, and Roadmap. Use these as the canonical structure when creating new governance files."
---

## What I Do

I provide the **canonical templates** for all MASTERPLAN governance documents. Agents creating new features, roadmaps, or delivery schedules MUST follow these structures exactly.

---

## Template 1: Feature Specification (`FEATURES/*.md`)

```markdown
# FEATURE: [Feature Name]

## 1. PROBLEM STATEMENT
**What specific problem is this feature solving?**
[Define the gap in current functionality or the specific user pain point.]

## 2. VISION
[The "What" and "Why". Describe the objective and how it serves the product's mission.]

## 3. CORE CAPABILITIES

### 3.1 [Capability Name]
*   **Trigger**: [What initiates this capability]
*   **Input**: [What data/context is required]
*   **Output**: [What the system produces — be specific about format]
*   **Behaviour**: [Step-by-step logic]

### 3.2 [Capability Name]
*   **Trigger**: [...]
*   **Input**: [...]
*   **Output**: [...]

## 4. TECHNICAL IMPLEMENTATION

### 4.1 Architecture
[How this feature fits into the project structure. Which packages/modules are affected.]

### 4.2 New/Modified Components
*   **[Component]**: [Description of new or modified item]

### 4.3 Logic Flow
1. [Step 1]
2. [Step 2]
3. [Step 3]

### 4.4 Engineering Strategy *(Added by Engineering Team)*
*   **Technical Approach**: [Description]
*   **Complexity**: [1-10] — [Reasoning]
*   **Risks**: [Identified risks and mitigations]
*   **Ticket Breakdown**: [List of implementation tickets]

## 5. ACCEPTANCE CRITERIA

### 5.1 Functional (The Happy Path)
*Co-signed by PO and Engineering.*

| ID | Criterion | Verified |
|:---|:----------|:---------|
| ACC-01 | [When X happens, Y should result] | ☐ |
| ACC-02 | [...] | ☐ |

### 5.2 Negative (The Unhappy Path)
*Co-signed by Integration Test Team.*

| ID | Criterion | Test Scenario | Verified |
|:---|:----------|:-------------|:---------|
| NEG-01 | [When X fails, the system should Y] | [Test approach] | ☐ |
| NEG-02 | [...] | [...] | ☐ |

## 6. UI/UX DESIGN *(Added by UI/UX Specialist)*

### User Journey Maps
*(See UI/UX agent for required format)*

### Wireframes / Mockups
[Embedded images or links to design assets]

### Design Tokens
[Specific CSS classes, colours, typography, spacing]

## 7. ARCHITECTURAL GUIDANCE *(Added by Chief Architect)*

### Alignment
[How this feature fits with existing patterns]

### Constraints
[Patterns to follow, patterns to avoid]

### Dependencies
[Features/infrastructure this depends on]

## 8. DELIVERY & STATUS

### Phase
`NEXT` | `NOW` | `DONE`

### Dependencies
*   [Feature/infrastructure dependency]

### Co-Signs
| Agent | Status | Date |
|:------|:-------|:-----|
| Product Owner | ☐ PENDING | — |
| Chief Architect (INITIATE) | ☐ PENDING | — |
| UI/UX Specialist | ☐ PENDING | — |
| Engineering Team | ☐ PENDING | — |
| Integration Test | ☐ PENDING | — |
| Chief Architect (REVIEW) | ☐ PENDING | — |
| Sponsor Approval | ☐ PENDING | — |

### Regression Radius
*Features that may be affected by this change and should be tested:*
*   [Adjacent feature 1]
*   [Adjacent feature 2]
```

---

## Template 2: Feature Contract

The Feature Contract defines the **mandatory structure and lifecycle** of feature files. Key rules:

### File Structure (MANDATORY)
Every feature file MUST contain these sections:
1. **PROBLEM STATEMENT** — the gap or pain point
2. **VISION** — what and why
3. **CORE CAPABILITIES** — detailed breakdown
4. **TECHNICAL IMPLEMENTATION** — architecture, components, logic, engineering strategy
5. **ACCEPTANCE CRITERIA** — functional (happy) + negative (unhappy)
6. **UI/UX DESIGN** — wireframes, journeys, tokens (if applicable)
7. **ARCHITECTURAL GUIDANCE** — alignment, constraints, dependencies
8. **DELIVERY & STATUS** — phase, co-signs, regression radius

### Agent Responsibilities
| Agent | Responsibility |
|:------|:--------------|
| **Product Owner** | Owns `FEATURES/` directory. Vision, capabilities, transition law |
| **Engineering** | Adds Engineering Strategy + Complexity Score to §4 |
| **UI/UX** | Adds design spec to §6 (skip for backend-only) |
| **Chief Architect** | INITIATE guidance (§7) + REVIEW quality gate |
| **Integration Test** | Adds Negative Acceptance Criteria to §5.2 |

### Transition Law
No feature enters NOW without a complete feature file co-signed by all required agents.

---

## Template 3: Delivery Schedule (`DELIVERY_SCHEDULE.md`)

```markdown
# [PROJECT_NAME] DELIVERY SCHEDULE

## Summary Table

| Feature | Engineering Status | Verification Status | Notes |
| :--- | :--- | :--- | :--- |
| **[Feature Name]** | `IN PROGRESS` | `PENDING` | [Brief notes] |

---

## [Feature Name] — [Brief Description] (NOW) — *Entered [Date]*

> **Sponsor Directive**: [What the Sponsor asked for]
> **Feature Spec**: `MASTERPLAN/FEATURES/[filename].md`
> **All Co-Signs**: [List co-sign status]

| Ticket | File(s) | Status | Description |
| :--- | :--- | :--- | :--- |
| **[PREFIX]-T01** | `[file]` [NEW/MODIFY] | `NOT STARTED` | [Description] |
| **[PREFIX]-T02** | `[file]` [NEW/MODIFY] | `NOT STARTED` | [Description] |
| **[PREFIX]-T03** | `[file]` [NEW/MODIFY] | `NOT STARTED` | [Description] |

> **Strategy**: [Execution order and rationale]
> **Complexity**: [1-10 Score]
> **Risks**: [Identified risks and mitigations]

---

> **Archived DONE items**: See [DELIVERY_SCHEDULE_ARCHIVE.md](DELIVERY_SCHEDULE_ARCHIVE.md)
```

---

## Template 4: Roadmap (`ROADMAP.md`)

```markdown
# [PROJECT_NAME] ROADMAP

## DONE
*Items moved here after Integration Test VERIFIED + Architect POST-IMPL REVIEW + Sponsor final sign-off.*

## NOW *(Single-item focus)*
*Only ONE feature may occupy this slot at any time.*

## NEXT
*Features queued for analysis, co-sign, and design.*

### [Category]
*   **[Feature Name]** — [Feature Spec](FEATURES/[filename].md):
    -   *Status*: `AWAITING CO-SIGN`.
    -   *Goal*: [Brief description].
    -   *Dependencies*: [List or "None"].

## LATER
*Strategic features deferred until the foundation is solid.*

*   **[Feature Name]**:
    *   *Goal*: [Brief description].
    *   *Dependencies*: [What must be DONE first].
```

---

## Template 5: MASTER_VISION.md

```markdown
# [PROJECT_NAME]: [TAGLINE]
## [SUBTITLE]

### I. MISSION
[One paragraph: what the product does and why it matters.]

### II. THE [PERSONA_NAME] PERSONA
[PROJECT_NAME] is inspired by the spirit of [persona/philosophy].
*   **[Trait 1]**: [Description]
*   **[Trait 2]**: [Description]
*   **[Trait 3]**: [Description]

### III. CORE PHILOSOPHIES (NON-NEGOTIABLE)
1.  **[Philosophy 1]**: [Description]
2.  **[Philosophy 2]**: [Description]

### IV. TACTICAL OBJECTIVES
*   **[Objective 1]**: [Description]
*   **[Objective 2]**: [Description]

### V. OPERATING TONE
[PROJECT_NAME] is **[Adjective], [Adjective], and [Adjective].**

### VI. PRODUCT BOUNDARIES
**[PROJECT_NAME] IS:**
*   [Bullet list of what the product does]

**[PROJECT_NAME] IS NOT:**
*   [Bullet list of explicit exclusions]

---

## TECHNICAL DIRECTIVES (STRICT)
**Runtime**: [Language / version].
**Stack**: [Key frameworks and services].
**Schema**: [Schema enforcement approach].
**Verification**: [Testing mandate].
```

---

## Usage

Agents should reference these templates when:
- **Project Initiator**: Creating `MASTER_VISION.md` and `ROADMAP.md` for a new initiative
- **Product Owner**: Creating new feature specs in `FEATURES/`
- **Product Owner**: Setting up `DELIVERY_SCHEDULE.md` for a NOW feature
- **Any Agent**: Verifying a governance document follows the correct structure
