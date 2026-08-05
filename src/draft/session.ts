// 005 T021 — the DraftSession Durable Object.
//
// SKELETON ONLY. The binding and the `migrations` entry are declared in
// wrangler.jsonc during Phase 1, and wrangler refuses to deploy a Worker whose
// declared Durable Object class is not exported from the entrypoint — so this
// file must exist from Phase 1 even though its behaviour lands in Phase 3.
// Shipping the binding without the class would leave `main` undeployable
// between phases.
//
// It deliberately does NOT pretend to work: every entry point reports that it
// is unimplemented rather than returning a plausible empty state, because a
// session that answers "no picks yet" when it has no idea is indistinguishable
// from a working one with an empty draft — the exact failure this feature
// exists to prevent (FR-017).
//
// Phase 3 (T021-T024) implements: nudge(), the keyset pull from tap_batches,
// reconcile(), the commit, and the 5 s safety alarm.

import type { Env } from "../env";

export class DraftSession implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(): Promise<Response> {
    return Response.json(
      { error: "not_implemented", message: "DraftSession is not implemented yet (005 Phase 3)." },
      { status: 501 },
    );
  }
}
