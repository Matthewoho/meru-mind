import { assertAccess, getDescendantIds, resolveAccessScope } from "./policy.js";
import type { MindEngine } from "./index.js";
import { OPAQUE_ENTRY_NOT_FOUND, resolveVisibleRealm } from "./engine/objects.js";
import { assertNoAccidentalSecret } from "./engine/secret-guard.js";
import {
  findRelatedActiveForEcho,
  resolveWriteTargetRealm,
  writeEverydayConclusion,
} from "./engine/surface-write.js";
import { buildWriteRecordPayload } from "./engine/content-hash.js";
import { ChangeWakeBus, MindPump } from "./server/pump.js";
import {
  createAuthToken,
  isPrincipalTokenActive,
  toPublicToken,
} from "./server/tokens.js";
import {
  validateWorkBindingConfig,
  type WorkBindingRecord,
} from "./work/provider.js";
import {
  resolveWorkBindingForRealm,
  WorkProviderRegistry,
  type SafeListReadyResult,
  type SafeResolveResult,
} from "./work/registry.js";
import type {
  MindSurface,
  SurfaceAddRuleInput,
  SurfaceChangesParams,
  SurfaceCreateRealmInput,
  SurfaceUpdateRealmInput,
  SurfaceCreateTokenInput,
  SurfaceCreateTokenResult,
  SurfaceLsParams,
  SurfaceMountRealmInput,
  SurfaceMoveInput,
  SurfaceRawAddInput,
  SurfaceRedactInput,
  SurfaceSearchParams,
  SurfaceShowParams,
  SurfaceTreeParams,
  SurfaceWriteInput,
  SurfaceWriteResult,
} from "./surface.js";
import {
  MindError,
  type AccessScope,
  type AuthTokenPublic,
  type ChangeLogEntry,
  type ChangesResult,
  type LedgerRecord,
  type LsResult,
  type MoveEntriesResult,
  type Organization,
  type Principal,
  type Realm,
  type RealmArchiveResult,
  type RealmMount,
  type RealmUnarchiveResult,
  type RedactResult,
  type SeabedEntry,
  type SearchResult,
  type ShowResult,
  type ShowSupersedeChainResult,
  type TreeResult,
  type WhoamiResult,
} from "./types.js";

export interface LocalMindSurfaceOptions {
  engine: MindEngine;
  principal: Principal;
  /** Optional shared ChangeWakeBus (owned by `meru-mind serve`) */
  wakeBus?: ChangeWakeBus;
  /** Optional WorkProviderRegistry (defaults to official Linear + GitHub static registry) */
  workRegistry?: WorkProviderRegistry;
  /** Optional untrusted workspace hint (.meru-mind-realm); intersected with principal scope */
  defaultWorkspaceHint?: string | null;
  /** Optional store descriptor shown in whoami (defaults to engine.homeDir) */
  storeDescriptor?: { path: string; localOnly: boolean };
  /** Whether close() closes the underlying MindEngine (default: false when engine is shared by server) */
  ownsEngine?: boolean;
}

/**
 * Local in-process implementation of `MindSurface`.
 * Single authoritative policy choke point used by local CLI, stdio MCP, HTTP REST, and Streamable HTTP MCP.
 */
export class LocalMindSurface implements MindSurface {
  readonly mode = "local" as const;
  readonly principal: Principal;

  private readonly engine: MindEngine;
  private readonly wakeBus: ChangeWakeBus;
  private readonly workRegistry: WorkProviderRegistry;
  private readonly ownsWakeBusSubscription: (() => void) | null;
  private readonly ownsEngine: boolean;
  private readonly defaultWorkspaceHint: string | null;
  private readonly storeDescriptor: { path: string; localOnly: boolean };
  private lastReadSeq = 0;

  constructor(options: LocalMindSurfaceOptions) {
    this.engine = options.engine;
    this.principal = options.principal;
    this.workRegistry =
      options.workRegistry ?? WorkProviderRegistry.createDefault();
    this.ownsEngine = options.ownsEngine ?? false;
    this.defaultWorkspaceHint = options.defaultWorkspaceHint ?? null;
    this.storeDescriptor = options.storeDescriptor ?? {
      path: options.engine.homeDir,
      localOnly: true,
    };

    if (options.wakeBus) {
      this.wakeBus = options.wakeBus;
      this.ownsWakeBusSubscription = null;
    } else {
      this.wakeBus = new ChangeWakeBus();
      this.ownsWakeBusSubscription = this.engine.db.onChangeCommitted((events) =>
        this.wakeBus.notifyEvents(events),
      );
    }
  }

  private assertActivePrincipal(): void {
    if (!isPrincipalTokenActive(this.engine.db, this.principal)) {
      throw new MindError("ACCESS_DENIED", "Authentication token has been revoked");
    }
  }

  /**
   * Enforces Fable's v0.4 weakened browser Cookie boundary right at the surface choke point:
   * Cookie sessions may ONLY read and run reversible operations (inbox triage / write / pulse).
   * Irreversible or scope-widening mutations strictly return 403 (`ACCESS_DENIED`) with a copyable CLI command.
   */
  private assertNotWeakenedCookie(actionName: string, cliCommand: string): void {
    if (this.principal.authKind === "cookie") {
      throw new MindError(
        "ACCESS_DENIED",
        `"${actionName}" is not allowed from a browser Cookie session (read + reversible actions only). Run this operation with a CLI Bearer token instead.`,
        {
          reason: "cookie_session_restricted",
          try: cliCommand,
        },
      );
    }
  }

  private assertHuman(actionName: string, cliCommand: string): void {
    this.assertActivePrincipal();
    if (this.principal.actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can ${actionName} (actor "${this.principal.actor.id}" is "${this.principal.actor.kind}").`,
        { try: cliCommand },
      );
    }
  }

  private resolveScopeContext(includeDescendantSeabed = false): {
    org: Organization;
    realms: Realm[];
    mounts: RealmMount[];
    scope: AccessScope;
  } {
    this.assertActivePrincipal();
    const org = this.engine.db.getOrg(this.principal.orgId);
    if (!org) {
      throw new MindError(
        "NOT_FOUND",
        `Organization not found: ${this.principal.orgId}`,
      );
    }
    const realms = this.engine.db.listRealms();
    const mounts = this.engine.db.listMounts();
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: this.principal.boundRealmId,
      orgPolicy: org.policy,
      includeDescendantSeabed,
    });
    return { org, realms, mounts, scope };
  }

  private updateLastReadSeq(scope: AccessScope): void {
    const seq = this.engine.db.getLatestVisibleChangeLogSeq({
      orgId: this.principal.orgId,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeSecret: false,
    });
    if (seq > this.lastReadSeq) {
      this.lastReadSeq = seq;
    }
  }

  async whoami(): Promise<WhoamiResult> {
    const ctx = this.resolveScopeContext(false);
    const res = this.engine.sea.whoami({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      boundSource: this.principal.boundSource,
      storePath: this.storeDescriptor.path,
      scopeCeiling: ctx.scope,
    });
    if (res.latestSeq > this.lastReadSeq) {
      this.lastReadSeq = res.latestSeq;
    }
    return {
      ...res,
      store: {
        path: this.storeDescriptor.path,
        localOnly: this.storeDescriptor.localOnly,
      },
      write: {
        ...res.write,
        canWriteRules:
          this.principal.actor.kind === "human" &&
          this.principal.authKind !== "cookie",
        canRedact:
          this.principal.actor.kind === "human" &&
          this.principal.authKind !== "cookie",
      },
    };
  }

  async tree(params?: SurfaceTreeParams): Promise<TreeResult> {
    const ctx = this.resolveScopeContext(false);
    const res = this.engine.sea.tree({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      target: params?.ref,
      depth: params?.depth,
      includeObjects: params?.includeObjects,
      limit: params?.limit,
      scopeCeiling: ctx.scope,
    });
    this.updateLastReadSeq(ctx.scope);
    return res;
  }

  async ls(params?: SurfaceLsParams): Promise<LsResult> {
    const includeDescendantSeabed = Boolean(params?.includeDescendantSeabed);
    const ctx = this.resolveScopeContext(includeDescendantSeabed);
    const res = await this.engine.sea.ls({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      ref: params?.ref,
      only: params?.only,
      kind: params?.kind,
      about: params?.about,
      since: params?.since,
      until: params?.until,
      history: params?.history,
      includeDescendantSeabed,
      limit: params?.limit,
      cursor: params?.cursor,
      scopeCeiling: ctx.scope,
    });
    this.updateLastReadSeq(ctx.scope);
    return res;
  }

  async show(params: SurfaceShowParams): Promise<ShowResult> {
    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);
    const ctx = this.resolveScopeContext(includeDescendantSeabed);
    const res = await this.engine.sea.show({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      ref: params.ref,
      around: params.around,
      cursor: params.cursor,
      chars: params.chars,
      full: params.full,
      history: params.history,
      context: params.context,
      includeDescendantSeabed,
      scopeCeiling: ctx.scope,
    });
    this.updateLastReadSeq(ctx.scope);
    return res;
  }

  async search(params: SurfaceSearchParams): Promise<SearchResult> {
    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);
    const ctx = this.resolveScopeContext(includeDescendantSeabed);
    const res = await this.engine.sea.search({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      query: params.query,
      in: params.in,
      about: params.about,
      kind: params.kind,
      since: params.since,
      until: params.until,
      history: params.history,
      includeDescendantSeabed,
      limit: params.limit,
      cursor: params.cursor,
      scopeCeiling: ctx.scope,
    });
    this.updateLastReadSeq(ctx.scope);
    return res;
  }

  async changes(params?: SurfaceChangesParams): Promise<ChangesResult> {
    this.assertActivePrincipal();
    const pump = new MindPump(this.engine.db, this.wakeBus, this.principal);
    const pollRes = await pump.poll({
      sinceSeq: params?.sinceSeq ?? 0,
      generation: params?.generation,
      limit: params?.limit ?? 50,
      realmRef: params?.in,
      includeDescendantSeabed: params?.includeDescendantSeabed,
      waitSeconds: params?.waitSeconds ?? 0,
      signal: params?.signal,
    });
    if (pollRes.latestSeq > this.lastReadSeq) {
      this.lastReadSeq = pollRes.latestSeq;
    }
    const entries: ChangeLogEntry[] = pollRes.frames.map((f) => ({
      seq: f.seq,
      generation: f.generation,
      orgId: this.principal.orgId,
      realmId: f.realmId,
      entityType: f.entityType,
      entityId: f.entityId,
      op: f.op,
      assetClass: f.assetClass,
      actorId: f.actorId,
      createdAt: f.createdAt,
    }));
    return {
      generation: pollRes.generation,
      sinceSeq: pollRes.sinceSeq,
      latestSeq: pollRes.latestSeq,
      topologyVersion: pollRes.topologyVersion,
      ...(pollRes.resetRequired ? { resetRequired: true } : {}),
      entries,
    };
  }

  async write(params: SurfaceWriteInput): Promise<SurfaceWriteResult> {
    const ctx = this.resolveScopeContext(false);
    const isExplicitlyBound =
      ctx.org.policy === "tree" ||
      (this.principal.boundSource !== "open-default:/" &&
        this.principal.boundSource !== "token-root:/");

    // Workspace marker hint is strictly untrusted: resolveWriteTargetRealm only accepts it in open mode
    // and we intersect against principal scope so it can never escape a tree boundary.
    const rawHint =
      params.workspaceHint !== undefined
        ? params.workspaceHint
        : this.defaultWorkspaceHint;
    let validatedHint: string | null = null;
    if (rawHint && rawHint.trim()) {
      try {
        const candidate = resolveVisibleRealm({
          realms: ctx.realms,
          orgId: ctx.org.id,
          ref: rawHint.trim(),
          scope: ctx.scope,
        });
        validatedHint = candidate.path;
      } catch {
        // Untrusted workspace hint outside visible scope is ignored (or rejected if tree mode)
        validatedHint = null;
      }
    }

    const routed = resolveWriteTargetRealm({
      db: this.engine.db,
      ledger: this.engine.ledger,
      realms: ctx.realms,
      mounts: ctx.mounts,
      scope: ctx.scope,
      orgId: ctx.org.id,
      orgPolicy: ctx.org.policy,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      isExplicitlyBound,
      explicitIn: params.in,
      workspaceMarkerRef: validatedHint,
      about: params.about,
    });

    const refreshedScope =
      routed.realms !== ctx.realms
        ? resolveAccessScope({
            realms: routed.realms,
            mounts: ctx.mounts,
            viewerRealmId: this.principal.boundRealmId,
            orgPolicy: ctx.org.policy,
            includeDescendantSeabed: false,
          })
        : ctx.scope;

    assertAccess({
      realms: routed.realms,
      mounts: ctx.mounts,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId: routed.realm.id,
      assetKind: "ledger",
      required: "write",
      orgPolicy: ctx.org.policy,
    });

    // Collision hints (v0.3 + v0.5.4): look back to the EARLIER of `baselineSeq` or 10 minutes ago
    // so stateless `/mcp` calls (baselineSeq=0) and one-shot CLI calls (fresh whoami cursor)
    // both receive recent same-realm peer activity without requiring stateful server sessions.
    const COLLISION_LOOKBACK_MS = 10 * 60_000;
    const baselineSeq =
      params.lastReadSeq !== undefined ? params.lastReadSeq : this.lastReadSeq;
    const lookbackIso = new Date(Date.now() - COLLISION_LOOKBACK_MS).toISOString();
    const recent = this.engine.db.listChangeLog({
      orgId: ctx.org.id,
      realmIds: [routed.realm.id],
      ...(baselineSeq > 0
        ? { sinceSeq: baselineSeq, sinceCreatedAt: lookbackIso, combineSinceWithOr: true }
        : { sinceCreatedAt: lookbackIso }),
      order: "desc",
      limit: 30,
      includeSecret: false,
    });
    const collisionHints: ChangeLogEntry[] = recent.entries
      .filter((e) => e.actorId !== this.principal.actor.id)
      .slice(0, 10)
      .reverse();

    const record = await writeEverydayConclusion({
      db: this.engine.db,
      ledger: this.engine.ledger,
      realms: routed.realms,
      mounts: ctx.mounts,
      scope: refreshedScope,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId: routed.realm.id,
      title: params.title,
      body: params.body,
      kind: params.kind,
      extKind: params.extKind,
      about: params.about,
      supersedes: params.supersedes,
      because: params.because,
      occurredAt: params.occurredAt,
      sensitivity: params.sensitivity,
      explicitIdempotencyKey: params.idempotencyKey,
    });

    const relatedActive = await findRelatedActiveForEcho({
      sea: this.engine.sea,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      newRecord: record,
      scopeCeiling: refreshedScope,
    });

    const seqAfter = this.engine.db.getLatestVisibleChangeLogSeq({
      orgId: ctx.org.id,
      ledgerRealmIds: refreshedScope.readableLedgerIds,
      seabedRealmIds: refreshedScope.readableSeabedIds,
      includeSecret: false,
    });
    if (seqAfter > this.lastReadSeq) {
      this.lastReadSeq = seqAfter;
    }

    return {
      record,
      routedBy: routed.routedBy,
      ...(relatedActive.length > 0 ? { relatedActive } : {}),
      ...(collisionHints.length > 0 ? { collisionHints } : {}),
    };
  }

  async rawAdd(params: SurfaceRawAddInput): Promise<SeabedEntry> {
    const ctx = this.resolveScopeContext(false);
    const text = params.text.trim();
    if (!text) {
      throw new MindError("INVALID_INPUT", "Raw seabed text cannot be empty");
    }
    assertNoAccidentalSecret({
      texts: [text],
      sensitivity: params.sensitivity ?? "internal",
      surfaceHint:
        'Remove the credential value or re-run with --sensitivity secret',
    });

    const isExplicitlyBound =
      ctx.org.policy === "tree" ||
      (this.principal.boundSource !== "open-default:/" &&
        this.principal.boundSource !== "token-root:/");
    const routed = resolveWriteTargetRealm({
      db: this.engine.db,
      ledger: this.engine.ledger,
      realms: ctx.realms,
      mounts: ctx.mounts,
      scope: ctx.scope,
      orgId: ctx.org.id,
      orgPolicy: ctx.org.policy,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      isExplicitlyBound,
      explicitIn: params.in,
      workspaceMarkerRef: params.workspaceHint ?? this.defaultWorkspaceHint,
    });

    return this.engine.ledger.captureSeabed({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId: routed.realm.id,
      kind: params.kind ?? "message",
      text,
      topicId: params.topicId,
      sourceRef: params.sourceRef,
      occurredAt: params.occurredAt,
      sensitivity: params.sensitivity,
      idempotencyKey: params.idempotencyKey,
    });
  }

  private getBoundSubtreeRealmIds(realms: Realm[]): Set<string> {
    return new Set<string>([
      this.principal.boundRealmId,
      ...getDescendantIds(realms, this.principal.boundRealmId),
    ]);
  }

  private assertWithinBoundSubtree(
    realms: Realm[],
    targetRealm: Realm,
    action: string,
  ): void {
    const allowed = this.getBoundSubtreeRealmIds(realms);
    if (!allowed.has(targetRealm.id)) {
      throw new MindError(
        "ACCESS_DENIED",
        `Cannot ${action} "${targetRealm.path}": realm is outside your bound subtree.`,
      );
    }
  }

  async move(params: SurfaceMoveInput): Promise<MoveEntriesResult> {
    // Reversible governance verb: allowed for human actors via local, Bearer, AND browser Cookie!
    this.assertHuman(
      "move entries between realms",
      `meru-mind entry move ${params.entryIds.join(" ")} --to ${params.targetRealmRef} --as-human`,
    );
    const ctx = this.resolveScopeContext(false);
    const targetRealm = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.targetRealmRef,
      scope: ctx.scope,
    });
    if (ctx.org.policy === "tree") {
      this.assertWithinBoundSubtree(ctx.realms, targetRealm, "move entries into");
    }

    const readableLedgerSet = new Set(ctx.scope.readableLedgerIds);
    const readableSeabedSet = new Set(ctx.scope.readableSeabedIds);
    const writableSourceRealmIds =
      ctx.org.policy === "tree"
        ? this.getBoundSubtreeRealmIds(ctx.realms)
        : undefined;

    if (params.expectedFromRealmRef) {
      const expectedFrom = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: params.expectedFromRealmRef,
        scope: ctx.scope,
      });
      for (const id of params.entryIds) {
        const rec = this.engine.db.getRecord(id);
        const sea = rec ? null : this.engine.db.getSeabedEntry(id);
        const entryOrgId = rec?.orgId ?? sea?.orgId ?? null;
        const curRealmId = rec?.realmId ?? sea?.realmId ?? null;
        const isReadable = rec
          ? readableLedgerSet.has(rec.realmId)
          : sea
            ? readableSeabedSet.has(sea.realmId)
            : false;
        if (!curRealmId || entryOrgId !== ctx.org.id || !isReadable) {
          throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
        }
        // Idempotent success if already moved to targetRealm; CAS conflict if moved elsewhere (within readable scope only)
        if (curRealmId !== expectedFrom.id && curRealmId !== targetRealm.id) {
          throw new MindError(
            "CONFLICT",
            `Entry "${id}" has already been moved out of "${expectedFrom.path}" by another actor.`,
            {
              reason: "cas_realm_mismatch",
              entryId: id,
              expectedRealmId: expectedFrom.id,
              actualRealmId: curRealmId,
            },
          );
        }
      }
    }

    return this.engine.ledger.moveEntries({
      actor: this.principal.actor,
      orgId: ctx.org.id,
      entryIds: params.entryIds,
      targetRealmId: targetRealm.id,
      dryRun: params.dryRun,
      allowedSourceLedgerIds: readableLedgerSet,
      allowedSourceSeabedIds: readableSeabedSet,
      writableSourceRealmIds,
    });
  }

  async getEntryChain(entryId: string): Promise<ShowSupersedeChainResult> {
    const ctx = this.resolveScopeContext(false);
    const chain = this.engine.ledger.getSupersedeChain({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      recordId: entryId,
      scopeCeiling: ctx.scope,
    });
    return {
      nodes: chain.nodes.map((r) => ({
        id: r.id,
        realmId: r.realmId,
        kind: r.kind,
        status: r.status,
        title: r.title,
        occurredAt: r.occurredAt,
        createdAt: r.createdAt,
        authorId: r.authorId,
        authorKind: r.authorKind,
        sensitivity: r.sensitivity,
        supersedesId: r.supersedesId,
        supersedesIds: r.supersedesIds,
        supersededById: r.supersededById,
      })),
      currentHeadId: chain.currentHeadId,
      orphanSuperseded: chain.orphanSuperseded,
    };
  }

  async addRule(params: SurfaceAddRuleInput): Promise<LedgerRecord> {
    const cliCmd = `meru-mind rule add --in ${params.in} --title ${JSON.stringify(params.title)} --body ${JSON.stringify(params.body)} --as-human`;
    this.assertNotWeakenedCookie("rule add", cliCmd);
    this.assertHuman("add rules", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const targetRealm = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.in,
      scope: ctx.scope,
    });
    assertNoAccidentalSecret({
      texts: [params.title, params.body],
      sensitivity: "internal",
      surfaceHint: "Remove plaintext credentials before adding a rule.",
    });
    return this.engine.ledger.appendRecord({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId: targetRealm.id,
      kind: "rule",
      title: params.title.trim(),
      payload: buildWriteRecordPayload(params.body.trim()),
      refs: params.because,
      supersedesIds: params.supersedes,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async redact(params: SurfaceRedactInput): Promise<RedactResult> {
    const cliCmd = `meru-mind redact ${params.entryId}${params.reason ? ` --reason ${JSON.stringify(params.reason)}` : ""} --as-human`;
    this.assertNotWeakenedCookie("redact", cliCmd);
    this.assertHuman("redact entries", cliCmd);
    return this.engine.ledger.redact({
      actor: this.principal.actor,
      entryId: params.entryId,
      reason: params.reason,
      viewerRealmId: this.principal.boundRealmId,
    });
  }

  async createRealm(params: SurfaceCreateRealmInput): Promise<Realm> {
    const cliCmd = `meru-mind realm create --parent ${params.parentRef} --slug ${params.slug} --name ${JSON.stringify(params.name)} --scope "<scope>" --as-human`;
    this.assertNotWeakenedCookie("realm create", cliCmd);
    this.assertHuman("create realms", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const parent = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.parentRef,
      scope: ctx.scope,
    });
    this.assertWithinBoundSubtree(ctx.realms, parent, "create child realm under");
    return this.engine.ledger.createRealm({
      orgId: ctx.org.id,
      parentId: parent.id,
      slug: params.slug,
      name: params.name,
      scope: params.scope,
      actor: this.principal.actor,
    });
  }

  async updateRealm(params: SurfaceUpdateRealmInput): Promise<Realm> {
    const cliCmd = `meru-mind realm set ${params.ref}${params.scope !== undefined ? ` --scope ${JSON.stringify(params.scope)}` : ""}${params.name !== undefined ? ` --name ${JSON.stringify(params.name)}` : ""} --as-human`;
    this.assertNotWeakenedCookie("realm set", cliCmd);
    this.assertHuman("update realm metadata", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const target = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.ref,
      scope: ctx.scope,
    });
    this.assertWithinBoundSubtree(ctx.realms, target, "update realm");
    return this.engine.ledger.updateRealm({
      actor: this.principal.actor,
      orgId: ctx.org.id,
      realmId: target.id,
      name: params.name,
      scope: params.scope,
    });
  }

  async mountRealm(params: SurfaceMountRealmInput): Promise<RealmMount> {
    const cliCmd = `meru-mind realm mount --viewer ${params.viewerRef} --target ${params.targetRef}${params.scope ? ` --scope ${params.scope}` : ""} --as-human`;
    this.assertNotWeakenedCookie("realm mount", cliCmd);
    this.assertHuman("mount realms", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const viewer = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.viewerRef,
      scope: ctx.scope,
    });
    const target = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.targetRef,
      scope: ctx.scope,
    });
    return this.engine.ledger.mountRealm({
      actor: this.principal.actor,
      viewerRealmId: viewer.id,
      targetRealmId: target.id,
      scope: params.scope,
    });
  }

  async unmountRealm(params: {
    viewerRef: string;
    targetRef: string;
  }): Promise<boolean> {
    const cliCmd = `meru-mind realm unmount --viewer ${params.viewerRef} --target ${params.targetRef} --as-human`;
    this.assertNotWeakenedCookie("realm unmount", cliCmd);
    this.assertHuman("unmount realms", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const viewer = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.viewerRef,
      scope: ctx.scope,
    });
    const target = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.targetRef,
      scope: ctx.scope,
    });
    return this.engine.ledger.unmountRealm({
      actor: this.principal.actor,
      viewerRealmId: viewer.id,
      targetRealmId: target.id,
    });
  }

  async archiveRealm(params: { ref: string }): Promise<RealmArchiveResult> {
    const cliCmd = `meru-mind realm archive ${params.ref} --as-human`;
    this.assertNotWeakenedCookie("realm archive", cliCmd);
    this.assertHuman("archive realms", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const target = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.ref,
      scope: ctx.scope,
    });
    this.assertWithinBoundSubtree(ctx.realms, target, "archive realm");
    return this.engine.ledger.archiveRealm({
      actor: this.principal.actor,
      orgId: ctx.org.id,
      realmId: target.id,
    });
  }

  async unarchiveRealm(params: { ref: string }): Promise<RealmUnarchiveResult> {
    const cliCmd = `meru-mind realm unarchive ${params.ref} --as-human`;
    this.assertNotWeakenedCookie("realm unarchive", cliCmd);
    this.assertHuman("unarchive realms", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const target = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.ref,
      scope: ctx.scope,
    });
    this.assertWithinBoundSubtree(ctx.realms, target, "unarchive realm");
    return this.engine.ledger.unarchiveRealm({
      actor: this.principal.actor,
      orgId: ctx.org.id,
      realmId: target.id,
    });
  }

  async setOrgPolicy(params: { policy: "open" | "tree" }): Promise<Organization> {
    const cliCmd = `meru-mind org set-policy --policy ${params.policy} --as-human`;
    this.assertNotWeakenedCookie("org set-policy", cliCmd);
    this.assertHuman("change organization policy", cliCmd);
    return this.engine.ledger.setOrgPolicy({
      orgId: this.principal.orgId,
      policy: params.policy,
      actor: this.principal.actor,
    });
  }

  private assertOrgRootHuman(action: string, cliCmd: string): void {
    this.assertNotWeakenedCookie(action, cliCmd);
    this.assertHuman(action, cliCmd);
    // R2-P1-2: Fail closed if root realm "/" is missing
    const root = this.engine.db.getRealmByPath(this.principal.orgId, "/");
    if (!root || this.principal.boundRealmId !== root.id) {
      throw new MindError(
        "ACCESS_DENIED",
        `Realm-scoped principals cannot ${action}; an organization root-realm human admin token is required.`,
        { try: cliCmd },
      );
    }
    if (this.principal.authKind !== "local") {
      const actorRec = this.engine.db.getActor(
        this.principal.orgId,
        this.principal.actor.id,
      );
      if (!actorRec || actorRec.role !== "admin") {
        throw new MindError(
          "ACCESS_DENIED",
          `Organization admin role is required to ${action} (actor "${this.principal.actor.id}" has role "${actorRec?.role ?? "member"}").`,
          { try: cliCmd },
        );
      }
    }
  }

  async createToken(
    params: SurfaceCreateTokenInput,
  ): Promise<SurfaceCreateTokenResult> {
    const cliCmd = `meru-mind token create --actor-id ${params.actorId} --kind ${params.actorKind}${params.boundRealmRef ? ` --in ${params.boundRealmRef}` : ""}`;
    this.assertOrgRootHuman("create authentication tokens", cliCmd);
    return createAuthToken({
      db: this.engine.db,
      orgId: this.principal.orgId,
      actorId: params.actorId,
      actorKind: params.actorKind,
      actorFamily: params.actorFamily,
      actorRole: params.actorRole,
      boundRealmId: params.boundRealmRef,
      label: params.label,
      createdBy: this.principal.actor.id,
    });
  }

  async listTokens(params?: {
    includeRevoked?: boolean;
  }): Promise<AuthTokenPublic[]> {
    const cliCmd = "meru-mind token list";
    this.assertOrgRootHuman("list authentication tokens", cliCmd);
    return this.engine.db
      .listTokens(this.principal.orgId, Boolean(params?.includeRevoked))
      .map(toPublicToken);
  }

  async revokeToken(params: { tokenId: string }): Promise<boolean> {
    const cliCmd = `meru-mind token revoke ${params.tokenId}`;
    this.assertOrgRootHuman("revoke authentication tokens", cliCmd);
    return this.engine.db.revokeToken(
      this.principal.orgId,
      params.tokenId,
      new Date().toISOString(),
    );
  }

  async bindWork(params: {
    realmRef: string;
    provider: string;
    config: Record<string, unknown>;
  }): Promise<WorkBindingRecord> {
    const cliCmd = `meru-mind work bind --in ${params.realmRef} --provider ${params.provider} --config-json '${JSON.stringify(params.config)}' --as-human`;
    this.assertNotWeakenedCookie("work bind", cliCmd);
    this.assertHuman("bind external work providers", cliCmd);
    validateWorkBindingConfig(params.config);
    if (!this.workRegistry.get(params.provider)) {
      throw new MindError(
        "INVALID_INPUT",
        `Unknown work provider "${params.provider}". Registered official providers: ${this.workRegistry.listIds().join(", ")}`,
      );
    }
    const ctx = this.resolveScopeContext(false);
    const target = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.realmRef,
      scope: ctx.scope,
    });
    const now = new Date().toISOString();
    const existing = this.engine.db.getWorkBinding(ctx.org.id, target.id);
    const binding: WorkBindingRecord = {
      orgId: ctx.org.id,
      realmId: target.id,
      provider: params.provider,
      config: params.config,
      createdBy: existing?.createdBy ?? this.principal.actor.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.engine.db.upsertWorkBinding(binding);
    return binding;
  }

  async unbindWork(params: { realmRef: string }): Promise<boolean> {
    const cliCmd = `meru-mind work unbind --in ${params.realmRef} --as-human`;
    this.assertNotWeakenedCookie("work unbind", cliCmd);
    this.assertHuman("unbind external work providers", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const target = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.realmRef,
      scope: ctx.scope,
    });
    return this.engine.db.deleteWorkBinding(ctx.org.id, target.id);
  }

  async listWorkBindings(): Promise<WorkBindingRecord[]> {
    const ctx = this.resolveScopeContext(false);
    const visible = new Set(ctx.scope.readableLedgerIds);
    return this.engine.db
      .listWorkBindings(ctx.org.id)
      .filter((b) => visible.has(b.realmId));
  }

  async resolveWork(params: {
    realmRef?: string;
    items: string[];
  }): Promise<SafeResolveResult> {
    const ctx = this.resolveScopeContext(false);
    const targetRealm = params.realmRef
      ? resolveVisibleRealm({
          realms: ctx.realms,
          orgId: ctx.org.id,
          ref: params.realmRef,
          scope: ctx.scope,
        })
      : ctx.realms.find((r) => r.id === this.principal.boundRealmId)!;
    const binding = resolveWorkBindingForRealm({
      db: this.engine.db,
      realms: ctx.realms,
      orgId: ctx.org.id,
      realmId: targetRealm.id,
    });
    if (!binding) {
      return {
        unavailable: true,
        provider: "none",
        reason: `status unavailable: no work provider bound to "${targetRealm.path}" or its ancestors`,
      };
    }
    const parsedItems = params.items.map((raw) => {
      const loc = this.workRegistry.parseLocator(raw, binding.provider);
      return loc ?? (raw as `work:${string}:${string}`);
    });
    return this.workRegistry.resolveSafe({
      binding,
      items: parsedItems,
      principalId: this.principal.actor.id,
      realmId: targetRealm.id,
    });
  }

  async listReadyWork(params?: {
    realmRef?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SafeListReadyResult> {
    const ctx = this.resolveScopeContext(false);
    const targetRealm = params?.realmRef
      ? resolveVisibleRealm({
          realms: ctx.realms,
          orgId: ctx.org.id,
          ref: params.realmRef,
          scope: ctx.scope,
        })
      : ctx.realms.find((r) => r.id === this.principal.boundRealmId)!;
    const binding = resolveWorkBindingForRealm({
      db: this.engine.db,
      realms: ctx.realms,
      orgId: ctx.org.id,
      realmId: targetRealm.id,
    });
    if (!binding) {
      return {
        unavailable: true,
        provider: "none",
        reason: `status unavailable: no work provider bound to "${targetRealm.path}" or its ancestors`,
      };
    }
    return this.workRegistry.listReadySafe({
      binding,
      limit: params?.limit,
      cursor: params?.cursor,
      principalId: this.principal.actor.id,
      realmId: targetRealm.id,
    });
  }

  async close(): Promise<void> {
    if (this.ownsWakeBusSubscription) {
      this.ownsWakeBusSubscription();
    }
    if (this.ownsEngine) {
      await this.engine.close();
    }
  }
}
