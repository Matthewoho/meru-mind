import {
  assertWriteAccess,
  getDescendantIds,
  normalizeWriteScope,
  resolveAccessScope,
} from "./policy.js";
import type { MindEngine } from "./index.js";
import {
  OPAQUE_ENTRY_NOT_FOUND,
  OPAQUE_OBJECT_NOT_FOUND,
  resolveVisibleRealm,
} from "./engine/objects.js";
import {
  parseRefSyntax,
  resolveAboutRefsForWrite,
  resolveUnifiedObjectRead,
} from "./engine/refs.js";
import {
  createVisibilityHelpers,
  filterVisibleChangeFrames,
} from "./engine/visibility.js";
import { assertNoAccidentalSecret } from "./engine/secret-guard.js";
import {
  findBoundRulesForEcho,
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
  SurfaceCreateObjectInput,
  SurfaceCreateRealmInput,
  SurfaceUpdateRealmInput,
  SurfaceCreateTokenInput,
  SurfaceCreateTokenResult,
  SurfaceDeleteObjectInput,
  SurfaceLinkObjectInput,
  SurfaceLsParams,
  SurfaceMountRealmInput,
  SurfaceMoveInput,
  SurfaceMoveObjectInput,
  SurfaceRawAddInput,
  SurfaceRedactInput,
  SurfaceSearchParams,
  SurfaceSetObjectStateInput,
  SurfaceSettleInput,
  SurfaceShowParams,
  SurfaceTreeParams,
  SurfaceUnlinkObjectInput,
  SurfaceUpdateObjectAliasesInput,
  SurfaceWriteInput,
  SurfaceWriteResult,
} from "./surface.js";
import {
  MindError,
  type AccessScope,
  type AuthTokenPublic,
  type ChangeLogEntry,
  type ChangesResult,
  type CreateObjectResult,
  type Distillation,
  type EntryObjectLink,
  type ImportBatchInput,
  type ImportBatchResult,
  type LedgerRecord,
  type LsResult,
  type MindObject,
  type MoveEntriesResult,
  type ObjectAliasUpdateResult,
  type ObjectStateSetResult,
  type Organization,
  type Principal,
  type Realm,
  type RealmArchiveResult,
  type RealmMount,
  type RealmUnarchiveResult,
  type RedactResult,
  type SeabedEntry,
  type SearchResult,
  type Sensitivity,
  type ShowResult,
  type ShowSupersedeChainResult,
  type TokenWriteScope,
  type TreeResult,
  type VerifyImportInput,
  type VerifyImportResult,
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

  private effectiveWriteScope(): TokenWriteScope {
    if (this.principal.authKind === "cookie") {
      return "self";
    }
    return normalizeWriteScope(this.principal.writeScope);
  }

  private isOrgRootPrincipal(realms: Realm[]): boolean {
    const root = realms.find(
      (r) =>
        r.orgId === this.principal.orgId &&
        r.parentId === null &&
        r.path === "/",
    );
    return Boolean(root && this.principal.boundRealmId === root.id);
  }

  private resolveObjectIdForSurface(
    rawRef: string,
    ctx: { org: Organization; realms: Realm[]; mounts: RealmMount[]; scope: AccessScope },
  ): string {
    const parsed = parseRefSyntax(rawRef);
    if (parsed.kind !== "object") {
      throw new MindError(
        "INVALID_REF",
        `Expected object reference (<kind>:<name>, /<realm>/<kind>:<name>, or obj_...), got "${rawRef}"`,
        { try: "meru-mind ls --only objects" },
      );
    }
    const vis = createVisibilityHelpers({
      db: this.engine.db,
      realms: ctx.realms,
      mounts: ctx.mounts,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      scope: ctx.scope,
    });
    const resolved = resolveUnifiedObjectRead({
      db: this.engine.db,
      realms: ctx.realms,
      orgId: ctx.org.id,
      parsed,
      scope: ctx.scope,
      vis,
      verb: "show",
    });
    if (!resolved.object) {
      throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND, {
        try: `meru-mind object create --kind ${resolved.objectKind} --name ${resolved.objectName}`,
      });
    }
    return resolved.object.id;
  }

  async whoami(): Promise<WhoamiResult> {
    const ctx = this.resolveScopeContext(false);
    const res = this.engine.sea.whoami({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      boundSource: this.principal.boundSource,
      writeScope: this.effectiveWriteScope(),
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
      with: params.with,
      around: params.around,
      cursor: params.cursor,
      chars: params.chars,
      full: params.full,
      history: params.history,
      context: params.context,
      includeDescendantSeabed,
      includeStaleNarrative: params.includeStaleNarrative,
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
      about: params?.about,
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

    const writeScope = this.effectiveWriteScope();
    assertWriteAccess({
      realms: routed.realms,
      mounts: ctx.mounts,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId: routed.realm.id,
      assetKind: "ledger",
      orgPolicy: ctx.org.policy,
      writeScope,
      category: "content",
    });

    // Collision hints (v0.3 + v0.5.4 + v0.7.0 L2): look back to the EARLIER of `baselineSeq` or 10 minutes ago
    // and route EVERY candidate frame through the single shared `filterVisibleChangeFrames` boundary
    // so secret entry_object/resource_tag frames, non-readable object refs, descendant seabed frames
    // without dive, and L5-filtered distillations can NEVER leak into `write` responses.
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
      limit: 80,
      includeSecret: false,
    });
    const peerRawFrames = recent.entries.filter(
      (e) => e.actorId !== this.principal.actor.id,
    );
    const collisionVis = createVisibilityHelpers({
      db: this.engine.db,
      realms: routed.realms,
      mounts: ctx.mounts,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      scope: refreshedScope,
    });
    const collisionHints: ChangeLogEntry[] = filterVisibleChangeFrames({
      db: this.engine.db,
      frames: peerRawFrames,
      vis: collisionVis,
      scope: refreshedScope,
      ledgerRealmIds: refreshedScope.readableLedgerIds.includes(routed.realm.id)
        ? [routed.realm.id]
        : [],
      seabedRealmIds: refreshedScope.readableSeabedIds.includes(routed.realm.id)
        ? [routed.realm.id]
        : [],
      driveRealmIds: refreshedScope.readableDriveIds.includes(routed.realm.id)
        ? [routed.realm.id]
        : [],
      includeOrgLevel: false,
      includeSecret: false,
      limit: 10,
    }).reverse();

    const record = await writeEverydayConclusion({
      db: this.engine.db,
      ledger: this.engine.ledger,
      realms: routed.realms,
      mounts: ctx.mounts,
      scope: refreshedScope,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId: routed.realm.id,
      writeScope,
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

    const boundRules = findBoundRulesForEcho({
      db: this.engine.db,
      realms: routed.realms,
      mounts: ctx.mounts,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      scope: refreshedScope,
      newRecord: record,
      about: params.about,
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
      ...(boundRules.length > 0 ? { boundRules } : {}),
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
      writeScope: this.effectiveWriteScope(),
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

  async settle(params: SurfaceSettleInput): Promise<Distillation> {
    const aboutPart = params.about ? ` --about ${params.about}` : "";
    const inPart = params.in ? ` --in ${params.in}` : "";
    const periodPart = params.periodKey ? ` --period ${params.periodKey}` : "";
    const cliCmd = `meru-mind settle --layer ${params.layer}${inPart}${aboutPart}${periodPart}`;
    this.assertNotWeakenedCookie("settle", cliCmd);
    const ctx = this.resolveScopeContext(false);
    let targetRealmId: string | undefined;
    if (params.in?.trim()) {
      const targetRealm = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: params.in.trim(),
        scope: ctx.scope,
      });
      targetRealmId = targetRealm.id;
    }
    return this.engine.sea.settle({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId,
      about: params.about,
      layer: params.layer,
      periodKey: params.periodKey,
      narrativeMd: params.narrativeMd,
      sourceIds: params.sourceIds,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
    });
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
    const aboutList = (params.about ?? []).map((a) => a.trim()).filter(Boolean);
    const aboutHint =
      aboutList.length > 0
        ? ` ${aboutList.map((a) => `--about ${a}`).join(" ")}`
        : "";
    const cliCmd = `meru-mind rule add --in ${params.in} --title ${JSON.stringify(params.title)} --body ${JSON.stringify(params.body)}${aboutHint} --as-human`;
    this.assertNotWeakenedCookie("rule add", cliCmd);
    this.assertHuman("add rules", cliCmd);
    const ctx = this.resolveScopeContext(false);
    const targetRealm = resolveVisibleRealm({
      realms: ctx.realms,
      orgId: ctx.org.id,
      ref: params.in,
      scope: ctx.scope,
    });
    const sensitivity: Sensitivity = params.sensitivity ?? "internal";
    assertNoAccidentalSecret({
      texts: [params.title, params.body],
      sensitivity,
      surfaceHint: "Remove plaintext credentials before adding a rule.",
    });
    const vis = createVisibilityHelpers({
      db: this.engine.db,
      realms: ctx.realms,
      mounts: ctx.mounts,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      scope: ctx.scope,
    });
    const resolvedAbout = resolveAboutRefsForWrite({
      db: this.engine.db,
      realms: ctx.realms,
      orgId: ctx.org.id,
      about: aboutList,
      scope: ctx.scope,
      vis,
    });
    const supersedesList = (params.supersedes ?? [])
      .map((s) => s.trim())
      .filter(Boolean);
    const becauseList = (params.because ?? [])
      .map((s) => s.trim())
      .filter(Boolean);
    return this.engine.ledger.appendRecord({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmId: targetRealm.id,
      thingId: resolvedAbout.thingId,
      kind: "rule",
      title: params.title.trim(),
      payload: buildWriteRecordPayload(params.body.trim()),
      refs: becauseList,
      objectIds: resolvedAbout.objectIds,
      resourceTags: resolvedAbout.resourceTags,
      supersedesIds: supersedesList.length > 0 ? supersedesList : undefined,
      occurredAt: params.occurredAt,
      sensitivity: params.sensitivity,
      idempotencyKey: params.idempotencyKey,
      writeScope: this.effectiveWriteScope(),
      allowRedactedReingest:
        this.principal.authKind === "local" &&
        this.principal.actor.kind === "human",
    });
  }

  async redact(params: SurfaceRedactInput): Promise<RedactResult> {
    if (typeof params?.entryId !== "string" || !params.entryId.trim()) {
      throw new MindError(
        "INVALID_INPUT",
        "redact requires a non-empty string entryId",
        { try: "meru-mind redact <entryId> --reason <reason> --as-human" },
      );
    }
    const entryId = params.entryId.trim();
    const reason =
      params.reason === undefined
        ? undefined
        : typeof params.reason === "string"
          ? params.reason
          : (() => {
              throw new MindError(
                "INVALID_INPUT",
                "redact reason must be a string",
              );
            })();
    const cliCmd = `meru-mind redact ${entryId}${reason ? ` --reason ${JSON.stringify(reason)}` : ""} --as-human`;
    this.assertNotWeakenedCookie("redact", cliCmd);
    this.assertHuman("redact entries", cliCmd);
    const ctx = this.resolveScopeContext(true);
    if (ctx.org.policy === "tree" && !this.isOrgRootPrincipal(ctx.realms)) {
      const rec = this.engine.db.getRecord(entryId);
      const sea = rec ? null : this.engine.db.getSeabedEntry(entryId);
      const entryOrgId = rec?.orgId ?? sea?.orgId ?? null;
      const entryRealmId = rec?.realmId ?? sea?.realmId ?? null;
      const isVisible = rec
        ? ctx.scope.readableLedgerIds.includes(rec.realmId)
        : sea
          ? ctx.scope.readableSeabedIds.includes(sea.realmId)
          : false;
      if (!entryRealmId || entryOrgId !== ctx.org.id || !isVisible) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const boundSubtree = this.getBoundSubtreeRealmIds(ctx.realms);
      if (!boundSubtree.has(entryRealmId)) {
        const redactVis = createVisibilityHelpers({
          db: this.engine.db,
          realms: ctx.realms,
          mounts: ctx.mounts,
          actor: this.principal.actor,
          viewerRealmId: this.principal.boundRealmId,
          scope: ctx.scope,
        });
        const safePath = redactVis.getSanitizedRealmPath(entryRealmId);
        throw new MindError(
          "ACCESS_DENIED",
          `Cannot redact entry in "${safePath}": realm is outside your bound subtree.`,
        );
      }
    }
    return this.engine.ledger.redact({
      actor: this.principal.actor,
      entryId,
      reason,
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
    const cliCmd = `meru-mind token create --actor-id ${params.actorId} --kind ${params.actorKind}${params.boundRealmRef ? ` --in ${params.boundRealmRef}` : ""}${params.writeScope ? ` --write-scope ${params.writeScope}` : ""}`;
    this.assertOrgRootHuman("create authentication tokens", cliCmd);
    return createAuthToken({
      db: this.engine.db,
      orgId: this.principal.orgId,
      actorId: params.actorId,
      actorKind: params.actorKind,
      actorFamily: params.actorFamily,
      actorRole: params.actorRole,
      boundRealmId: params.boundRealmRef,
      writeScope: params.writeScope,
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

  async createObject(
    params: SurfaceCreateObjectInput,
  ): Promise<CreateObjectResult> {
    const ctx = this.resolveScopeContext(false);
    const parentObjectId = params.parentRef?.trim()
      ? this.resolveObjectIdForSurface(params.parentRef.trim(), ctx)
      : params.parentRef === null
        ? null
        : undefined;
    return this.engine.objects.createObjectWithStatus({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      targetRealmRef: params.in,
      parentObjectId,
      kind: params.kind,
      name: params.name,
      ifNotExists: params.ifNotExists,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
    });
  }

  async moveObject(params: SurfaceMoveObjectInput): Promise<MindObject> {
    this.assertNotWeakenedCookie(
      "object move",
      `meru-mind object move ${params.ref} --parent ${params.parentRef ?? "none"}`,
    );
    const ctx = this.resolveScopeContext(false);
    const objectId = this.resolveObjectIdForSurface(params.ref, ctx);
    const parentRaw = params.parentRef?.trim() ?? "";
    const nextParentId =
      !parentRaw ||
      parentRaw.toLowerCase() === "none" ||
      parentRaw.toLowerCase() === "null"
        ? null
        : this.resolveObjectIdForSurface(parentRaw, ctx);
    return this.engine.objects.moveObject({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      objectId,
      parentObjectId: nextParentId,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
    });
  }

  async deleteObject(params: SurfaceDeleteObjectInput): Promise<boolean> {
    this.assertNotWeakenedCookie(
      "object delete",
      `meru-mind object delete ${params.ref}`,
    );
    const ctx = this.resolveScopeContext(false);
    const objectId = this.resolveObjectIdForSurface(params.ref, ctx);
    return this.engine.objects.deleteObject({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      objectId,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
    });
  }

  async linkObject(params: SurfaceLinkObjectInput): Promise<EntryObjectLink> {
    const ctx = this.resolveScopeContext(false);
    const entryId = params.entryId.trim();
    const rec = this.engine.db.getRecord(entryId);
    if (
      rec &&
      rec.orgId === ctx.org.id &&
      ctx.scope.readableLedgerIds.includes(rec.realmId) &&
      rec.kind === "rule"
    ) {
      const cliCmd = `meru-mind object link ${entryId} --to ${params.objectRef} --as-human`;
      this.assertNotWeakenedCookie("object link on rule", cliCmd);
      this.assertHuman("link rules to objects", cliCmd);
    }
    const objectId = this.resolveObjectIdForSurface(params.objectRef, ctx);
    return this.engine.objects.linkEntryObject({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      entryId,
      objectId,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
    });
  }

  async unlinkObject(params: SurfaceUnlinkObjectInput): Promise<boolean> {
    const ctx = this.resolveScopeContext(false);
    const entryId = params.entryId.trim();
    const rec = this.engine.db.getRecord(entryId);
    if (
      rec &&
      rec.orgId === ctx.org.id &&
      ctx.scope.readableLedgerIds.includes(rec.realmId) &&
      rec.kind === "rule"
    ) {
      const cliCmd = `meru-mind object unlink ${entryId} --from ${params.objectRef} --as-human`;
      this.assertNotWeakenedCookie("object unlink on rule", cliCmd);
      this.assertHuman("unlink rules from objects", cliCmd);
    }
    const objectId = this.resolveObjectIdForSurface(params.objectRef, ctx);
    return this.engine.objects.unlinkEntryObject({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      entryId,
      objectId,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
    });
  }

  async setObjectState(
    params: SurfaceSetObjectStateInput,
  ): Promise<ObjectStateSetResult> {
    const ctx = this.resolveScopeContext(false);
    const objectId = this.resolveObjectIdForSurface(params.ref, ctx);
    const cliCmd = `meru-mind object set ${params.ref} --state ${params.state}${params.label ? ` --label ${params.label}` : ""} --as-human`;
    return this.engine.objects.setObjectState({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      objectId,
      state: params.state,
      label: params.label,
      since: params.since,
      because: params.because,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
      onActiveRulesGuard: () => {
        this.assertNotWeakenedCookie("object set inactive (active rules)", cliCmd);
      },
    });
  }

  async updateObjectAliases(
    params: SurfaceUpdateObjectAliasesInput,
  ): Promise<ObjectAliasUpdateResult> {
    if (params.remove && params.remove.length > 0) {
      const cliCmd = `meru-mind object alias ${params.ref} ${params.remove.map((r) => `--remove ${JSON.stringify(r)}`).join(" ")} --as-human`;
      this.assertNotWeakenedCookie("object alias remove", cliCmd);
    }
    const ctx = this.resolveScopeContext(false);
    const objectId = this.resolveObjectIdForSurface(params.ref, ctx);
    return this.engine.objects.updateObjectAliases({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      objectId,
      add: params.add,
      remove: params.remove,
      writeScope: this.effectiveWriteScope(),
      scopeCeiling: ctx.scope,
    });
  }

  async importBatch(params: ImportBatchInput): Promise<ImportBatchResult> {
    this.assertNotWeakenedCookie("import", "meru-mind import md <path>");
    const writeScope = this.effectiveWriteScope();
    const hasSeabedItems =
      Array.isArray(params?.items) &&
      params.items.some((it) => it && it.target === "seabed");
    const ctx = this.resolveScopeContext(
      writeScope === "subtree" && hasSeabedItems,
    );
    return this.engine.importer.ingestBatch({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      writeScope,
      scopeCeiling: ctx.scope,
      input: params,
    });
  }

  async verifyImport(params: VerifyImportInput): Promise<VerifyImportResult> {
    const writeScope = this.effectiveWriteScope();
    const hasSeabedItems =
      Array.isArray(params?.items) &&
      params.items.some((it) => it && it.target === "seabed");
    const allowDescendantSeabed = writeScope === "subtree" && hasSeabedItems;
    const ctx = this.resolveScopeContext(allowDescendantSeabed);
    return this.engine.importer.verifyImportManifest({
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      writeScope,
      scopeCeiling: ctx.scope,
      input: params,
    });
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
