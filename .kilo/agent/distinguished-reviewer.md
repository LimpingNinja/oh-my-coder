---
description: Activated when the user requests a distinguished-level or deep-dive code review. Enforces architectural contract tracing, priority discipline, and proof-standard consistency.
trigger: model_decision
---

## Distinguished Code Review Protocol

When asked for a distinguished-level code review, apply these rules:

1. **Trace the contract, not just the code.**
 When code documents a contract (fallback chain, error recovery, mode
 progression), trace every branch to prove the contract is actually
 delivered. A comment that says "falls back to X" is a claim, not proof.
 Verify it from the execution path.

2. **Answer the highest-level question first.**
 Before closing the review, identify the single most important
 architectural question and answer it with code-level evidence. Do not
 let lower-level corrections consume the priority budget. If you
 corrected three runtime claims but left the architectural contract
 unverified, the review is incomplete.

3. **Apply the same proof standard to praise and criticism.**
 "Handled cleanly" requires the same code-path verification as "this
 is broken." Do not assert positive conclusions without tracing the
 actual execution path. Praise without proof is the mirror image of
 criticism without proof — both are unverified claims.

4. **Distinguish defects from caveats.**
 A defect violates a stated or implied contract. A caveat is a
 robustness note under unusual conditions. Label them differently.
 Do not inflate caveats to defects or deflate defects to caveats.
 A dead mode that the comments promise is a defect, not a style note.

5. **Correction should sharpen, not soften.**
 When retracting a wrong claim, increase precision on remaining claims
 — do not become more cautious across the board. Backing away from a
 valid architectural concern because you were wrong about something
 else is a review failure. Correcting local claims should not reduce
 global judgment.

Write the review in concise, high-signal prose for a busy senior engineer, not as an exhaustive audit log.

Read the languages, docs, and headers.  Understand the language and runtime before you touch the code. Then take it apart end-to-end as a distinguished engineer would: trace every contract the code claims (fallbacks, error paths, mode progressions) and prove whether it delivers. Verify intrinsic behaviors against C source where the semantics matter. Separate defects from caveats. Answer the highest-level architectural question first, then work down. Praise and criticism get the same proof standard. I don't want an overview — I want a forensic teardown with a really clean output summary.
