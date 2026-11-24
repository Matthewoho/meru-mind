import type {
  MindObject,
  ObjectTreeNode,
  OrgPolicy,
  RealmTreeNode,
  StorageBloatStats,
  TreeResult,
} from "../types.js";

export type DoctorSeverity = "warn" | "info";

export type DoctorFindingCode =
  | "root_direct_bloat"
  | "parent_realm_bloat"
  | "inbox_backlog"
  | "missing_scope"
  | "zero_rules_org"
  | "type_bucket_suspect"
  | "oversized_leaf_realm"
  | "storage_duplicate_body";

export interface DoctorFinding {
  code: DoctorFindingCode;
  severity: DoctorSeverity;
  realmPath: string;
  summary: string;
  metrics: Record<string, number | string>;
  try: string;
}

export interface DoctorReport {
  orgId: string;
  orgName: string;
  orgPolicy: OrgPolicy;
  healthy: boolean;
  summary: {
    visibleActiveRealms: number;
    totalDirectConclusions: number;
    totalDirectRules: number;
    warnCount: number;
    infoCount: number;
  };
  findings: DoctorFinding[];
}

function flattenObjectNodes(
  nodes: ObjectTreeNode[],
  out: MindObject[] = [],
): MindObject[] {
  for (const n of nodes) {
    out.push(n.object);
    if (n.children.length > 0) {
      flattenObjectNodes(n.children, out);
    }
  }
  return out;
}

/**
 * Pure structural realm hygiene diagnostics computed strictly from a visibility-scoped
 * `TreeResult` (`tree --depth all --objects`).
 *
 * Zero extra SQL queries, zero new REST endpoints, and zero risk of cross-realm visibility
 * leaks in `tree` mode.
 */
export function runRealmDoctor(
  tree: TreeResult,
  storageStats?: StorageBloatStats,
): DoctorReport {
  const findings: DoctorFinding[] = [];
  let visibleActiveRealms = 0;
  let totalDirectConclusions = 0;
  let totalDirectRules = 0;

  const visit = (node: RealmTreeNode): void => {
    if (node.effectivelyArchived) return;
    visibleActiveRealms += 1;

    const { realm, counts, children } = node;
    const directConclusions = counts.directConclusions ?? 0;
    const directRules = counts.directRules ?? 0;
    totalDirectConclusions += directConclusions;
    totalDirectRules += directRules;

    const isRoot = realm.path === "/";
    const isInbox = realm.path === "/inbox";

    // 1. Root direct non-rule bloat
    if (isRoot && directConclusions > 20) {
      findings.push({
        code: "root_direct_bloat",
        severity: "warn",
        realmPath: "/",
        summary: `Root "/" holds ${directConclusions} direct non-rule entries. Reserve "/" for org-wide rules and top-level decisions.`,
        metrics: {
          directConclusions,
          directRules,
        },
        try: 'meru-mind ls / --only entries --json | node -e "const d=JSON.parse(require(\'fs\').readFileSync(0,\'utf8\'));for(const i of d.items)console.log(i.id)" | meru-mind entry move --ids-file - --from / --to <target-realm> --dry-run --as-human',
      });
    }

    // 2. Non-leaf parent realm acting as catch-all bucket
    if (!isRoot && !isInbox && children.length > 0 && directConclusions > 50) {
      findings.push({
        code: "parent_realm_bloat",
        severity: "warn",
        realmPath: realm.path,
        summary: `Non-leaf realm "${realm.path}" holds ${directConclusions} direct entries despite having ${children.length} child realm(s). Keep parent realms for subtree-wide rules and decisions.`,
        metrics: {
          directConclusions,
          childRealmsCount: children.length,
        },
        try: `meru-mind ls ${realm.path} --only entries --limit 25`,
      });
    }

    // 3. /inbox triage backlog
    if (isInbox && directConclusions > 10) {
      findings.push({
        code: "inbox_backlog",
        severity: "warn",
        realmPath: "/inbox",
        summary: `Inbox "/inbox" has ${directConclusions} entries waiting for triage.`,
        metrics: {
          directConclusions,
        },
        try: "meru-mind ls /inbox --only entries --limit 25",
      });
    }

    // 4. Missing scope contract
    if (!isInbox && !(realm.scope && realm.scope.trim())) {
      findings.push({
        code: "missing_scope",
        severity: "warn",
        realmPath: realm.path,
        summary: `Realm "${realm.path}" has no scope contract. Add an "Include: ... Exclude: ..." scope so agents can route accurately.`,
        metrics: {
          directConclusions,
        },
        try: `meru-mind realm set ${realm.path} --scope "Include: <what belongs here>. Exclude: <what belongs elsewhere>." --as-human`,
      });
    }

    // 5. Structural type-bucket signal (object-kind homogeneity >= 90% with >= 5 owned objects)
    if (!isRoot && !isInbox) {
      const ownedObjects = flattenObjectNodes(node.objects ?? []);
      if (ownedObjects.length >= 5) {
        const byKind = new Map<string, number>();
        for (const obj of ownedObjects) {
          const k = obj.kind.trim().toLowerCase() || "unknown";
          byKind.set(k, (byKind.get(k) ?? 0) + 1);
        }
        let dominantKind = "";
        let dominantCount = 0;
        for (const [k, cnt] of byKind.entries()) {
          if (cnt > dominantCount) {
            dominantKind = k;
            dominantCount = cnt;
          }
        }
        const share = dominantCount / ownedObjects.length;
        if (share >= 0.9) {
          findings.push({
            code: "type_bucket_suspect",
            severity: "info",
            realmPath: realm.path,
            summary: `Realm "${realm.path}" owns ${ownedObjects.length} objects and ${Math.round(share * 100)}% share kind "${dominantKind}" (${dominantCount}/${ownedObjects.length}) — possible type bucket. Verify it passes the Brief Test, or anchor cross-cutting "${dominantKind}:*" objects on "/" or their owning domain realm.`,
            metrics: {
              ownedObjects: ownedObjects.length,
              dominantKind,
              dominantCount,
              dominantSharePct: Math.round(share * 100),
            },
            try: `meru-mind show ${realm.path}`,
          });
        }
      }
    }

    // 6. Oversized leaf realm
    if (!isRoot && !isInbox && children.length === 0 && directConclusions > 500) {
      findings.push({
        code: "oversized_leaf_realm",
        severity: "info",
        realmPath: realm.path,
        summary: `Leaf realm "${realm.path}" holds ${directConclusions} direct entries; consider splitting if sub-areas have distinct rules, owners, or lifecycles.`,
        metrics: {
          directConclusions,
        },
        try: `meru-mind show ${realm.path}`,
      });
    }

    for (const child of children) {
      visit(child);
    }
  };

  for (const rootNode of tree.realmTree) {
    visit(rootNode);
  }

  // 7. Org-level zero binding rules notice (single concise signal)
  if (totalDirectConclusions >= 20 && totalDirectRules === 0) {
    findings.push({
      code: "zero_rules_org",
      severity: "info",
      realmPath: "/",
      summary: `Visible scope has ${totalDirectConclusions} conclusions but 0 binding rules. Distill recurring constraints into rules so agents inherit them automatically on \`show\`.`,
      metrics: {
        totalDirectConclusions,
        totalDirectRules: 0,
      },
      try: 'meru-mind rule add --in / --title "<binding constraint>" --body "<rationale and rule>" --as-human',
    });
  }

  // 8. Storage duplicate-body guard (local DB diagnostic when storageStats provided)
  if (storageStats && storageStats.vecPendingTextBytes > 1_048_576) {
    const mb = +(storageStats.vecPendingTextBytes / 1_048_576).toFixed(2);
    findings.push({
      code: "storage_duplicate_body",
      severity: "warn",
      realmPath: "/",
      summary: `Secondary queue table "vec_pending" holds ${mb} MB of duplicated body text across ${storageStats.vecPendingCount} rows (canonical records payload is ${(storageStats.recordsPayloadBytes / 1_048_576).toFixed(2)} MB). Upgrade/re-open the database to run migration v11 and reclaim space.`,
      metrics: {
        vecPendingTextBytes: storageStats.vecPendingTextBytes,
        vecPendingCount: storageStats.vecPendingCount,
        recordsPayloadBytes: storageStats.recordsPayloadBytes,
      },
      try: "meru-mind admin rebuild",
    });
  }

  const warnCount = findings.filter((f) => f.severity === "warn").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;

  return {
    orgId: tree.org.id,
    orgName: tree.org.name,
    orgPolicy: tree.org.policy,
    healthy: warnCount === 0,
    summary: {
      visibleActiveRealms,
      totalDirectConclusions,
      totalDirectRules,
      warnCount,
      infoCount,
    },
    findings,
  };
}
