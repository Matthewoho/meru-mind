import type {
  BehaviorClass,
  BriefOutput,
  CatResult,
  ChangesResult,
  ImportJsonlResult,
  ImportMdResult,
  LedgerRecord,
  LsEntry,
  LsResult,
  MindObject,
  ObjectTreeNode,
  RealmTreeNode,
  RecallResult,
  ReplayResult,
  ResourceTagSummary,
  TreeResult,
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

function renderObjectTreeLines(
  nodes: ObjectTreeNode[],
  indent = "",
): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const o = node.object;
    lines.push(`${indent}- \`${o.kind}\` **${o.name}** (\`${o.id}\`)`);
    if (node.children.length > 0) {
      lines.push(...renderObjectTreeLines(node.children, `${indent}  `));
    }
  }
  return lines;
}

function renderRealmTreeLines(nodes: RealmTreeNode[], indent = ""): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const r = node.realm;
    lines.push(`${indent}- **${r.path}** — ${r.name} (\`${r.id}\`)`);
    if (node.objects.length > 0) {
      lines.push(...renderObjectTreeLines(node.objects, `${indent}  `));
    }
    if (node.children.length > 0) {
      lines.push(...renderRealmTreeLines(node.children, `${indent}  `));
    }
  }
  return lines;
}

export function formatTreeMarkdown(res: TreeResult): string {
  const lines: string[] = [
    `# Tree: ${res.org.name} (\`${res.org.id}\`, policy: \`${res.org.policy}\`)`,
    "",
    `## Realms (${res.realms.length})`,
  ];
  if (res.realmTree.length === 0) {
    lines.push("- _(none)_");
  } else {
    lines.push(...renderRealmTreeLines(res.realmTree));
  }
  lines.push("", `## Objects (${res.objects.length})`);
  if (res.objectTree.length === 0) {
    lines.push("- _(none)_");
  } else {
    lines.push(...renderObjectTreeLines(res.objectTree));
  }
  return lines.join("\n");
}

function formatLsEntryLine(item: LsEntry): string {
  const badge = formatBehaviorBadge(item.behaviorClass, item.kind, item.extKind);
  const tags =
    item.resourceTags.length > 0 ? ` {${item.resourceTags.join(", ")}}` : "";
  const ext = item.externalRef ? ` <${item.externalRef}>` : "";
  const statusTag = item.status !== "active" && item.status !== "evidence" ? ` (${item.status})` : "";
  return `- ${badge} \`${item.id}\` ${item.title}${ext}${statusTag} — ${item.realmPath} @ ${item.occurredAt}${tags}`;
}

export function formatLsMarkdown(res: LsResult): string {
  const lines: string[] = [
    `# ls ${res.targetType}: \`${res.target}\` (resolved: \`${res.resolvedId}\`)`,
    `Showing ${res.items.length} of ${res.totalMatched} (omitted: ${res.omittedCount})`,
    "",
  ];
  if (res.items.length === 0) {
    lines.push("_(empty)_");
  } else {
    for (const item of res.items) {
      lines.push(formatLsEntryLine(item));
    }
  }
  if (res.driveFiles && res.driveFiles.length > 0) {
    lines.push("", `## Drive Files (${res.driveFiles.length})`);
    for (const df of res.driveFiles) {
      lines.push(`- \`${df.relPath}\` (v${df.version}, updated ${df.updatedAt})`);
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
      `- **Status**: \`${r.status}\``,
      `- **Author**: \`${r.authorId}\` (${r.authorKind}, confirmedByHuman: ${r.confirmedByHuman})`,
      `- **Occurred**: ${r.occurredAt}`,
      `- **Sensitivity**: \`${r.sensitivity}\``,
    ];
    if (r.externalRef) lines.push(`- **External Ref**: \`${r.externalRef}\``);
    if (r.sourceRef) lines.push(`- **Source Ref**: \`${r.sourceRef}\``);
    if (r.supersedesId) lines.push(`- **Supersedes**: \`${r.supersedesId}\``);
    if (r.supersededById)
      lines.push(`- **Superseded By**: \`${r.supersededById}\``);
    if (res.currentHeadId)
      lines.push(`- **Current Head**: \`${res.currentHeadId}\``);
    if (res.objectIds.length > 0)
      lines.push(`- **Objects**: ${res.objectIds.map((o) => `\`${o}\``).join(", ")}`);
    if (res.resourceTags.length > 0)
      lines.push(`- **Tags**: ${res.resourceTags.map((t) => `\`${t}\``).join(", ")}`);
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
      `- **Occurred**: ${s.occurredAt}`,
      `- **Sensitivity**: \`${s.sensitivity}\``,
    ];
    if (s.sourceRef) lines.push(`- **Source Ref**: \`${s.sourceRef}\``);
    if (res.objectIds.length > 0)
      lines.push(`- **Objects**: ${res.objectIds.map((o) => `\`${o}\``).join(", ")}`);
    if (res.resourceTags.length > 0)
      lines.push(`- **Tags**: ${res.resourceTags.map((t) => `\`${t}\``).join(", ")}`);
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

  // Bucket 2: Conclusions (Pending Questions, Things, Decisions, Realm Card)
  lines.push(
    "",
    `## Conclusions`,
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
      lines.push(
        `- [raw/${m.kind}] \`${m.id}\` (${m.authorId} @ ${m.occurredAt}): ${m.text}`,
      );
    }
  }

  if (brief.middleMind.childSummaries.totalCount > 0) {
    lines.push(
      "",
      `## Child Realms (${brief.middleMind.childSummaries.items.length}/${brief.middleMind.childSummaries.totalCount}, omitted: ${brief.middleMind.childSummaries.omittedCount})`,
    );
    for (const c of brief.middleMind.childSummaries.items) {
      lines.push(
        `- **${c.realmPath}** (${c.realmName}): things=${c.activeThings}, decisions=${c.activeDecisions}, pendingQ=${c.pendingQuestions}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatReplayMarkdown(res: ReplayResult): string {
  const lines: string[] = [
    `# Replay: \`${res.anchorId}\` (${res.anchorOccurredAt}, window: ±${res.window})`,
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
        `- \`${node.id}\` (${node.status}) ${node.title} @ ${node.occurredAt}`,
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
      const headHint =
        item.currentHeadId !== undefined
          ? ` -> head:\`${item.currentHeadId ?? "none"}\``
          : "";
      lines.push(
        `- ${badge} \`${item.id}\` **${item.title}** (${item.status}${headHint}) — ${item.snippet}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatThingsMarkdown(
  items: LedgerRecord[],
  total: number,
): string {
  const lines: string[] = [
    `# Things (${items.length}/${total})`,
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
  }
  return lines.join("\n");
}

export function formatObjectsMarkdown(objects: MindObject[]): string {
  const lines: string[] = [`# Objects (${objects.length})`, ""];
  if (objects.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const o of objects) {
      const parent = o.parentObjectId ? ` parent:\`${o.parentObjectId}\`` : "";
      lines.push(
        `- \`${o.kind}\` **${o.name}** (\`${o.id}\`, realm \`${o.realmId}\`${parent})`,
      );
    }
  }
  return lines.join("\n");
}

export function formatTagsMarkdown(tags: ResourceTagSummary[]): string {
  const lines: string[] = [`# Resource Tags (${tags.length})`, ""];
  if (tags.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const t of tags) {
      lines.push(`- \`${t.tag}\` (${t.count})`);
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
  ];
  if (res.items.length > 0) {
    lines.push("");
    for (const it of res.items) {
      lines.push(
        `- \`${it.action}\` \`${it.sourceRef}\`${it.recordId ? ` -> \`${it.recordId}\`` : ""}${it.supersedesId ? ` (supersedes \`${it.supersedesId}\`)` : ""}`,
      );
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
  ].join("\n");
}

export function formatGenericMarkdown(title: string, data: unknown): string {
  return [`# ${title}`, "", "```json", JSON.stringify(data, null, 2), "```"].join(
    "\n",
  );
}
