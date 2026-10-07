# Strategy

## Current position

Metacord has a substantial working product and a `v0.2.0` main line, but its development system is less trustworthy than its code suggests. Legacy planning records describe already-landed work as future scope, the long-lived `dev` branch contains unreconciled commits, current deployment health has not been re-proven during this bootstrap, and hosting and frontend choices are simultaneously implemented and open to review.

The immediate strategy is confidence before scope: make project truth reproducible, reconcile branch and documentation drift, and decide broad technical substitutions independently before resuming feature work.

## Positioning

Metacord competes primarily with Discord's own server list, personal notes or spreadsheets, ad hoc exports, and scripts that call Discord APIs directly. Its advantage is not another chat experience; it is the combination of secure delegated access, power-user overview, private local-first annotations, and an exportable personal record in a focused interface. The product earns a broader audience by proving this workflow against one demanding real user before optimizing acquisition or collaboration.

## Current priorities

1. Reconcile the unmerged `dev` commits into a reviewed Change, make `main` the sole integration line, and retire the long-lived promotion branch only after its work is preserved.
2. Establish a reproducible evidence baseline: frozen install, generated types, frontend and backend typechecks, build, tests, and explicit local, development, and production smoke results.
3. Bring Loaf state and project instructions current, preserving useful history while retiring legacy operational Markdown.
4. Resolve two independent architecture questions through decision-only research: the hosting/runtime model and the client framework model.
5. Resume product work only from shaped Changes after the confidence and decision gaps are visible.

## Constraints

- Preserve token confidentiality and local ownership of personal annotations.
- Keep the product web-first, single-account, and personal-first during the current strategy horizon.
- Treat upstream API behavior and rate limiting as external constraints requiring observed evidence, not assumptions.
- Treat the current deployment model as implemented but not permanent until a dedicated ADR resolves operational fit, cost, egress and rate-limit behavior, portability, and migration cost.
- Treat the current framework-free client as implemented but open to an ADR-backed maintainability review.
- Do not add dependencies, migrate frameworks or platforms, or expand product scope inside the confidence Change.

## Open questions

- What recovery guarantees should browser-owned personal data have beyond manual export and import?
- What proof is sufficient before inviting external Discord power users?
- Does the current hosting/runtime remain the best operational fit after observed rate-limit behavior and migration costs are compared?
- Does a client framework materially improve maintainability enough to justify its dependency and migration cost?

## Evidence policy

Repository state, automated checks, deployed configuration, runtime observations, and explicit smoke results are separate facts. Passing one does not imply the others. Numeric performance and reliability goals remain aspirations until instrumentation produces repeatable measurements.
