# Decision log

Only decisions supported by source, commit history, or project reports are recorded. Missing rationale is stated explicitly rather than inferred. Entries describe historical checkpoints; current `main` at `36a2b6f` has not been reviewed in this cycle.

| Evidence | Decision | Rationale / alternatives | Tradeoffs | State |
|---|---|---|---|---|
| `c1a1182` and code at `360a827` | Browser-based keepsake editor with a local project model | Earlier reasoning is not recorded. | IndexedDB avoids a project backend, but data is tied to a browser profile unless exported. | Provisional |
| `ff8b9b1`, `832ed58` | Server-authoritative Crazy Eights rules with Socket.IO room transport | Alternatives and rationale were not recorded. | In-memory rooms are lost on service restart; room/seat tokens are bearer credentials. | Provisional |
| Model notes in `HANDOFF.md` at `832ed58` | Use the supplied playing-card glTF model for the 3D table | Handoff notes describe model parts and attribution requirements; alternatives were not recorded. | Preserve licenses and attribution; personalized textures are a separate layer. | Provisional |
| `aa0f08f` and source at `360a827` | Implement story puzzle and letter in the browser | Security rationale for client-side delivery is not recorded. | Client-visible answers are not confidential and cannot be protected by a UI unlock alone. | Revisit before deployment |
| `src/printing/README.md` and print implementation at `360a827` | Use browser/Chromium PDF generation for prototype output | Alternatives and decision rationale are not recorded. | RGB output and print preflight limits make it unsuitable as approved production artwork. | Prototype only |
| `abc2fa5` | Synthesize sound/ambience with Web Audio and animate candlelight/card hover | Source confirms the implementation; creative and technical reasoning is not recorded. | Target-device audio, accessibility, and performance remain unverified. | Implemented at cited checkpoint |

## Open decisions

Record explicit decisions for approved media and consent, server authorization, deployment boundary, print-production requirements, and retention. Link the decision to evidence and a commit; do not attribute an undocumented rationale to an agent.
