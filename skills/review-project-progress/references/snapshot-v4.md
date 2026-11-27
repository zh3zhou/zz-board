# ZZ Board Snapshot V4

Use for explicit semantic JSON export, not the evidence-collection direct-sync path. Read `snapshot-v3.md` for the shared projects, threads, briefs, todos, privacy and size rules. Set `schemaVersion` to `4`, `summaryLanguage` to `zh-CN`. V1–V3 imports remain compatible.

Threads may include `recap`; omit it when its provenance cannot truthfully be populated. The authoritative strict definitions are `threadSummarySchema`, `threadRecapSchema` and `evidenceSourceSchema` in `src/shared/schema.ts`.

`recap` contains `summary`, `sources`, SHA-256 `sourceFingerprint`, `evidenceCheckedAt`, `summarizedAt`, `promptVersion`, actual `model`, and actual `effort`. Never guess runtime/model identity or make up a fingerprint. Sources contain `id`, `role` (`user`/`assistant`/`file`), `occurredAt`, nullable `turnId`, nullable `path`; no raw text.

The summary contains `headline`, `stopPoint`, `stopPointRefs`, `workState`, `confidence`, `achievements`, `artifacts`, `versions`, nullable `nextStep`, `nextStepReason`, and `resolvedTodos`:

- achievements: up to 30 `{id,title,detail,occurredAt,sourceRefs,artifactIds}`; artifacts: up to 30 `{id,label,uri,sourceRefs}`. Include actual delivered results, not requests or aspirations.
- versions: up to 12 `{version,stage,sourceRefs}` with stage `source`, `built` or `running`; never promote a built package to running acceptance.
- nextStep: `{text,kind,strength,origin,sourceRefs}` only when explicit. Strength is `blocking`/`recommended`; origin is `user_request`/`accepted_plan`/`explicit_handoff`. Otherwise use null with reason `not_stated`, `intentionally_closed` or `insufficient_evidence`; non-null requires reason `explicit`. Null cannot pair with `waiting_for_user`.
- resolvedTodos: up to 30 `{todoKey,sourceRefs}`, only actual existing obligations explicitly resolved by evidence. Do not invent identifiers or retire unrelated work.

Every sourceRefs list has 1–12 known same-task source IDs. Achievement artifactIds must exist. Keep IDs unique, facts concise and Chinese. Unknown next steps and partial coverage are valid outcomes; do not create speculative todos to fill a card.

Todos may include optional `actionEvidence: {origin, sourceRefs}`. Origin is `user_request`, `accepted_plan` or `explicit_handoff`; sourceRefs contains 1–12 actual evidence source IDs establishing the action. Omit this object when the original evidence cannot truthfully support it. Do not retrofit provenance onto legacy V1–V3 todos by guessing.
