import type { MindEngine } from "../index.js";
import type { Actor } from "../types.js";

export interface DemoSeedSummary {
  orgId: string;
  ruleTailSentinelId: string;
  xssEntryId: string;
  redactedEntryId: string;
  unknownKindEntryId: string;
  chainHeadId: string;
  inboxEntryId: string;
}

/**
 * Seeds a realistic, adversarial-safe sandbox for `meru-mind serve --demo`:
 * - 12 binding rules ending with `RULE-TAIL-SENTINEL` (verifies zero silent rule truncation)
 * - Stored-XSS test entry (`<img src=x onerror="window.__xss=1">`)
 * - Redacted tombstone entry (`[REDACTED]`)
 * - Unknown custom `extKind` entry (verifies graceful neutral rendering)
 * - 2-step supersede chain (`proposal -> decision`)
 * - Pending `/inbox` entry ready for CAS triage
 */
export async function seedDemoOrg(
  engine: MindEngine,
  orgId: string,
): Promise<DemoSeedSummary> {
  const human: Actor = { id: "demo-lead", kind: "human" };
  const agent: Actor = { id: "demo-agent", kind: "agent", family: "claude" };

  const root = engine.db.getRealmByPath(orgId, "/")!;
  const ensureRealm = (slug: string, name: string, scope: string) => {
    const existing = engine.db.getRealmByPath(orgId, `/${slug}`);
    if (existing) return existing;
    return engine.ledger.createRealm({
      orgId,
      parentId: root.id,
      slug,
      name,
      scope,
      actor: human,
    });
  };

  const ops = ensureRealm("ops", "Operations", "Production releases, rollbacks, and reliability");
  const eng = ensureRealm("engineering", "Engineering", "Architecture decisions and API contracts");
  const inbox = engine.ledger.ensureInboxRealm(orgId);

  // 12 rules ending with RULE-TAIL-SENTINEL (tests untruncated L1 rules rendering)
  let tailRuleId = "";
  for (let i = 1; i <= 12; i += 1) {
    const isTail = i === 12;
    const rec = await engine.ledger.appendRecord({
      actor: human,
      viewerRealmId: root.id,
      targetRealmId: root.id,
      kind: "rule",
      title: isTail
        ? "RULE-TAIL-SENTINEL: Never silently truncate governance rules in L1 brief"
        : `Governance Rule #${i}: Document rollback steps before production promotion`,
      payload: {
        body: isTail
          ? "Sentinel rule #12 verifying that both built-in and custom UIs display every binding rule."
          : `Standard reliability guardrail #${i}.`,
      },
      idempotencyKey: `demo-rule-${i}`,
    });
    tailRuleId = rec.id;
  }

  // Stored-XSS test finding (must render harmlessly as literal text inside <meru-entry>)
  const xssEntry = await engine.ledger.appendRecord({
    actor: agent,
    viewerRealmId: root.id,
    targetRealmId: ops.id,
    kind: "finding",
    title: 'XSS probe: <img src=x onerror="window.__xss=1">',
    payload: {
      body: 'Untrusted input check: <script>window.__xss=2</script><img src=x onerror="window.__xss=3">',
    },
    idempotencyKey: "demo-xss-entry",
  });

  // 2-step supersede chain in /engineering
  const prop = await engine.ledger.appendRecord({
    actor: agent,
    viewerRealmId: root.id,
    targetRealmId: eng.id,
    kind: "proposal",
    title: "Draft transport: evaluate SSE for realtime updates",
    payload: { body: "Initial draft considering SSE." },
    idempotencyKey: "demo-chain-prop",
  });
  const dec = await engine.ledger.appendRecord({
    actor: human,
    viewerRealmId: root.id,
    targetRealmId: eng.id,
    kind: "decision",
    title: "Skip SSE; ship Pump Long-Poll in v0.3 and Pump WebSocket in v0.4",
    payload: { body: "Avoids HTTP/1.1 6-connection cap while keeping one SQLite WAL Pump model." },
    supersedesIds: [prop.id],
    idempotencyKey: "demo-chain-dec",
  });

  // Unknown extKind record (tests graceful neutral fallback rendering)
  const unknownEntry = await engine.ledger.appendRecord({
    actor: agent,
    viewerRealmId: root.id,
    targetRealmId: eng.id,
    kind: "finding",
    extKind: "future_telemetry_probe",
    title: "Edge latency baseline check",
    payload: { body: "Custom extKind verifies UI handles unknown record types cleanly." },
    idempotencyKey: "demo-unknown-kind",
  });

  // Redacted tombstone entry
  const toRedact = await engine.ledger.appendRecord({
    actor: agent,
    viewerRealmId: root.id,
    targetRealmId: ops.id,
    kind: "finding",
    title: "Temporary sensitive note for redaction demo",
    payload: { body: "To be redacted in demo seed." },
    idempotencyKey: "demo-redact-src",
  });
  if (!toRedact.redactedAt) {
    engine.ledger.redact({
      actor: human,
      entryId: toRedact.id,
      reason: "demo-redaction-tombstone",
      viewerRealmId: root.id,
    });
  }

  // Inbox item waiting for triage
  const inboxEntry = await engine.ledger.appendRecord({
    actor: agent,
    viewerRealmId: root.id,
    targetRealmId: inbox.id,
    kind: "finding",
    title: "Unrouted staging memory spike note",
    payload: { body: "Worker RSS rose 18% during batch import; triage to /ops or /engineering." },
    idempotencyKey: "demo-inbox-triage",
  });

  return {
    orgId,
    ruleTailSentinelId: tailRuleId,
    xssEntryId: xssEntry.id,
    redactedEntryId: toRedact.id,
    unknownKindEntryId: unknownEntry.id,
    chainHeadId: dec.id,
    inboxEntryId: inboxEntry.id,
  };
}
