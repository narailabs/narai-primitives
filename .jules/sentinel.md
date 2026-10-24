## 2024-05-24 - ScrubSecrets on Unsanitized Raw Error Messages
**Vulnerability:** The error response payload and logged payload could return un-scrubbed raw error messages coming out of Zod or external SDKs, risking leakage of PII/credentials directly out of error stacks.
**Learning:** `src/toolkit/connector.ts` returned unscrubbed strings directly into ErrorEnvelopes which is printed out natively as stdout / json payload payload to clients.
**Prevention:** Scrub ALL error-related output strings via `scrubSecrets` before wrapping into an ErrorEnvelope payload or surfacing out of core framework boundaries.
