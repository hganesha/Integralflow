# Skill content sources

Edit `skills/<canonical-id>.md` for business procedures and `domains/<domain>.md` for shared guidance. These are source files; the service-root `skills/` and installed `resources/skills/` directories are generated packages.

All 229 skills require exactly one source with Business outcome, Procedure, Evidence and uncertainty, Variations, Examples and acceptance, and Limitations sections. All 20 domains require shared guidance. Twelve pilot procedures have distinct business branches and cases; the remaining procedures establish a reviewable baseline and need deeper skill-specific SME/evaluation work.

The builder inlines domain guidance into each `SKILL.md`, so the existing instruction hash and agent budget cover all its guidance. Missing/duplicate sections, unpinned references and symlinks are rejected. Link only to `input.schema.json`, `output.schema.json`, `context.yaml` or `skill.yaml`. Runtime reads and host startup verify instruction bytes against the released catalog.

Limitations are projected into the catalog and installed `resources/skill-limitations.json`. Maintain explicit policy-field contracts in `src/financial_crime/resources/skill-policy-fields.json`, including indirect helper dependencies. Moving implementation code must not silently change admitted policy context.

From the service directory, run `PYTHONPATH=src python scripts/build_catalog.py`; then run the root business-skill, library-contract, bundle-lock and domain sync scripts, followed by `make compile`. CI runs the builder with `--check`. Released source/behavior changes require new versions, regenerated pins and ordinary independent approval/requalification.

Describe bounded implemented behavior. Keep desired future behavior in the design backlog. Do not advertise acquisition, independent verification, calibrated accuracy, human authority or external delivery the implementation does not provide.
