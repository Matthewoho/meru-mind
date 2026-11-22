import {
  computeDuplicateObjectKeys,
  formatCanonicalObjectRef,
} from "../engine/refs.js";
import type {
  BehaviorClass,
  BriefOutput,
  CatResult,
  ChangesResult,
  ImportConsistencyResult,
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
    lines.push(`${indent}- \`${canonicalRef}\` (\`${o.id}\`)`);
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
    lines.push(
      `${indent}- **${r.path}** — ${r.name} (\`${r.id}\`) ${countsStr}`,
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
  return `- ${badge} \`${item.id}\` ${item.title}${ext}${statusTag} — ${item.realmPath} @ ${formatDateLabel(item.occurredAt)}${tags}`;
}

export function formatLsMarkdown(res: LsResult): string {
  const lines: string[] = [
    `# ls ${res.targetType}: \`${res.target}\` (resolved: \`${res.resolvedId}\`)`,
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
      `Objects (${res.objects.length}): ${res.objects.map((o) => `\`${o.ref}\``).join(", ")}`,
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
  const lines: string[] = [
    `# Brief: ${brief.realm.name} (\`${brief.realm.path}\`, \`${brief.realm.id}\`)`,
    `Generated: ${brief.generatedAt}`,
  ];
  if (brief.buckets) {
    lines.push(
      `Buckets: **rules**=${brief.buckets.rules}, **conclusions**=${brief.buckets.conclusions}, **raw**=${brief.buckets.raw}`,
    );
  }
  const histEntries = Object.entries(brief.kindHistogram ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (histEntries.length > 0) {
    lines.push(
      `Kinds: ${histEntries.map(([k, c]) => `${k}=${c}`).join(", ")}`,
    );
  }

  // Bucket 1: Rules
  lines.push(
    "",
    `## Rules (${brief.middleMind.rules.items.length}/${brief.middleMind.rules.totalCount}, omitted: ${brief.middleMind.rules.omittedCount})`,
  );
  if (brief.middleMind.rules.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const r of brief.middleMind.rules.items) {
      lines.push(
        `- [rule] \`${r.id}\` ${r.title}${r.inherited ? " _(inherited)_" : ""}`,
      );
    }
  }

  // Bucket 2: Conclusions
  lines.push(
    "",
    `## Conclusions`,
    `### Recent Conclusions (${brief.recentConclusions.items.length}/${brief.recentConclusions.totalCount}, omitted: ${brief.recentConclusions.omittedCount})`,
  );
  if (brief.recentConclusions.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const c of brief.recentConclusions.items) {
      lines.push(
        `- [conclusion/${c.kind}] \`${c.id}\` ${c.title} @ ${formatDateLabel(c.occurredAt)}`,
      );
    }
  }

  lines.push(
    `### Pending Human Questions (${brief.upperLedger.pendingQuestions.items.length}/${brief.upperLedger.pendingQuestions.totalCount}, omitted: ${brief.upperLedger.pendingQuestions.omittedCount})`,
  );
  if (brief.upperLedger.pendingQuestions.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const q of brief.upperLedger.pendingQuestions.items) {
      lines.push(`- [conclusion/proposal] \`${q.id}\` ${q.title}`);
    }
  }

  lines.push(
    `### Active Things (${brief.upperLedger.activeThings.items.length}/${brief.upperLedger.activeThings.totalCount}, omitted: ${brief.upperLedger.activeThings.omittedCount})`,
  );
  if (brief.upperLedger.activeThings.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const t of brief.upperLedger.activeThings.items) {
      const ext = t.externalRef ? ` <${t.externalRef}>` : "";
      lines.push(`- [conclusion/thing] \`${t.id}\` ${t.title}${ext}`);
    }
  }

  lines.push(
    `### Active Decisions (${brief.upperLedger.activeDecisions.items.length}/${brief.upperLedger.activeDecisions.totalCount}, omitted: ${brief.upperLedger.activeDecisions.omittedCount})`,
  );
  if (brief.upperLedger.activeDecisions.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const d of brief.upperLedger.activeDecisions.items) {
      lines.push(`- [conclusion/decision] \`${d.id}\` ${d.title}`);
    }
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

  // Bucket 3: Raw (Recent Messages)
  lines.push(
    "",
    `## Raw (${brief.surface.recentMessages.items.length}/${brief.surface.recentMessages.totalCount}, omitted: ${brief.surface.recentMessages.omittedCount})`,
  );
  if (brief.surface.recentMessages.items.length === 0) {
    lines.push("- _(none)_");
  } else {
    for (const m of brief.surface.recentMessages.items) {
      const text =
        m.text.length > 500
          ? `${m.text.slice(0, 500)}... [+${m.text.length - 500} chars]`
          : m.text;
      lines.push(
        `- [raw/${m.kind}] \`${m.id}\` (${m.authorId} @ ${formatDateLabel(m.occurredAt)}): ${text}`,
      );
    }
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
  const lines: string[] = [
    `# Recall (${res.items.length}/${res.totalMatched}, omitted: ${res.omittedCount})`,
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
      const badge = formatBehaviorBadge(cls, item.kind);
      const headHint = item.orphanSuperseded
        ? " (orphan superseded)"
        : item.currentHeadId !== undefined
          ? ` -> head:\`${item.currentHeadId ?? "none"}\``
          : "";
      lines.push(
        `- ${badge} \`${item.id}\` **${item.title}** (${item.status}${headHint}, @ ${formatDateLabel(item.occurredAt)}) — ${item.snippet}`,
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

export function formatImportVerifyMarkdown(
  res: ImportConsistencyResult,
): string {
  const lines: string[] = [
    `# import-verify: ${res.passed ? "PASSED" : "FAILED"}`,
    `- Checked: ${res.totalChecked}`,
    `- Missing: ${res.missingCount}`,
    `- Active/Superseded mismatches: ${res.activeSupersededMismatches.length}`,
    `- Timestamp mismatches: ${res.timestampMismatches.length}`,
    `- Undated: ${res.undatedCount}`,
    `- Default realm fallback: ${res.defaultRealmFallbackCount}`,
  ];
  if (res.activeSupersededMismatches.length > 0) {
    lines.push("", "## Active/Superseded Mismatches");
    for (const m of res.activeSupersededMismatches.slice(0, 20)) {
      lines.push(
        `- \`${m.sourceRef}\` (\`${m.recordId ?? "missing"}\`): expected \`${m.expected}\`, got \`${m.actual}\``,
      );
    }
  }
  if (res.timestampMismatches.length > 0) {
    lines.push("", "## Timestamp Mismatches");
    for (const m of res.timestampMismatches.slice(0, 20)) {
      lines.push(
        `- \`${m.sourceRef}\` (\`${m.recordId ?? "missing"}\`): expected \`${m.expected ?? "null"}\`, got \`${m.actual ?? "null"}\``,
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

export function formatShowMarkdown(res: ShowResult): string {
  if (res.refType === "realm") {
    return formatBriefMarkdown(res.brief);
  }
  if (res.refType === "object") {
    const c = res.card;
    const lines: string[] = [
      `# Object: \`${c.ref}\``,
      `- **Kind**: \`${c.kind}\``,
      `- **Name**: ${c.name}`,
    ];
    if (c.object) {
      lines.push(`- **ID**: \`${c.object.id}\``);
    }
    if (c.realmPath) {
      lines.push(`- **Realm**: \`${c.realmPath}\``);
    }
    lines.push(
      `- **Entries**: total=${c.counts.total} (object=${c.counts.viaObject}, tag=${c.counts.viaTag}, thing=${c.counts.viaThing})`,
      "",
      `## Recent Entries (${c.recentEntries.length}/${c.counts.total})`,
    );
    if (c.recentEntries.length === 0) {
      lines.push("_(none)_");
    } else {
      for (const item of c.recentEntries) {
        lines.push(formatLsEntryLine(item));
      }
    }
    lines.push("", `Next: \`${c.try}\``);
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
  if (isContinuation) {
    const lines: string[] = [
      `# ${res.ref} (continuation · chars ${w.start}–${w.end} of ${w.total})`,
    ];
    if (res.content) {
      lines.push("", res.content);
    }
    if (footer) lines.push("", footer);
    return lines.join("\n");
  }

  const sections: string[] = [...formatEntryHeaderLines(res.entry)];
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
      const badge = formatBehaviorBadge(cls, item.kind);
      const headHint = item.orphanSuperseded
        ? " (orphan superseded)"
        : item.currentHeadId !== undefined
          ? ` -> head:\`${item.currentHeadId ?? "none"}\``
          : "";
      const realmLabel = item.realmPath ? ` in \`${item.realmPath}\`` : "";
      const truncBadge = item.truncated
        ? ` [${item.shownChars}/${item.contentChars} chars]`
        : "";
      if (item.truncated) {
        anyTruncated = true;
      }
      lines.push(
        `- ${badge} \`${item.id}\` **${item.title}**${realmLabel} (${item.status}${headHint}, @ ${formatDateLabel(item.occurredAt)}) — ${item.snippet}${truncBadge}`,
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
