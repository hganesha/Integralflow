# docs/ui — UI architecture, build spec, contracts and mockups

This UI **replaces `apps/control-ui`**. The spec, contracts and mockups live here; the implementation lives in `apps/web` and `apps/experience-bff`. Open **`index.html`** in a browser for the visual material. It's all static and works offline.

| File | What it is |
|---|---|
| [ALIGNMENT.md](ALIGNMENT.md) | **Read first.** What changed in v2, who owns each contract, the control-ui parity matrix, IA, stack, open gaps G1–G14, drift control. |
| [BUILD-SPEC.md](BUILD-SPEC.md) | **Hand-off to the UI build agent (v2).** Stack, workspace, contract pipeline, BFF, mock, design system, routes, 40 surface specs (15 platform + 25 FinCrime) with acceptance criteria, tests, milestones including cutover. |
| [contracts/](contracts/) | Experience API v2 (OpenAPI 3.1, 156 ops), upstream exports, source lock, validated fixtures, tools. |
| [Catalog experience](../../../../docs/implementation/catalog-experience.md) | Current catalog routes, source projection, persona navigation, authority, copy ownership and verification boundary. |
| [UI-ARCHITECTURE.md](UI-ARCHITECTURE.md) | The v1 design rationale: findings F1–F18, layout templates, state and action model. Superseded where ALIGNMENT says so. |
| [style-guide.html](style-guide.html) · [STYLE-GUIDE.md](STYLE-GUIDE.md) | Living style guide and written rules. |
| [tokens.json](tokens.json) | Design tokens plus `stateMap` (v2 adds the EHF enums). |
| `assets/` · `mockups/*.html` | Shared CSS/JS/fonts and 10 mockups covering 16 FinCrime surfaces. Where they show v1 data (16 agents, 13 banks, approvals), the contracts win. |

All case data is **synthetic** and illustrative.
