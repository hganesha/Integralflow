# Style Guide — Financial Crime Experience Platform

Version 1.0 · 2026-11-07 · Living reference: [style-guide.html](style-guide.html) · Tokens: [tokens.json](tokens.json), [assets/tokens.css](assets/tokens.css) · Components: [assets/components.css](assets/components.css)

This guide turns the visual language in UX spec §3.3 and the concept drawings in `ui-constructs/` into rules engineers and designers can apply consistently. When this guide and a mockup disagree, this guide wins. When this guide and the UX spec disagree, raise it — don't pick silently.

---

## 1. Character

**An instrument, not a dashboard.** The product borrows the *behaviour* of a well-made analog instrument: fixed control positions, banks of keys, engraved labels and calm surfaces. It also means honest feedback, where nothing moves unless something happened. It does not imitate hardware with skeuomorphic chrome.

Four commitments follow from that:

1. **Stable geography.** Banks, regions and key positions never move because data changed. Availability changes a segment's *state*, never its *place*.
2. **Honest signal.** Motion, progress and success states are emitted only by recorded events. No decorative spinners on stages that haven't started; no optimistic "done".
3. **Meaning is never colour alone.** Every state is tone + glyph/shape + text label, and names its dimension.
4. **Calm density.** Porcelain grounds and hairline structure let dense enterprise content stay legible. Emphasis is reserved for the centre work surface and for anything that needs a human.

---

## 2. Colour

### 2.1 Palette

| Family | Tokens | Role |
|---|---|---|
| Porcelain | `porcelain-0 … 500` | Surfaces, wells, hairlines. App background is `porcelain-100` (#F4F2EE); panels are white. |
| Graphite | `graphite-900 … 400`, `graphite-brand` | Ink, primary buttons, brand tile, trusted (P3) chrome. |
| Emerald | `emerald-700/600/400/100/50` | Positive / ready / verified. |
| Ochre | `ochre-700/500/100` | Attention / needs review / partial / stale / assertion. |
| Coral | `coral-700/500/100` | Blocking / failed / restricted / unresolved. |
| Slate-blue | `slate-700/500/100` | Information / running / hypothesis / non-equity control / agent-composed tags. |

**Reconciliation with the replaced control-ui (v2).** The control-ui palette is within ΔE≈3 of ours, so the new UI uses our tokens and control-ui's go away: `evergreen #1f6b4f` → `emerald-700 #2E6B4F` · `warn #8a6314` → `ochre-700 #8A5A0F` · `danger #a23f2f` → `coral-700 #A3412F` · `active #2e6f91` → `slate-700 #3D5A82` · `canvas #f6f8f3` → `porcelain-100` · `ink #222d27` → `graphite-900` · `line #e2e8dd` → `porcelain-300`. Platform console pages use the same tones and state dimensions as domain pages (the v2 EHF enums are in `tokens.json → stateMap`). Dark mode, which the 7 Nov concept drawings use, is a later token set.

### 2.2 Semantic tones

Components use only these tokens: `--tone-{positive|attention|blocking|info|neutral|draft}-{bg|fg|fill}`.

| Tone | Text on bg (measured) | Typical values |
|---|---|---|
| positive | 5.28 : 1 | COMPLETED, VERIFIED, PASS, Ready, Published |
| attention | 4.95 : 1 | PARTIAL, NEEDS_REVIEW, NEEDS_EVIDENCE, UNKNOWN, Stale, Degraded |
| blocking | 4.95 : 1 | BLOCKED, FAILED, FAIL, REJECT, Restricted, Conflict UNRESOLVED |
| info | 5.66 : 1 | RUNNING, OPEN/REVIEW, INDICATOR, Validated |
| neutral | 6.70 : 1 | Not assigned, Waiting, N/A, CONSUMED |
| draft | outline only | Draft, implemented_synthetic |

Ink: `ink-1` 13.9 : 1, `ink-2` 5.4 : 1, `ink-3` 4.5 : 1 on the app background. UI marks (segments, dots, edges) are ≥ 3 : 1 against white.

### 2.3 Rules

- **Green is earned.** Positive tone is used only for a state that was *recorded* as successful or verified. A configured toggle, an assigned capability or an available provider is not "green success". Use neutral or a binding marker instead (spec §3.4, §15).
- **Attention ≠ failure.** `UNKNOWN` is attention, never positive. Policy gates say "unknown ≠ pass", and the UI must not visually round it up.
- **Hatching means absence.** Diagonal hatching is reserved for *missing* things: missing context, unavailable dependencies, sampled-out spans, time gaps. Never use it for decoration.
- **One accent per surface.** A screen gets at most one strong graphite primary action and one trusted action. Everything else is secondary or quiet.

---

## 3. Typography

| Role | Font | Use |
|---|---|---|
| Interface | **Instrument Sans** 400/500/600/700 | All UI text. |
| Display | **Instrument Serif** 400 + italic | Studio landings, empty states, style guide. **Never** for data, values or labels. Italic emerald emphasis on one word at most. |
| Technical | **JetBrains Mono** 400/500 | Skill IDs, object types, hashes, refs, enums, spans, JSON. |

All fonts are SIL OFL-licensed and self-hosted in `assets/fonts/`. Don't load them from a CDN.

Scale (px, size/line-height): 11/14 engraved · 12/16 · 13/18 · **14/20 body** · 16/22 · 20/26 · 26/32 · 34/40 display · 48/52.

- **Engraved labels** (`.t-engraved`): 11 px, uppercase, 0.08 em tracking, `ink-2`. Use them for dimension names, breadcrumbs and section kickers. This is the "engraved panel" voice from the concepts.
- **Numbers** always use tabular figures (`.num`, `time`). Show percentages with the precision the source has (`33.0%`). Never show more precision than was computed, and never show uncalibrated scores as percentages.
- **Identifiers** are always mono and never truncated in the middle of a namespace segment. Truncate hashes as `9c41…e07b` (first 4–6, last 4) and expose the full value on hover or copy.
- **Enums** are shown as their schema value (`NEEDS_REVIEW`) in technical and assurance surfaces. Business surfaces may humanise them ("Needs review") but must map 1:1.

---

## 4. Space, shape, depth

- 4 px base grid: `space-1 … space-16` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Radii grow with container size: segment 4 · input 8 · card/bank 12 · region 18 · sheet 24 · pill 999.
- Elevation: `shadow-1` for regions and selected cards, `shadow-2` for hover and popovers, and `shadow-3` **only** for the trusted approval sheet and modal sheets.
- Selection is a 1 px graphite ring plus a lift to white (`aria-pressed`/`aria-selected`). It is never a colour fill.

### Layout: four stable regions (spec §3.2)

| Region | Width | Content |
|---|---|---|
| Chrome (P0) | 52 px high | Brand, studio switcher, search, **synthetic/environment banner**, policy pin, notifications, identity + role |
| Left · orientation | 248 px (220 ≤ 1280) | Navigation, hierarchy, queues, filters, saved views, versions |
| Centre · work surface | fluid | Banks, graphs, workbenches, timelines. Greatest emphasis. |
| Right · inspector | 360 px (320 ≤ 1280) | Evidence, contract, provenance, authority, next action |
| Bottom · activity rail | 40 px / 220 px | Events, stream, validation, traces |

Below 1080 px the left and right regions collapse to drawers. The centre never reflows its spatial grouping (banks stay in the same order).

**Density:** `data-density="compact"` tightens row height (40→32), controls (36→30), padding and body size. The hierarchy doesn't change.

---

## 5. Semantic patterns

### 5.1 State dimensions

Every state chip renders inside `.dim` with its engraved dimension name when there's any chance of ambiguity, e.g. `PUBLICATION Draft` next to `CONNECTION Degraded`. The full value→tone→glyph mapping, sourced from the real enums, is in `tokens.json → stateMap` and on the style-guide page.

### 5.2 Epistemic markers (spec §19.1)

Shape encodes *what kind of claim* something is, independently of its status tone:

| Kind | Glyph | Edge style in graphs |
|---|---|---|
| Observation / source | small dot | — |
| Assertion | dashed hollow diamond | dashed ochre |
| Verified fact | solid diamond | solid graphite |
| Hypothesis | hollow circle | — |
| Finding | hollow square | — |
| Recommendation | triangle | — |
| Authorized decision | ringed solid square | — |
| Unresolved path / gap | — | dotted coral, hatched node with `?` |
| Non-equity control | — | dash-dot slate |

An unverified UBO must **never** render with the fact glyph or a solid edge (acceptance §16.5).

### 5.3 Skill binding types (spec §7.4)

`Required` (solid graphite) · `Conditional` (outlined, half-filled square) · `Eligible` (hairline, hollow circle) · `Composed` (slate, linked rings) · `Not assigned` (dashed). These are not toggles. Never render them as on/off switches.

### 5.4 Readiness meters

One segment per governed capability, in fixed order. States: ready (emerald), conditional (striped emerald), optional (outlined emerald), missing (ochre hatch), degraded (solid ochre), restricted (coral outline), unavailable (coral hatch), not assigned (empty well). Always pair the meter with an `n/m ready` count and the worst condition in words. **No single readiness percentage.**

### 5.5 Trust classes (addendum §5.4)

| Class | Visual signature | Rule |
|---|---|---|
| P0 chrome | Top bar; dashed ochre **Synthetic** pill whenever `synthetic: true` | Application-owned. Never agent-composed. |
| P1 information | Standard cards; agent-composed surfaces carry a dashed slate **lineage tag** (`agent · template@v · surface rev`) | Agents may populate and arrange approved components. |
| P2 interactive | Forms, comparisons, impact previews in standard sheets | Server validation mandatory; show expected revision. |
| P3 trusted action | **Only** surface with the graphite band, lock glyph, 2 px graphite border and `shadow-3`; `btn--trusted` exists nowhere else | Shows exact action, before/after, hash bindings, expiry countdown, attestation, re-auth. |

### 5.6 Agent output

- Agent work products follow the 8-part AI Work Product Standard (spec §8.4) in a fixed 4×2 grid.
- The agent stream describes **observable activity**, not private reasoning. Each item states proposed / running / completed / failed / interrupted via its mark shape.
- An accepted finding is not a decision. Say so next to the accept action.

### 5.7 Disclosure & absence

Use `.disclosure` for anything missing, sampled, stale, restricted, redacted or limited (negative search coverage). Always include the machine code where one exists (`CONTEXT_MISSING`, `ACCESS_DENIED`). Absence is shown, never filled in.

---

## 6. Motion

| Token | ms | Use |
|---|---|---|
| `dur-instant` | 80 | press, toggle |
| `dur-fast` | 140 | hover, selection |
| `dur-base` | 220 | expand, inspector swap |
| `dur-slow` | 420 | causal highlight, signal replay step |

- Progress animation is driven by events, one step per recorded event (see the Context Signal replay).
- Live updates change values in place. Don't reorder a queue the user is working in; show a "N new items" pill instead.
- `prefers-reduced-motion` sets durations to 0 but still applies the state change.

---

## 7. Iconography

24-grid outline icons, 1.6 stroke, round joins, defined once in the shell sprite (`assets/shell.js`). Icons label things. They never carry state on their own. Bank icons are stable identities: Identity = fingerprint, Entity = sitemap, Ownership = branch, Documents = copy, Registry = building, Screening = shield-check, Party 360 = users, Transactions = swap, Network = graph, Evidence = file, Risk = gauge, Case = inbox, Policy = book.

---

## 8. Writing (UX copy)

- Business language first: "Resolve beneficial ownership", not "call ownership.ubo.resolve". Show the canonical ID beneath in mono.
- Name the next accountable step and the reason ("Review ownership discrepancy — 25% declared vs 15% registry · threshold 20%").
- Say what didn't happen: "Not recorded", "Not an approval", "Absence is not proof of absence".
- Buttons are verbs with objects: "Record review outcome", "Sign & commit decision", "Propose for approval".
- Never claim compliance, verification or accuracy that the data doesn't support. Synthetic results are labelled synthetic.

---

## 9. Accessibility (WCAG 2.2 AA)

- Contrast: text ≥ 4.5 : 1, UI marks ≥ 3 : 1 (measured values above). A `prefers-contrast: more` override strengthens lines and secondary ink.
- Keyboard: banks and keys support arrow-grid navigation, tabs use roving tabindex (←/→), sheets trap focus, Esc closes, and focus returns to the trigger. Every graph node is focusable with a full `aria-label`.
- Every graph has a **Table** alternative and an SVG `<title>`/`<desc>` summarising the structure.
- Live regions announce interrupts and new results. Focus doesn't move on background updates.
- Target size ≥ 24 × 24 px (2.5.8). The smallest controls (`segmented--sm`) are 24 px high.
