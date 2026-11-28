import {
  computeDuplicateObjectKeys,
  formatCanonicalObjectRef,
} from "../engine/refs.js";
import { formatInactiveBadgesMarkdown } from "./inactive-badges.js";
import type { DoctorReport } from "../engine/doctor.js";
import type {
  BehaviorClass,
  BriefOutput,
  CatResult,
  ChangesResult,
  ExportMdResult,
  ImportBatchResult,
  ImportConsistencyResult,
  ImportDryRunResult,
  ImportJsonlResult,
  ImportMdResult,
  LedgerRecord,
  LsEntry,
  LsResult,
  MindObject,
  ObjectTreeNode,
  RealmTreeCounts,
  RealmTreeNode,
  RecallResult,
  ReplayResult,
  ResourceTagSummary,
  SearchResult,
  ShowContextResult,
  ShowResult,
  ShowWindow,
  TreeResult,
  WhoamiResult,
} from "../types.js";

export function formatBehaviorBadge(
  behaviorClass: BehaviorClass,
  kind?: string,
  extKind?: string | null,
): string {
  if (behaviorClass === "rule") return "[rule]";
  const detail = extKind || kind;
  return detail ? `[${behaviorClass}/${detail}]` : `[${behaviorClass}]`;
}

function formatDateLabel(occurredAt: string | null): string {
  return occurredAt ?? "undated";
}

function formatCountsTag(counts: RealmTreeCounts, collapsedChildren: number): string {
  const rawStr = counts.directRaw === null ? "—" : String(counts.directRaw);
  const parts: string[] = [
    `rules=${counts.directRules}`,
    `conclusions=${counts.directConclusions}`,
    `raw=${rawStr}`,
    `objects=${counts.directObjects}`,
  ];
  if (counts.subtreeConclusions !== null) {
    const subRaw = counts.subtreeRaw === null ? "—" : String(counts.subtreeRaw);
    const subObj =
      counts.subtreeObjects === null ? "" : `, objects=${counts.subtreeObjects}`;
    parts.push(
      `subtree(conclusions=${counts.subtreeConclusions}, raw=${subRaw}${subObj})`,
    );
  }
  if (counts.linkedViaObjects !== null && counts.linkedViaObjects > 0) {
    parts.push(`linked=${counts.linkedViaObjects}`);
  }
  if (collapsedChildren > 0) {
    parts.push(`+${collapsedChildren} child realm(s)`);
  }
  return `[${parts.join(", ")}]`;
}

const MAX_INLINE_OBJECTS_PER_REALM = 5;

function countObjectTreeNodes(nodes: ObjectTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countObjectTreeNodes(node.children);
  }
  return total;
}

function renderObjectTreeLines(
  nodes: ObjectTreeNode[],
  realmPathById: Map<string, string>,
  duplicateKeys: Set<string>,
  indent = "",
  remainingBudget?: { left: number },
): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    if (remainingBudget && remainingBudget.left <= 0) break;
    const o = node.object;
    const rPath = realmPathById.get(o.realmId) ?? "/";
    const canonicalRef = formatCanonicalObjectRef(o, rPath, duplicateKeys);
    const stateSuffix =
      o.state && o.state !== "active"
        ? ` [${o.stateLabel || "inactive"}]`
        : "";
    lines.push(`${indent}- \`${canonicalRef}\` (\`${o.id}\`)${stateSuffix}`);
    if (remainingBudget) remainingBudget.left -= 1;
    if (node.children.length > 0 && (!remainingBudget || remainingBudget.left > 0)) {
      lines.push(
        ...renderObjectTreeLines(
          node.children,
          realmPathById,
          duplicateKeys,
          `${indent}  `,
          remainingBudget,
        ),
      );
    }
  }
  return lines;
}

function renderRealmTreeLines(
  nodes: RealmTreeNode[],
  realmPathById: Map<string, string>,
  duplicateKeys: Set<string>,
  indent = "",
): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const r = node.realm;
    const collapsed = Math.max(
      0,
      node.counts.childRealmsCount - node.children.length,
    );
    const countsStr = formatCountsTag(node.counts, collapsed);
    const archivedTag = node.effectivelyArchived ? " [archived]" : "";
    const scopeSuffix = r.scope ? ` | ${r.scope}` : "";
    lines.push(
      `${indent}- **${r.path}** — ${r.name}${archivedTag} (\`${r.id}\`) ${countsStr}${scopeSuffix}`,
    );
    if (node.objects.length > 0) {
      const totalObjects = countObjectTreeNodes(node.objects);
      if (totalObjects > MAX_INLINE_OBJECTS_PER_REALM + 1) {
        const budget = { left: MAX_INLINE_OBJECTS_PER_REALM };
        lines.push(
          ...renderObjectTreeLines(
            node.objects,
            realmPathById,
            duplicateKeys,
            `${indent}  `,
            budget,
          ),
        );
        const omittedObjects = totalObjects - MAX_INLINE_OBJECTS_PER_REALM;
        lines.push(
          `${indent}  - ... (+${omittedObjects} more objects; run \`meru-mind ls ${r.path} --only objects\`)`,
        );
      } else {
        lines.push(
          ...renderObjectTreeLines(
            node.objects,
            realmPathById,
            duplicateKeys,
            `${indent}  `,
          ),
        );
      }
    }
    if (node.children.length > 0) {
      lines.push(
        ...renderRealmTreeLines(
          node.children,
          realmPathById,
          duplicateKeys,
          `${indent}  `,
        ),
      );
    }
  }
  return lines;
}

export function formatTreeMarkdown(res: TreeResult): string {
  const realmPathById = new Map(res.realms.map((r) => [r.id, r.path]));
  const duplicateKeys = computeDuplicateObjectKeys(res.objects);
  const lines: string[] = [
    `# Tree: ${res.org.name} (\`${res.org.id}\`, policy: \`${res.org.policy}\`, depth: \`${String(res.depth)}\`)`,
    "",
    `## Realms (${res.realms.length})`,
  ];
  if (res.realmTree.length === 0) {
    lines.push("- _(none)_");
  } else {
    lines.push(...renderRealmTreeLines(res.realmTree, realmPathById, duplicateKeys));
  }
  if (res.hiddenArchivedCount && res.hiddenArchivedCount > 0) {
    lines.push(
      "",
      `_(${res.hiddenArchivedCount} archived realm(s) hidden; pass --all to show)_`,
    );
  }

  const cap = Math.max(1, res.lineLimit || 60);
  if (lines.length > cap) {
    const omitted = lines.length - cap;
    return [
      ...lines.slice(0, cap),
      `... and ${omitted} more (drill down: meru-mind tree <path> -L 2, or increase --limit ${cap + 60})`,
    ].join("\n");
  }
  return lines.join("\n");
}

function formatLsEntryLine(item: LsEntry): string {
  const badge = formatBehaviorBadge(item.behaviorClass, item.kind, item.extKind);
  const tags =
    item.resourceTags.length > 0 ? ` {${item.resourceTags.join(", ")}}` : "";
  const ext = item.externalRef ? ` <${item.externalRef}>` : "";
  const statusTag =
    item.status !== "active" && item.status !== "evidence"
      ? ` (${item.status})`
      : "";
  const inactiveSuffix = formatInactiveBadgesMarkdown(item.inactive);
  return `- ${badge} \`${item.id}\` ${item.title}${ext}${statusTag} — ${item.realmPath} @ ${formatDateLabel(item.occurredAt)}${tags}${inactiveSuffix}`;
}

export function formatLsMarkdown(res: LsResult): string {
  const archivedTag = res.realmArchived ? " [archived]" : "";
  const lines: string[] = [
    `# ls ${res.targetType}: \`${res.target}\`${archivedTag} (resolved: \`${res.resolvedId}\`)`,
  ];
  if (!res.only || res.only === "entries") {
    lines.push(
      `Showing ${res.items.length} of ${res.totalMatched} (omitted: ${res.omittedCount})`,
    );
  }
  if (res.subRealms && res.subRealms.length > 0) {
    lines.push(
      `Sub-realms (${res.subRealms.length}): ${res.subRealms.map((s) => `\`${s.path}\``).join(", ")}`,
    );
  }
  if (res.objects && res.objects.length > 0) {
    lines.push(
      `Objects (${res.objects.length}): ${res.objects
        .map((o) =>
          o.state && o.state !== "active"
            ? `\`${o.ref}\` [${o.stateLabel || "inactive"}]`
            : `\`${o.ref}\``,
        )
        .join(", ")}`,
    );
  }
  if (!res.only || res.only === "entries") {
    lines.push("");
    if (res.items.length === 0) {
      lines.push("_(empty)_");
    } else {
      for (const item of res.items) {
        lines.push(formatLsEntryLine(item));
      }
      if (res.omittedCount > 0 && res.nextCursor) {
        const pageSize = Math.max(1, res.items.length);
        lines.push(
          `... and ${res.omittedCount} more (next page: meru-mind ls ${res.target} --cursor ${res.nextCursor} --limit ${pageSize}; inspect: meru-mind show <ref>)`,
        );
      }
    }
  }
  if (res.driveFiles && res.driveFiles.length > 0) {
    lines.push("", `## Files (${res.driveFiles.length})`);
    for (const df of res.driveFiles) {
      lines.push(`- \`${df.ref}\` (v${df.version}, updated ${df.updatedAt})`);
    }
  }
  return lines.join("\n");
}

export function formatCatMarkdown(res: CatResult): string {
  if (res.kind === "record") {
    const r = res.record;
    const badge = formatBehaviorBadge(res.behaviorClass, r.kind, r.extKind);
    const lines: string[] = [
      `# ${badge} ${r.title}`,
      "",
      `- **ID**: \`${r.id}\``,
      `- **Realm**: \`${res.realmPath}\` (\`${r.realmId}\`)`,
      `- **Status**: \`${r.status}\`${res.orphanSuperseded ? " _(orphan superseded)_" : ""}`,
      `- **Author**: \`${r.authorId}\` (${r.authorKind}, confirmedByHuman: ${r.confirmedByHuman})`,
      `- **Occurred**: ${formatDateLabel(r.occurredAt)}`,
      `- **Sensitivity**: \`${r.sensitivity}\``,
    ];
    if (r.externalRef) lines.push(`- **External Ref**: \`${r.externalRef}\``);
    if (r.sourceRef) lines.push(`- **Source Ref**: \`${r.sourceRef}\``);
    if (r.supersedesIds && r.supersedesIds.length > 1) {
      lines.push(
        `- **Supersedes**: ${r.supersedesIds.map((id) => `\`${id}\``).join(", ")}`,
      );
    } else if (r.supersedesId) {
      lines.push(`- **Supersedes**: \`${r.supersedesId}\``);
    }
    if (r.supersededById)
      lines.push(`- **Superseded By**: \`${r.supersededById}\``);
    if (res.currentHeadId)
      lines.push(`- **Current Head**: \`${res.currentHeadId}\``);
    if (res.objectIds.length > 0)
      lines.push(
        `- **Objects**: ${res.objectIds.map((o) => `\`${o}\``).join(", ")}`,
      );
    if (res.resourceTags.length > 0)
      lines.push(
        `- **Tags**: ${res.resourceTags.map((t) => `\`${t}\``).join(", ")}`,
      );
    if (r.refs.length > 0)
      lines.push(`- **Refs**: ${r.refs.map((ref) => `\`${ref}\``).join(", ")}`);

    const body =
      typeof r.payload.body === "string" && r.payload.body.trim()
        ? r.payload.body.trim()
        : null;
    if (body) {
      lines.push("", "## Body", "", body);
    }
    const extraPayload: Record<string, unknown> = { ...r.payload };
    delete extraPayload.body;
    if (Object.keys(extraPayload).length > 0) {
      lines.push(
        "",
        "## Payload",
        "",
        "```json",
        JSON.stringify(extraPayload, null, 2),
        "```",
      );
    }
    return lines.join("\n");
  }

  if (res.kind === "seabed") {
    const s = res.seabed;
    const badge = formatBehaviorBadge("raw", s.kind);
    const lines: string[] = [
      `# ${badge} ${s.kind}${s.topicId ? ` (${s.topicId})` : ""}`,
      "",
      `- **ID**: \`${s.id}\``,
      `- **Realm**: \`${res.realmPath}\` (\`${s.realmId}\`)`,
      `- **Author**: \`${s.authorId}\` (${s.authorKind})`,
      `- **Occurred**: ${formatDateLabel(s.occurredAt)}`,
      `- **Sensitivity**: \`${s.sensitivity}\``,
    ];
    if (s.sourceRef) lines.push(`- **Source Ref**: \`${s.sourceRef}\``);
    if (res.objectIds.length > 0)
      lines.push(
        `- **Objects**: ${res.objectIds.map((o) => `\`${o}\``).join(", ")}`,
      );
    if (res.resourceTags.length > 0)
      lines.push(
        `- **Tags**: ${res.resourceTags.map((t) => `\`${t}\``).join(", ")}`,
      );
    lines.push("", "## Content", "", s.text);
    return lines.join("\n");
  }

  if (res.kind === "distillation") {
    const d = res.distillation;
    return [
      `# [conclusion/${d.layer}] ${d.periodKey}`,
      "",
      `- **ID**: \`${d.id}\``,
      `- **Realm**: \`${res.realmPath}\` (\`${d.realmId}\`)`,
      `- **Status**: \`${d.status}\``,
      `- **Created**: ${d.createdAt}`,
      `- **Sources**: ${d.sourceIds.length}`,
      "",
      d.narrativeMd,
    ].join("\n");
  }

  const f = res.file;
  return [
    `# [raw/drive] ${f.relPath} (v${f.version})`,
    "",
    `- **Realm**: \`${res.realmPath}\` (\`${f.realmId}\`)`,
    `- **Updated**: ${f.updatedAt} by \`${f.updatedBy}\``,
    `- **SHA-256**: \`${f.sha256}\``,
    "",
    f.content,
  ].join("\n");
}

export function formatBriefMarkdown(brief: BriefOutput): string {
  const archivedTag = brief.realmArchived ? " [archived]" : "";
  const lines: string[] = [
    `# Brief: ${brief.realm.name}${archivedTag} (\`${brief.realm.path}\`, \`${brief.realm.id}\`)`,
    ...(brief.realm.scope ? [`Scope: ${brief.realm.scope}`] : []),
  ];

  // L1 Section 1: Rules (self + ancestors, NEVER silently truncated; grouped into realm wall vs object-scoped)
  lines.push(
    "",
    `## Rules (${brief.middleMind.rules.items.length}/${brief.middleMind.rules.totalCount}, omitted: ${brief.middleMind.rules.omittedCount})`,
  );
  if (brief.middleMind.rules.items.length === 0) {
    lines.push("- _(none)_");
  } else if (
    brief.middleMind.realmRules !== undefined ||
    brief.middleMind.scopedObjectRules !== undefined
  ) {
    const wall = brief.middleMind.realmRules ?? [];
    const scoped = brief.middleMind.scopedObjectRules ?? [];
    for (const r of wall) {
      lines.push(
        `- [rule] \`${r.id}\` ${r.title}${r.inherited ? " _(inherited)_" : ""}`,
      );
    }
    if (scoped.length > 0) {
      lines.push("", `### Object-Scoped Rules (${scoped.length})`);
      for (const r of scoped) {
        const refsLabel = r.objectRefs.map((ref) => `\`${ref}\``).join(", ");
        lines.push(
          `- [rule] \`${r.id}\` ${r.title} [${refsLabel}]${r.inherited ? " _(inherited)_" : ""}`,
        );
      }
    }
  } else {
    for (const r of brief.middleMind.rules.items) {
      lines.push(
        `- [rule] \`${r.id}\` ${r.title}${r.inherited ? " _(inherited)_" : ""}`,
      );
    }
  }
  if (brief.middleMind.rules.omittedCount > 0 || brief.middleMind.rules.totalCount > 50) {
    lines.push(
      `> Governance notice: ${brief.middleMind.rules.totalCount} active rules (${brief.middleMind.rules.omittedCount} omitted); review rule sprawl via \`meru-mind ls ${brief.realm.path} --kind rule\`.`,
    );
  }

  // L1 Section 2: Active Decisions (self listed in full; ancestor decisions folded with count + drill-down)
  lines.push(
    "",
    `## Active Decisions (${brief.upperLedger.activeDecisions.items.length}/${brief.upperLedger.activeDecisions.totalCount}, omitted: ${brief.upperLedger.activeDecisions.omittedCount})`,
  );
  if (brief.upperLedger.activeDecisions.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const d of brief.upperLedger.activeDecisions.items) {
      lines.push(
        `- [conclusion/decision] \`${d.id}\` ${d.title} @ ${formatDateLabel(d.occurredAt)}`,
      );
    }
    if (brief.upperLedger.activeDecisions.omittedCount > 0) {
      lines.push(
        `... (+${brief.upperLedger.activeDecisions.omittedCount} more; inspect: \`meru-mind ls ${brief.realm.path} --kind decision\`)`,
      );
    }
  }
  if ((brief.upperLedger.inheritedDecisionsCount ?? 0) > 0) {
    lines.push(
      `_(+${brief.upperLedger.inheritedDecisionsCount} inherited ancestor decision(s) folded; inspect: \`meru-mind ls / --kind decision\`)_`,
    );
  }

  // L1 Section 3: Pending Human Proposals / Questions
  lines.push(
    "",
    `## Pending Proposals (${brief.upperLedger.pendingQuestions.items.length}/${brief.upperLedger.pendingQuestions.totalCount}, omitted: ${brief.upperLedger.pendingQuestions.omittedCount})`,
  );
  if (brief.upperLedger.pendingQuestions.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const q of brief.upperLedger.pendingQuestions.items) {
      lines.push(`- [conclusion/proposal] \`${q.id}\` ${q.title}`);
    }
  }

  // L1 Section 4: Recent Findings (clean signal; bulk claims & raw messages folded with explicit drill-down counts)
  const findingsSec = brief.upperLedger.recentFindings;
  if (findingsSec) {
    lines.push(
      "",
      `## Recent Findings (${findingsSec.items.length}/${findingsSec.totalCount}, omitted: ${findingsSec.omittedCount})`,
    );
    if (findingsSec.items.length === 0) {
      lines.push("- _(none)_");
    } else {
      for (const f of findingsSec.items) {
        lines.push(
          `- [conclusion/finding] \`${f.id}\` ${f.title} @ ${formatDateLabel(f.occurredAt)}`,
        );
      }
      if (findingsSec.omittedCount > 0) {
        lines.push(
          `... (+${findingsSec.omittedCount} more; inspect: \`meru-mind ls ${brief.realm.path} --kind finding\`)`,
        );
      }
    }
  }

  // Explicit folded counts & drill-down commands for claims, things, and raw messages
  const claimCount = brief.kindHistogram?.claim ?? 0;
  const thingCount = brief.upperLedger.activeThings.totalCount;
  const rawMsgCount = brief.surface.recentMessages.totalCount;
  const foldedHints: string[] = [];
  if (claimCount > 0) {
    foldedHints.push(
      `${claimCount} claim(s) (\`meru-mind ls ${brief.realm.path} --kind claim\`)`,
    );
  }
  if (thingCount > 0) {
    foldedHints.push(
      `${thingCount} thing(s) (\`meru-mind ls ${brief.realm.path} --kind thing\`)`,
    );
  }
  if (rawMsgCount > 0) {
    foldedHints.push(
      `${rawMsgCount} raw message(s) (\`meru-mind ls ${brief.realm.path} --kind message\`)`,
    );
  }
  if (foldedHints.length > 0) {
    lines.push("", `Folded L2 inventory: ${foldedHints.join(" · ")}`);
  }

  if (brief.middleMind.realmCard) {
    const meta = brief.middleMind.realmCardMeta;
    const seqSuffix = meta
      ? ` (seq: ${meta.cardSeq ?? "unknown"}, changes since card: ${meta.changesSinceCard})`
      : "";
    lines.push(
      "",
      `## Narrative Card${seqSuffix}`,
      brief.middleMind.realmCard.narrativeMd,
    );
  }

  if (brief.middleMind.childSummaries.totalCount > 0) {
    lines.push(
      "",
      `## Child Realms (${brief.middleMind.childSummaries.items.length}/${brief.middleMind.childSummaries.totalCount}, omitted: ${brief.omittedChildRealmsCount})`,
    );
    for (const c of brief.middleMind.childSummaries.items) {
      const pendingSuffix =
        c.pendingQuestions > 0 ? `, pendingQ=${c.pendingQuestions}` : "";
      lines.push(
        `- **${c.realmPath}** (${c.realmName}): conclusions=${c.activeConclusions}, rules=${c.activeRules}, objects=${c.activeObjects}${pendingSuffix}`,
      );
    }
    if (brief.omittedChildRealmsCount > 0) {
      lines.push(
        `... and ${brief.omittedChildRealmsCount} more (explore: meru-mind tree ${brief.realm.path} -L 1)`,
      );
    }
  }

  // Spec 3.3: Move metadata (Generated / Buckets / Kinds) to footer
  const footerMeta: string[] = [`Generated: ${brief.generatedAt}`];
  if (brief.buckets) {
    footerMeta.push(
      `Buckets: **rules**=${brief.buckets.rules}, **conclusions**=${brief.buckets.conclusions}, **raw**=${brief.buckets.raw}`,
    );
  }
  const histEntries = Object.entries(brief.kindHistogram ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (histEntries.length > 0) {
    footerMeta.push(
      `Kinds: ${histEntries.map(([k, c]) => `${k}=${c}`).join(", ")}`,
    );
  }
  lines.push("", "---", ...footerMeta);

  return lines.join("\n");
}

export function formatReplayMarkdown(
  res: ReplayResult | ShowContextResult,
): string {
  const lines: string[] = [
    `# Replay: \`${res.anchorId}\` (${formatDateLabel(res.anchorOccurredAt)}, basis: \`${res.timeBasis}\`, window: ±${res.window})`,
    "",
    `## Before (${res.before.length})`,
  ];
  if (res.before.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const item of res.before) {
      lines.push(formatLsEntryLine(item));
    }
  }

  lines.push("", "## Anchor", formatLsEntryLine(res.anchor));

  lines.push("", `## After (${res.after.length})`);
  if (res.after.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const item of res.after) {
      lines.push(formatLsEntryLine(item));
    }
  }

  if (res.supersedeChain.length > 1) {
    lines.push("", `## Supersede Chain (${res.supersedeChain.length})`);
    for (const node of res.supersedeChain) {
      lines.push(
        `- \`${node.id}\` (${node.status}) ${node.title} @ ${formatDateLabel(node.occurredAt)}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatChangesMarkdown(res: ChangesResult): string {
  const lines: string[] = [
    `# Changes (generation: ${res.generation}, sinceSeq: ${res.sinceSeq}, latestSeq: ${res.latestSeq})`,
    "",
  ];
  if (res.entries.length === 0) {
    lines.push("_(no changes)_");
  } else {
    for (const e of res.entries) {
      lines.push(
        `- #${e.seq} \`${e.op}\` ${e.entityType}:\`${e.entityId}\` (realm \`${e.realmId}\`, actor \`${e.actorId}\`, ${e.createdAt})`,
      );
    }
  }
  return lines.join("\n");
}

export function formatRecallMarkdown(res: RecallResult): string {
  const dateSuffix =
    res.interpretedDates && res.interpretedDates.length > 0
      ? ` [dates=${res.interpretedDates.map((d) => `\`${d}\``).join(", ")}]`
      : "";
  const lines: string[] = [
    `# Recall${dateSuffix} (${res.items.length}/${res.totalMatched}, omitted: ${res.omittedCount})`,
    res.message,
    "",
  ];
  if (res.items.length === 0) {
    lines.push("_(no matches)_");
  } else {
    for (const item of res.items) {
      const cls: BehaviorClass =
        item.behaviorClass ??
        (item.sourceType === "seabed"
          ? "raw"
          : item.kind === "rule"
            ? "rule"
            : "conclusion");
      const badge = formatBehaviorBadge(cls, item.kind, item.extKind);
      const headHint = item.orphanSuperseded
        ? " (orphan superseded)"
        : item.currentHeadId !== undefined
          ? ` -> head:\`${item.currentHeadId ?? "none"}\``
          : "";
      const archivedSuffix = item.realmArchived ? " [archived]" : "";
      const inactiveSuffix = formatInactiveBadgesMarkdown(item.inactive);
      lines.push(
        `- ${badge} \`${item.id}\` **${item.title}**${archivedSuffix} (${item.status}${headHint}, @ ${formatDateLabel(item.occurredAt)}) — ${item.snippet}${inactiveSuffix}`,
      );
    }
    if (res.omittedCount > 0) {
      lines.push(
        `... and ${res.omittedCount} more (next page: --offset ${res.items.length}; inspect: meru-mind cat <id>)`,
      );
    }
  }
  return lines.join("\n");
}

export function formatThingsMarkdown(
  items: LedgerRecord[],
  total: number,
): string {
  const omitted = Math.max(0, total - items.length);
  const lines: string[] = [
    `# Things (${items.length}/${total}, omitted: ${omitted})`,
    "",
  ];
  if (items.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const t of items) {
      const ext = t.externalRef ? ` <${t.externalRef}>` : "";
      lines.push(
        `- [conclusion/thing] \`${t.id}\` **${t.title}**${ext} (realm \`${t.realmId}\`, ${t.status})`,
      );
    }
    if (omitted > 0) {
      lines.push(
        `... and ${omitted} more (next page: meru-mind thing list --offset ${items.length})`,
      );
    }
  }
  return lines.join("\n");
}

export function formatObjectsMarkdown(
  objects: MindObject[],
  total = objects.length,
): string {
  const omitted = Math.max(0, total - objects.length);
  const lines: string[] = [
    `# Objects (${objects.length}/${total}${omitted > 0 ? `, omitted: ${omitted}` : ""})`,
    "",
  ];
  if (objects.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const o of objects) {
      const parent = o.parentObjectId ? ` parent:\`${o.parentObjectId}\`` : "";
      lines.push(
        `- \`${o.kind}\` **${o.name}** (\`${o.id}\`, realm \`${o.realmId}\`${parent})`,
      );
    }
    if (omitted > 0) {
      lines.push(
        `... and ${omitted} more (list more: meru-mind object list --limit ${objects.length + 50}; inspect: meru-mind ls obj:<id>)`,
      );
    }
  }
  return lines.join("\n");
}

export function formatTagsMarkdown(
  tags: ResourceTagSummary[],
  total = tags.length,
): string {
  const omitted = Math.max(0, total - tags.length);
  const lines: string[] = [
    `# Resource Tags (${tags.length}/${total}${omitted > 0 ? `, omitted: ${omitted}` : ""})`,
    "",
  ];
  if (tags.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const t of tags) {
      lines.push(`- \`${t.tag}\` (${t.count})`);
    }
    if (omitted > 0) {
      lines.push(
        `... and ${omitted} more (list more: meru-mind tag list --limit ${tags.length + 50}; inspect: meru-mind ls tag:<type:name>)`,
      );
    }
  }
  return lines.join("\n");
}

export function formatImportMdMarkdown(res: ImportMdResult): string {
  const lines: string[] = [
    `# import-md Summary`,
    `- Files: ${res.totalFiles}`,
    `- Created: ${res.created}`,
    `- Superseded: ${res.superseded}`,
    `- Skipped (unchanged): ${res.skippedUnchanged}`,
    `- Skipped (redacted): ${res.skippedRedacted}`,
    `- Skipped (secret): ${res.skippedSecret}`,
    `- Undated: ${res.undatedCount}`,
    `- Default realm fallback: ${res.defaultRealmCount}`,
  ];
  if (res.items.length > 0) {
    lines.push("");
    for (const it of res.items.slice(0, 50)) {
      lines.push(
        `- \`${it.action}\` \`${it.sourceRef}\`${it.recordId ? ` -> \`${it.recordId}\`` : ""}${it.supersedesId ? ` (supersedes \`${it.supersedesId}\`)` : ""}`,
      );
    }
    if (res.items.length > 50) {
      lines.push(`... and ${res.items.length - 50} more`);
    }
  }
  return lines.join("\n");
}

export function formatImportJsonlMarkdown(res: ImportJsonlResult): string {
  return [
    `# import-jsonl Summary`,
    `- Rows: ${res.totalRows}`,
    `- Imported: ${res.imported}`,
    `- Superseded: ${res.superseded}`,
    `- Skipped (secret): ${res.skippedSecret}`,
    `- Skipped (redacted): ${res.skippedRedacted}`,
    `- Tree-degraded cross-realm supersedes: ${res.treeDegradedCrossRealmSupersedes}`,
    `- Undated: ${res.undatedCount}`,
    `- Default realm fallback: ${res.defaultRealmCount}`,
  ].join("\n");
}

export function formatImportBatchMarkdown(res: ImportBatchResult): string {
  const lines: string[] = [
    `# Import Batch${res.dryRun ? " (Dry Run)" : ""}`,
    `- Total items: ${res.totalItems}`,
    `- Created: ${res.created}`,
    `- Superseded: ${res.superseded}`,
    `- Relocated: ${res.relocated}`,
    `- Skipped (unchanged): ${res.skippedUnchanged}`,
    `- Skipped (redacted): ${res.skippedRedacted}`,
    `- Skipped (secret): ${res.skippedSecret}`,
    `- Undated: ${res.undatedCount}`,
    `- Default realm fallback: ${res.defaultRealmCount}`,
  ];
  if (res.realmProjections && res.realmProjections.length > 0) {
    lines.push("", "## Realm Doctor Projections");
    for (const p of res.realmProjections) {
      const warn = p.exceedsDoctorThreshold ? " [EXCEEDS THRESHOLD]" : "";
      lines.push(
        `- \`${p.realmPath}\`: ${p.existingDirectCount} + ${p.projectedDelta} = ${p.projectedDirectCount} (threshold ${p.doctorThreshold})${warn}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatImportVerifyMarkdown(
  res: ImportConsistencyResult,
): string {
  const lines: string[] = [
    `# import-verify: ${res.passed ? "PASSED" : "FAILED"}`,
    `- Source files: ${res.totalSourceFiles} (expected: ${res.expectedCount}, excluded: ${res.excludedCount}, unaccounted: ${res.unaccountedCount})`,
    `- Found: ${res.foundCount} | Missing: ${res.missingCount} | Unexpected: ${res.unexpectedCount}`,
    `- Content mismatches: ${res.contentMismatchCount} | Realm mismatches: ${res.realmMismatchCount} | Layer mismatches: ${res.layerMismatchCount}`,
    `- Status mismatches: ${res.statusMismatchCount} | Timestamp mismatches: ${res.timestampMismatchCount}`,
    `- Skipped: secret=${res.skippedSecretCount}, redacted=${res.skippedRedactedCount} (allowSkips=${res.allowSkips})`,
    ...(res.checkedLayers && res.checkedLayers.length > 0
      ? [`- Checked layers: ${res.checkedLayers.join(", ")}`]
      : []),
    `- Undated: ${res.undatedCount} | Default realm fallback: ${res.defaultRealmFallbackCount}`,
  ];
  if (res.unaccountedPaths.length > 0) {
    lines.push("", "## Unaccounted Source Files");
    for (const p of res.unaccountedPaths.slice(0, 20)) {
      lines.push(`- \`${p}\``);
    }
  }
  if (res.mismatches.length > 0) {
    lines.push("", "## Mismatches");
    for (const m of res.mismatches.slice(0, 20)) {
      lines.push(
        `- \`${m.sourceRef}\` (\`${m.recordId ?? "missing"}\`): ${m.reason} (expected \`${m.expected ?? "null"}\`, got \`${m.actual ?? "null"}\`)`,
      );
    }
  }
  if (res.unexpectedEntries.length > 0) {
    lines.push("", "## Unexpected Imported Entries");
    for (const u of res.unexpectedEntries.slice(0, 20)) {
      lines.push(
        `- \`${u.sourceRef}\` (\`${u.entryId}\`, ${u.layer} in \`${u.realmPath}\`)`,
      );
    }
  }
  return lines.join("\n");
}

export function formatGenericMarkdown(title: string, data: unknown): string {
  return [`# ${title}`, "", "```json", JSON.stringify(data, null, 2), "```"].join(
    "\n",
  );
}

export function formatWhoamiMarkdown(res: WhoamiResult): string {
  return [
    `# Whoami: ${res.org.name} (\`${res.org.id}\`, policy: \`${res.org.policy}\`)`,
    `- **Actor**: \`${res.actor.id}\` (${res.actor.kind}${res.actor.family ? `, ${res.actor.family}` : ""})`,
    `- **Bound Realm**: \`${res.bound.realmPath}\` (\`${res.bound.realmId}\`, source: ${res.bound.source})`,
    `- **Read**: policy=\`${res.read.policy}\`, realms=${res.read.ledgerRealms}, drive=${res.read.driveRealms}, raw=${res.read.seabedRealms}`,
    `- **Write**: ${res.write.allowed}`,
    `- **Corpus**: realms=${res.corpus.realms}, objects=${res.corpus.objects}, rules=${res.corpus.rules}, conclusions=${res.corpus.conclusions}, raw=${res.corpus.raw}, files=${res.corpus.files}`,
    ...(res.inbox
      ? [
          `- **Inbox**: \`${res.inbox.path}\` (${res.inbox.activeEntries} active pending triage)`,
        ]
      : []),
    `- **Latest Seq**: ${res.latestSeq} (version ${res.version}, schema v${res.schemaVersion})`,
    `- **Store (local-only)**: \`${res.store.path}\``,
    `- **Next**: \`${res.next}\``,
  ].join("\n");
}

function formatShowWindowFooter(ref: string, w: ShowWindow): string | null {
  if (!w.truncated) return null;
  if (w.nextCursor !== null) {
    return `--- chars ${w.start}–${w.end} of ${w.total} · next: meru-mind show ${ref} --cursor ${w.nextCursor} · all: --full (${w.total} chars)`;
  }
  return `--- chars ${w.start}–${w.end} of ${w.total} · end of content · all: --full (${w.total} chars)`;
}

function formatEntryHeaderLines(res: CatResult): string[] {
  if (res.kind === "record") {
    const r = res.record;
    const badge = formatBehaviorBadge(res.behaviorClass, r.kind, r.extKind);
    const lines: string[] = [
      `# ${badge} ${r.title}`,
      "",
      `- **ID**: \`${r.id}\``,
      `- **Realm**: \`${res.realmPath}\` (\`${r.realmId}\`)`,
      `- **Status**: \`${r.status}\`${res.orphanSuperseded ? " _(orphan superseded)_" : ""}`,
      `- **Author**: \`${r.authorId}\` (${r.authorKind}, confirmedByHuman: ${r.confirmedByHuman})`,
      `- **Occurred**: ${formatDateLabel(r.occurredAt)}`,
      `- **Sensitivity**: \`${r.sensitivity}\``,
    ];
    if (r.externalRef) lines.push(`- **External Ref**: \`${r.externalRef}\``);
    if (r.sourceRef) lines.push(`- **Source Ref**: \`${r.sourceRef}\``);
    if (r.supersedesIds && r.supersedesIds.length > 1) {
      lines.push(
        `- **Supersedes**: ${r.supersedesIds.map((id) => `\`${id}\``).join(", ")}`,
      );
    } else if (r.supersedesId) {
      lines.push(`- **Supersedes**: \`${r.supersedesId}\``);
    }
    if (r.supersededById)
      lines.push(`- **Superseded By**: \`${r.supersededById}\``);
    if (res.currentHeadId)
      lines.push(`- **Current Head**: \`${res.currentHeadId}\``);
    if (res.objectIds.length > 0)
      lines.push(
        `- **Objects**: ${res.objectIds.map((o) => `\`${o}\``).join(", ")}`,
      );
    if (res.resourceTags.length > 0)
      lines.push(
        `- **Tags**: ${res.resourceTags.map((t) => `\`${t}\``).join(", ")}`,
      );
    if (r.refs.length > 0)
      lines.push(`- **Refs**: ${r.refs.map((ref) => `\`${ref}\``).join(", ")}`);
    return lines;
  }

  if (res.kind === "seabed") {
    const s = res.seabed;
    const badge = formatBehaviorBadge("raw", s.kind);
    const lines: string[] = [
      `# ${badge} ${s.kind}${s.topicId ? ` (${s.topicId})` : ""}`,
      "",
      `- **ID**: \`${s.id}\``,
      `- **Realm**: \`${res.realmPath}\` (\`${s.realmId}\`)`,
      `- **Author**: \`${s.authorId}\` (${s.authorKind})`,
      `- **Occurred**: ${formatDateLabel(s.occurredAt)}`,
      `- **Sensitivity**: \`${s.sensitivity}\``,
    ];
    if (s.sourceRef) lines.push(`- **Source Ref**: \`${s.sourceRef}\``);
    if (res.objectIds.length > 0)
      lines.push(
        `- **Objects**: ${res.objectIds.map((o) => `\`${o}\``).join(", ")}`,
      );
    if (res.resourceTags.length > 0)
      lines.push(
        `- **Tags**: ${res.resourceTags.map((t) => `\`${t}\``).join(", ")}`,
      );
    return lines;
  }

  if (res.kind === "distillation") {
    const d = res.distillation;
    return [
      `# [conclusion/${d.layer}] ${d.periodKey}`,
      "",
      `- **ID**: \`${d.id}\``,
      `- **Realm**: \`${res.realmPath}\` (\`${d.realmId}\`)`,
      `- **Status**: \`${d.status}\``,
      `- **Created**: ${d.createdAt}`,
      `- **Sources**: ${d.sourceIds.length}`,
    ];
  }

  const f = res.file;
  return [
    `# [raw/drive] ${f.relPath} (v${f.version})`,
    "",
    `- **Realm**: \`${res.realmPath}\` (\`${f.realmId}\`)`,
    `- **Updated**: ${f.updatedAt} by \`${f.updatedBy}\``,
    `- **SHA-256**: \`${f.sha256}\``,
  ];
}

function formatRelativeAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const mins = Math.floor(ageSeconds / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function formatActivePeersBlock(activePeers?: ShowResult extends never ? never : Array<{
  sessionId: string;
  actorId: string;
  actorKind: string;
  clientHint: string | null;
  realmPath: string;
  focus: string[];
  keys?: string[];
  matchedKeys?: string[];
  note: string | null;
  activity?: string | null;
  mode?: string;
  state?: string;
  source?: string;
  ageSeconds: number;
  online: boolean;
}>): string[] {
  if (!activePeers || activePeers.length === 0) return [];
  return [
    "",
    `## Active Peers (${activePeers.length})`,
    ...activePeers.map((p) => {
      const handle = `#${p.sessionId.replace(/^ps_/, "").slice(0, 4)}`;
      const clientPart = p.clientHint
        ? `${p.actorKind}, ${p.clientHint} ${handle}`
        : `${p.actorKind} ${handle}`;
      const who = `${p.actorId} (${clientPart})`;
      const status =
        p.state === "turn_ended"
          ? `turn-ended ${formatRelativeAge(p.ageSeconds)}`
          : p.state === "silent"
            ? `silent ${formatRelativeAge(p.ageSeconds)}`
            : p.online
              ? p.mode === "working"
                ? "working"
                : "online"
              : `active ${formatRelativeAge(p.ageSeconds)}`;
      const extraFocus = p.focus.filter((f) => f && f !== p.realmPath);
      const keysLabel =
        p.matchedKeys && p.matchedKeys.length > 0
          ? `keys: ${p.matchedKeys.join(", ")}`
          : p.keys && p.keys.length > 0
            ? `keys: ${p.keys.slice(0, 3).join(", ")}`
            : "";
      const sourceLabel = p.source ? `source=${p.source}` : "";
      const details = [
        sourceLabel,
        keysLabel,
        p.activity ? p.activity : "",
        !keysLabel && extraFocus.length > 0 ? `focus: ${extraFocus.join(", ")}` : "",
        p.note ? `"${p.note}"` : "",
      ].filter(Boolean);
      return `- ${who} · ${status}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
    }),
  ];
}

export function formatShowMarkdown(res: ShowResult): string {
  if (res.refType === "realm") {
    const base = formatBriefMarkdown(res.brief);
    const peerLines = formatActivePeersBlock(res.activePeers);
    if (peerLines.length === 0) return base;
    return `${base}\n${peerLines.join("\n")}`;
  }
  if (res.refType === "object") {
    const c = res.card;
    const breadcrumb = c.realmPath
      ? `${c.realmPath} › ${c.kind} › ${c.name}`
      : `${c.kind} › ${c.name}`;
    let stateBadge = "";
    if (c.object && c.object.state && c.object.state !== "active") {
      const stateParts: string[] = [];
      if (c.object.stateLabel) stateParts.push(c.object.stateLabel);
      if (c.object.stateSince) stateParts.push(`since ${c.object.stateSince}`);
      if (c.object.stateEvidenceId) {
        stateParts.push(`evidence: ${c.object.stateEvidenceId}`);
      }
      const detail =
        stateParts.length > 0 ? `: ${stateParts.join(", ")}` : "";
      stateBadge = ` [${c.object.state}${detail}]`;
    }
    const withBadge =
      c.withRefs && c.withRefs.length > 0
        ? ` (+with: ${c.withRefs.join(", ")})`
        : "";
    const lines: string[] = [
      `# ${c.kind}:${c.name}   ${breadcrumb}${stateBadge}${withBadge}`,
    ];

    // Section 2: Rules (untruncated, grouped: 墙 / 本对象及上级 / --with; omit if 0 — V5)
    if (c.rules.length > 0) {
      lines.push("", `## 规矩 (${c.rules.length})`);
      const wallRules = c.rules.filter((r) => r.scopeSource === "realm");
      const objRules = c.rules.filter((r) => r.scopeSource === "object");
      const withRules = c.rules.filter((r) => r.scopeSource === "with");
      const emitRuleGroup = (label: string, items: typeof c.rules) => {
        if (items.length === 0) return;
        lines.push(`### ${label}`);
        for (const r of items) {
          lines.push(
            `- [rule] \`${r.id}\` **${r.title}** (\`${r.sourceRef}\`) — ${r.body}`,
          );
        }
      };
      emitRuleGroup("墙", wallRules);
      emitRuleGroup("本对象及上级", objRules);
      emitRuleGroup("--with", withRules);
    }

    // Section 3: Pending Decisions (omit if 0 — V5)
    if (c.pendingDecisions.totalCount > 0) {
      lines.push(
        "",
        `## 待拍板 (${c.pendingDecisions.items.length}/${c.pendingDecisions.totalCount})`,
      );
      for (const p of c.pendingDecisions.items) {
        lines.push(
          `- [proposal] \`${p.id}\` **${p.title}** (${p.realmPath} @ ${formatDateLabel(p.occurredAt)})`,
        );
      }
    }

    // Section 4: Active Decisions (omit if 0 — V5)
    if (c.activeDecisions.totalCount > 0) {
      lines.push(
        "",
        `## 现行决定 (${c.activeDecisions.items.length}/${c.activeDecisions.totalCount})`,
      );
      for (const d of c.activeDecisions.items) {
        lines.push(
          `- [decision] \`${d.id}\` **${d.title}** (${d.realmPath} @ ${formatDateLabel(d.occurredAt)})`,
        );
      }
      if (c.activeDecisions.totalCount > c.activeDecisions.items.length) {
        const extra = c.activeDecisions.totalCount - c.activeDecisions.items.length;
        lines.push(
          `... (+${extra} more; inspect: \`meru-mind ls ${c.ref} --kind decision\`)`,
        );
      }
    }

    // Section 5: Recent Findings (omit if 0 — V5)
    if (c.recentFindings.totalCount > 0) {
      lines.push(
        "",
        `## 近期发现 (${c.recentFindings.items.length}/${c.recentFindings.totalCount})`,
      );
      for (const f of c.recentFindings.items) {
        lines.push(
          `- [finding] \`${f.id}\` **${f.title}** (${f.realmPath} @ ${formatDateLabel(f.occurredAt)})`,
        );
      }
    }

    // Section 6: Children · Co-occurring (omit if both 0 — V5)
    if (c.children.length > 0 || c.coOccurring.length > 0) {
      lines.push(
        "",
        `## 下级 (${c.children.length}) · 同现 (${c.coOccurring.length})`,
      );
      for (const ch of c.children) {
        const chState =
          ch.state && ch.state !== "active"
            ? ` [${ch.stateLabel || ch.state}]`
            : "";
        lines.push(`- [child] \`${ch.ref}\` (\`${ch.id}\`)${chState}`);
      }
      for (const co of c.coOccurring) {
        const ruleTag = co.ruleCount > 0 ? `, rules=${co.ruleCount}` : "";
        lines.push(
          `- [co] \`${co.ref}\` (shared=${co.sharedCount}${ruleTag}) · \`${co.tryCommand}\``,
        );
      }
    }

    const peerLines = formatActivePeersBlock(res.activePeers);
    if (peerLines.length > 0) {
      lines.push(...peerLines);
    }

    // Section 8: Footer (Metadata + Next)
    const metaParts: string[] = [`Kind: \`${c.kind}\``];
    if (c.object) metaParts.push(`ID: \`${c.object.id}\``);
    if (c.realmPath) metaParts.push(`Realm: \`${c.realmPath}\``);
    metaParts.push(
      `Entries: total=${c.counts.total} (object=${c.counts.viaObject}, tag=${c.counts.viaTag}, thing=${c.counts.viaThing})`,
    );
    metaParts.push(`seq=${c.latestSeq}`);
    lines.push(
      "",
      "---",
      metaParts.join(" · "),
      `Next: \`meru-mind changes --since ${c.latestSeq} --about ${c.ref}\` · \`${c.try}\``,
    );
    return lines.join("\n");
  }
  if (res.refType === "file") {
    const f = res.file;
    const w = res.window;
    const isContinuation = w.start > 0 && w.around === undefined;
    const footer = formatShowWindowFooter(res.ref, w);
    if (isContinuation) {
      const lines: string[] = [
        `# ${res.ref} (continuation · chars ${w.start}–${w.end} of ${w.total})`,
        "",
        f.content,
      ];
      if (footer) lines.push("", footer);
      return lines.join("\n");
    }
    const lines: string[] = [
      `# [raw/file] \`${res.ref}\` (v${f.version})`,
      "",
      `- **Realm**: \`${res.realmPath}\` (\`${f.realmId}\`)`,
      `- **Updated**: ${f.updatedAt} by \`${f.updatedBy}\``,
      `- **SHA-256**: \`${f.sha256}\``,
    ];
    if (w.around && w.aroundMatched === false) {
      lines.push(
        "",
        `Note: no match for "${w.around}" in content; showing from start.`,
      );
    }
    lines.push("", f.content);
    if (footer) lines.push("", footer);
    return lines.join("\n");
  }

  const w = res.window;
  const isContinuation = w.start > 0 && w.around === undefined;
  const footer = formatShowWindowFooter(res.ref, w);
  const inactiveSuffix = formatInactiveBadgesMarkdown(res.inactive);
  if (isContinuation) {
    const lines: string[] = [
      `# ${res.ref} (continuation · chars ${w.start}–${w.end} of ${w.total})${inactiveSuffix}`,
    ];
    if (res.content) {
      lines.push("", res.content);
    }
    if (footer) lines.push("", footer);
    return lines.join("\n");
  }

  const headerLines = formatEntryHeaderLines(res.entry);
  if (inactiveSuffix && headerLines.length > 0) {
    headerLines[0] = `${headerLines[0]!}${inactiveSuffix}`;
  }
  const sections: string[] = [...headerLines];
  if (w.around && w.aroundMatched === false) {
    sections.push(
      "",
      `Note: no match for "${w.around}" in content; showing from start.`,
    );
  }
  if (res.entry.kind === "record") {
    if (res.content) {
      if (res.content.startsWith("## Payload")) {
        sections.push("", res.content);
      } else {
        sections.push("", "## Body", "", res.content);
      }
    }
  } else if (res.entry.kind === "seabed") {
    sections.push("", "## Content", "", res.content);
  } else if (res.content) {
    sections.push("", res.content);
  }

  if (res.history && res.history.nodes.length > 0) {
    sections.push(
      "",
      `## History (${res.history.nodes.length}, head: \`${res.history.currentHeadId ?? "none"}\`)`,
      ...res.history.nodes.map(
        (n) =>
          `- \`${n.id}\` (${n.status}) ${n.title} @ ${formatDateLabel(n.occurredAt)}`,
      ),
    );
  }
  if (res.context) {
    sections.push("", formatReplayMarkdown(res.context));
  }
  if (footer) {
    sections.push("", footer);
  }
  return sections.join("\n");
}

export function formatSearchMarkdown(res: SearchResult): string {
  const scopeParts: string[] = [];
  if (res.in) scopeParts.push(`in=\`${res.in}\``);
  if (res.about) scopeParts.push(`about=\`${res.about}\``);
  if (res.interpretedDates && res.interpretedDates.length > 0) {
    scopeParts.push(
      `dates=${res.interpretedDates.map((d) => `\`${d}\``).join(",")}`,
    );
  }
  const scopeSuffix = scopeParts.length > 0 ? ` [${scopeParts.join(", ")}]` : "";
  const lines: string[] = [
    `# Search "${res.query}"${scopeSuffix} (${res.items.length}/${res.totalMatched}, omitted: ${res.omittedCount})`,
    "",
  ];
  let anyTruncated = false;
  if (res.items.length === 0) {
    lines.push("_(no matches)_");
  } else {
    for (const item of res.items) {
      const cls: BehaviorClass =
        item.behaviorClass ??
        (item.sourceType === "seabed"
          ? "raw"
          : item.kind === "rule"
            ? "rule"
            : "conclusion");
      const badge = formatBehaviorBadge(cls, item.kind, item.extKind);
      const headHint = item.orphanSuperseded
        ? " (orphan superseded)"
        : item.currentHeadId !== undefined
          ? ` -> head:\`${item.currentHeadId ?? "none"}\``
          : "";
      const realmLabel = item.realmPath
        ? ` in \`${item.realmPath}\`${item.realmArchived ? " [archived]" : ""}`
        : item.realmArchived
          ? " [archived]"
          : "";
      const truncBadge = item.truncated
        ? ` [${item.shownChars}/${item.contentChars} chars]`
        : "";
      if (item.truncated) {
        anyTruncated = true;
      }
      const inactiveSuffix = formatInactiveBadgesMarkdown(item.inactive);
      lines.push(
        `- ${badge} \`${item.id}\` **${item.title}**${realmLabel} (${item.status}${headHint}, @ ${formatDateLabel(item.occurredAt)}) — ${item.snippet}${truncBadge}${inactiveSuffix}`,
      );
    }
    if (res.omittedCount > 0 && res.nextCursor) {
      lines.push(
        `... and ${res.omittedCount} more (next page: meru-mind search "${res.query}" --cursor ${res.nextCursor}; inspect: meru-mind show <id>)`,
      );
    }
    if (anyTruncated) {
      lines.push(
        `Hits marked [shown/total chars] are excerpts. Inspect full entry: meru-mind show <id> --around "<query>"`,
      );
    }
  }
  return lines.join("\n");
}

export function formatImportDryRunMarkdown(res: ImportDryRunResult): string {
  const statusLabel = res.valid
    ? "READY"
    : [
        res.unresolvedRealms.length > 0 ? "UNRESOLVED REALMS" : "",
        res.oversizedFiles.length > 0 ? "OVERSIZED FILES" : "",
      ]
        .filter(Boolean)
        .join(" + ");
  const lines: string[] = [
    `# Import Dry Run (${res.sourceType.toUpperCase()}) — ${statusLabel}`,
    "",
    `- **Total items**: ${res.totalItems}`,
    `- **Planned default realm**: \`${res.plannedDefaultRealm}\` (${res.defaultRealmCount} fallback item(s))`,
    `- **Undated**: ${res.undatedCount} | **Skipped secret**: ${res.skippedSecret} | **Skipped redacted**: ${res.skippedRedacted}`,
    "",
    "## Planned Realm Distribution",
  ];
  const distEntries = Object.entries(res.realmDistribution).sort(
    (a, b) => b[1] - a[1],
  );
  if (distEntries.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const [realmPath, count] of distEntries) {
      lines.push(`- \`${realmPath}\`: ${count}`);
    }
  }
  const unmatchedEntries = Object.entries(res.unmatchedRealmValues).sort(
    (a, b) => b[1] - a[1],
  );
  if (unmatchedEntries.length > 0) {
    lines.push("", "## Unmatched Raw Realm Field Values");
    for (const [val, count] of unmatchedEntries) {
      lines.push(`- \`${val}\`: ${count}`);
    }
  }
  if (res.unresolvedRealms.length > 0) {
    lines.push("", "## Unresolved Realm Targets (Fix Before Importing)");
    for (const u of res.unresolvedRealms) {
      lines.push(
        `- raw \`${u.rawValue}\` -> \`${u.targetRef}\` (${u.count} item(s))`,
      );
    }
  }
  if (res.oversizedFiles.length > 0) {
    lines.push("", "## Oversized Files (Exceed Import Size Limit)");
    for (const f of res.oversizedFiles) {
      const mb = (f.sizeBytes / 1_048_576).toFixed(2);
      const limMb = (f.limitBytes / 1_048_576).toFixed(2);
      lines.push(`- \`${f.path}\` (${mb} MB > ${limMb} MB limit)`);
    }
  }
  return lines.join("\n");
}

export function formatExportMdMarkdown(res: ExportMdResult): string {
  const lines: string[] = [
    `# One-Way Markdown Export${res.dryRun ? " (Dry Run)" : ""}`,
    "",
    `- **Org**: ${res.orgName} (\`${res.orgId}\`)`,
    `- **Output Dir**: \`${res.outDir}\``,
    `- **Exported**: ${res.exportedCount} active record(s)`,
    `- **Skipped**: secret=${res.skippedSecret}, confidential=${res.skippedConfidential}, redacted=${res.skippedRedacted}`,
  ];
  if (res.manifestPath) {
    lines.push(`- **Manifest**: \`${res.manifestPath}\``);
  }
  lines.push(
    "",
    "> One-way projection only: do not edit exported files expecting sync back into SQLite. If committed to Git, `redact` cannot purge historical Git commits.",
  );
  return lines.join("\n");
}

export function formatDoctorMarkdown(report: DoctorReport): string {
  const status = report.healthy ? "HEALTHY" : "NEEDS ATTENTION";
  const lines: string[] = [
    `# Meru Mind Realm Doctor — ${status}`,
    "",
    `- **Org**: ${report.orgName} (\`${report.orgId}\`, policy: \`${report.orgPolicy}\`)`,
    `- **Visible active realms**: ${report.summary.visibleActiveRealms} | **Conclusions**: ${report.summary.totalDirectConclusions} | **Rules**: ${report.summary.totalDirectRules}`,
    `- **Findings**: ${report.summary.warnCount} warn, ${report.summary.infoCount} info`,
  ];
  if (report.findings.length === 0) {
    lines.push("", "No hygiene issues detected in visible scope.");
    return lines.join("\n");
  }
  lines.push("");
  for (const f of report.findings) {
    const tag = f.severity === "warn" ? "[WARN]" : "[INFO]";
    lines.push(`- ${tag} \`${f.code}\` (\`${f.realmPath}\`): ${f.summary}`);
    lines.push(`  - Next: \`${f.try}\``);
  }
  return lines.join("\n");
}
