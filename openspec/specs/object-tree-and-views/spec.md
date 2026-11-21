# Object Tree and Views Specification

## Purpose

Define the single-parent object hierarchy, multi-valued realm derivation in `open` mode with zero amplification in `tree` mode, realm path addressing with opaque `NOT_FOUND`, `records.kind = 'thing'` identity anchors, `<type>:<name>` resource tags, unified three-class behavior presentation, and scoped Markdown/JSON read views (`tree`, `ls`, `cat`, `brief`, `replay`, `changes`).

## Requirements

### Requirement: Single-Parent Object Tree with Acyclicity and Scoped Linking
`ObjectEngine` SHALL manage organization-scoped `objects` nodes anchored to a `realm_id` with an optional single `parent_object_id`. Creating or moving an object SHALL verify that the target realm exists within write scope, the parent object exists in the same organization and visible scope, and no parent cycle is introduced. Deleting an object SHALL fail with `CONFLICT` while child objects exist. Linking an entry to an object (`linkEntryObject()` or write-path `objectIds`) SHALL require the target object to exist in the same organization and within the caller's readable scope, returning the exact opaque `NOT_FOUND` (`"Object not found in visible scope"`) for both hidden and nonexistent objects.

#### Scenario: Cycle in object hierarchy is rejected
- **WHEN** a caller attempts to move object `A` under its own descendant `B`
- **THEN** `moveObject()` rejects the call with `INVALID_INPUT` and leaves the existing parent unchanged

#### Scenario: Linking or querying a hidden-realm object in tree mode returns opaque NOT_FOUND
- **WHEN** a viewer in sibling realm `beta` of a `tree` organization queries or links an object belonging to hidden sibling realm `alpha`
- **THEN** the error code and message are identical to querying or linking a nonexistent object ID (`NOT_FOUND`, `"Object not found in visible scope"`)

### Requirement: Open-Mode Multi-Valued Realms and Tree-Mode Zero Amplification
In `open` mode, an entry linked via `entry_objects` to objects in multiple realms SHALL derive multi-valued realm membership for focus ranking boost in `recall()` and realm aggregation in `ls <realm>`. In `tree` mode, physical `realm_id` SHALL remain the sole hard isolation partition: `entry_objects` SHALL NEVER widen visibility, and `ls <object>`, `tree`, `cat`, `replay`, and `changes` SHALL strictly intersect every result with the caller's effective readable scope and exclude `secret` entries.

#### Scenario: Multi-object entry aggregates into linked realms in open mode but never amplifies in tree mode
- **WHEN** an entry physically stored in realm `A` is linked to an object in realm `B`
- **THEN** in an `open` organization, `ls` on realm `B` includes the entry and `recall` from realm `B` grants it the open-mode focus boost
- **AND** after switching the organization to `tree` policy (or inside a `tree` organization), a viewer in realm `B` sees zero items from hidden sibling realm `A` in `ls <object>` or `ls <realm>`

### Requirement: Realm Path Addressing with Opaque NOT_FOUND
`ObjectEngine.resolveRealmRef()` and view commands SHALL accept either a stable `realm_id` or a slash path (such as `/`, `/ops/cicd`, or `/repos/api`) resolved layer-by-layer by realm `slug`. In `tree` mode, resolving a hidden realm path and resolving a nonexistent path SHALL return the exact same opaque `NOT_FOUND` (`"Realm not found in visible scope"`).

#### Scenario: Hidden realm path and nonexistent path are indistinguishable in tree mode
- **WHEN** a viewer in `/beta` of a `tree` organization resolves `/alpha/secret-team` (an existing hidden realm) and `/does/not/exist`
- **THEN** both calls throw `MindError` with `code = "NOT_FOUND"` and the exact same message `"Realm not found in visible scope"`

### Requirement: Identity Anchors Reuse `records.kind = 'thing'` and `external_ref`
Meru Mind SHALL NOT create a separate `things` table. `LedgerEngine.createThing()`, `listThings()`, and `findThingByExternalRef()` SHALL read and write `records WHERE kind = 'thing'` using `records.external_ref` as a pure identity anchor (storing no task status or assignee), thereby inheriting full `sensitivity`, `redact`, visibility, FTS5, and `change_log` guarantees.

#### Scenario: Thing identity anchors support external_ref deduplication and obey sensitivity and redaction
- **WHEN** a caller creates a `thing` with `externalRef = "tracker:ENG-42"` and invokes `findThingByExternalRef()` or `createThing({ dedupeByExternalRef: true })`
- **THEN** the existing visible active record is returned without duplicating rows
- **AND** a `secret` thing or a redacted thing is excluded from `findThingByExternalRef()` and `listThings()`

### Requirement: Validated Resource Tags and Scoped Tag Listing
`ObjectEngine.tagEntryResource()` and write-path `resourceTags` SHALL enforce `<type>:<name>` format (no whitespace) and normalize `<type>` to lowercase. `ObjectEngine.listResourceTags()` SHALL return tag counts strictly computed from visible, non-secret, non-redacted entries within caller scope.

#### Scenario: Malformed tags are rejected and secret or hidden tags are never listed
- **WHEN** a caller tags an entry with `"invalid tag"` (missing colon or containing whitespace)
- **THEN** the engine rejects the call with `INVALID_INPUT`
- **AND** `listResourceTags()` omits tags attached only to `secret`, redacted, or hidden-realm entries

### Requirement: Unified Three Behavior Classes, Default Markdown Output, and Scoped Views
CLI and MCP SHALL present three behavior classes (`rule`, `conclusion`, `raw`) while retaining deprecated aliases (`record`, `capture`, `mind_append_record`, `mind_capture_seabed`, `sourceType`) explicitly marked for removal in `v0.3.0`. CLI view commands (`tree`, `ls`, `cat`, `brief`, `replay`, `changes`) SHALL output compact Markdown by default while keeping `--json` backward-stable.
- `brief` SHALL report exact SQL three-bucket counts (`rules`, `conclusions`, `raw`), exact `omittedCount` per section, and when a realm narrative card exists, its `change_log` `seq` (`cardSeq`) and count of non-secret changes since that `seq` (`changesSinceCard`).
- `replay` SHALL retrieve up to `--window` non-secret visible entries before and after the anchor ordered by `occurred_at`, plus the sanitized `supersedes` chain when the anchor is a record.
- `changes --since <seq>` SHALL filter entries strictly by readable ledger/seabed realms and exclude `secret` entries, advancing `latestSeq` strictly to the last scanned row in the current batch (or returning `sinceSeq` when no rows were scanned) so pagination across consecutive invisible rows never skips subsequent visible changes or leaks hidden-branch sequence numbers.
- All views and their MCP tools (`mind_tree`, `mind_ls`, `mind_cat`, `mind_replay`, `mind_changes`, `mind_list_objects`, `mind_list_tags`, `mind_list_things`) SHALL pass through `resolveCallContext`, `scopeCeiling`, and the single shared `createVisibilityHelpers` sanitizer.

#### Scenario: CLI defaults to compact Markdown and preserves stable JSON with --json
- **WHEN** a caller runs `meru-mind brief`, `tree`, `ls`, `cat`, `replay`, or `changes` without `--json`
- **THEN** stdout contains structured Markdown headers and behavior-class badges (`[rule]`, `[conclusion/...]`, `[raw/...]`)
- **AND** running the same command with `--json` outputs valid structured JSON preserving backward-compatible schema fields
