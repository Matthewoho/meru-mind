// Meru Mind Official Built-In Studio UI
// Built strictly on the server-hosted `/_meru/client.js` contract (zero direct /v1/* calls, zero raw HTML injection, strict CSP).
import { createMindClient, applyHighlightRanges, loadMarkdownTools } from "/_meru/client.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function makeMeruSubLogo(size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 400 400");
  svg.setAttribute("aria-hidden", "true");
  for (const [cls, pts] of [
    ["logo-left", "34,132 124,132 244,344 154,344"],
    ["logo-right", "366,132 276,132 200,266 244,344"],
    ["logo-top", "78,56 322,56 366,132 34,132"],
  ]) {
    const p = document.createElementNS(SVG_NS, "polygon");
    p.setAttribute("class", cls);
    p.setAttribute("points", pts);
    svg.appendChild(p);
  }
  return svg;
}

/* ==================== Single Source of Truth Vocabulary (EN + ZH-CN) ==================== */

const VOCAB = {
  en: {
    // Core domain concepts
    realms: "Realms",
    rootRealm: "Root",
    tabEntries: "Entries",
    tabObjects: "Objects",
    tabRules: "Rules",
    tabInbox: "Inbox",

    // Record kinds (certainty family)
    kindFinding: "Finding",
    kindDecision: "Decision",
    kindProposal: "Proposal",
    kindClaim: "Claim",
    kindVerdict: "Verdict",
    kindRule: "Rule",
    kindEntry: "Entry",
    kindAll: "All",

    // Record statuses
    statusActive: "Active",
    statusSuperseded: "Superseded",
    statusRedacted: "Redacted",
    statusDraft: "Draft",
    statusArchived: "Archived",
    redactedTitle: "[Redacted]",
    redactedBody: "This entry has been permanently redacted.",

    // Rule origin & whisper banner
    ruleLocal: "Local",
    ruleInherited: "Inherited",
    rulesBannerCount: (n) => "Rules (" + n + ")",
    rulesBannerHint: "Expand realm rules",
    rulesBannerCollapse: "Collapse realm rules",

    // Topbar & navigation
    toggleNav: "Toggle navigation",
    searchPrompt: "Search visible realms...",
    newEntryTooltip: "New entry (C)",
    refreshTooltip: "Refresh (R)",
    showInspectorTooltip: "Show properties ([)",
    hideInspectorTooltip: "Hide properties ([)",
    realtimeStatusPrefix: "Realtime",
    realtimeWs: "Live (WebSocket)",
    realtimeLongPoll: "Live (Long-Poll)",
    realtimeConnecting: "Connecting",
    realtimeDisconnected: "Disconnected",
    realtimeAuthRequired: "Sign-in required",

    // Presence
    presence: "Presence",
    activeFocus: "Active",
    activeHere: "Active here",
    activeInChildren: "Active in child realms",
    expandRealm: "Expand child realms",
    collapseRealm: "Collapse child realms",
    expandActor: "Expand",
    collapseActor: "Collapse",
    inFlight: "By task",
    people: "By member",
    presenceGrouping: "Presence grouping",
    unkeyedSection: "No task",
    noActiveTasks: "No active tasks right now",
    browsingTag: "Browsing",
    browserClient: "Browser",
    actorHumanMember: "Human",
    collisionNote: "independent sessions working",
    sessionsPlural: "sessions",
    sessionSingle: "session",
    hereTag: "Here",
    nowTag: "now",
    loadMoreSessions: "Load more",
    noPresence: "No active sessions.",
    inspectWork: "Inspect work",
    memberActions: "Member actions",
    openRealmPrefix: "Open",
    copyActorId: "Copy actor ID",
    sessWorking: "Working",
    sessOnline: "Online",
    sessTurnEnded: (age) => "Ended " + age + " ago",
    sessSilent: (age) => "Silent " + age + " ago",
    sessActive: (age) => "Active " + age + " ago",
    sessQuiet: (age) => "Quiet " + age + " ago",

    // Entries list & filters
    filterEntriesPlaceholder: "Filter entries...",
    showHistory: "Include history",
    loadMoreEntries: "Show more",
    loadingMoreEntries: "Loading...",
    loadMoreFailed: "Could not load more entries. Try again.",
    loadMoreWithTotal: (shown, total) => "Show more · " + shown + " of " + total,
    loadMoreShownOnly: (shown) => "Show more · " + shown + " shown",
    allEntriesShown: (total) => "All " + total + " shown",
    loadedEntriesCount: (n) => n + " shown",
    noFilteredEntries: "No entries match the current filter.",
    clearFilter: "Clear filter",
    noBodyText: "No body text.",

    // Teaching empty states
    emptyEntriesDesc: "Entries hold findings, decisions, and proposals shared with every agent in this realm.",
    emptyEntriesSubtree: (n, childCount) =>
      "No direct entries here yet. " + childCount + " child realms hold " + n + " entries — pick one on the left or press ⌘K to search.",
    newEntryBtn: "New Entry",
    emptyObjectsDesc: "Objects represent people, projects, and services. They appear automatically when entries link them with --about.",
    emptyObjectsHint: (realm) => 'meru-mind write --in ' + realm + ' --about service:api --title "..."',
    emptyObjectsFiltered: (q) => 'No objects matching "' + q + '".',
    filterObjectsPlaceholder: "Filter objects by name or type...",
    emptyRulesDesc: "Rules apply automatically to every agent in this realm. As a human-only guardrail, add rules from your terminal:",
    emptyInboxDesc: "Inbox is clear. Notes written without a target realm land here until you route them.",

    // Inbox triage
    chooseRealm: "Choose realm",
    moveToRealm: "Move",
    routedToast: (dest) => "Moved to " + dest,
    triageConflict: "Could not move entry (it may have been moved already).",

    // Composer modal
    composerTitle: (realm) => "New Entry · " + realm,
    composerClose: "Close (Esc)",
    composerKindLabel: "Entry kind",
    composerPlaceholderFinding: "What did you find or confirm?",
    composerPlaceholderDecision: "What was decided?",
    composerPlaceholderProposal: "What are you proposing?",
    composerBodyPlaceholder: "Add context, evidence, or details...",
    composerSave: "Save",
    composerSaving: "Saving...",
    composerTitleRequired: "Please enter a title before saving.",
    composerSavedToast: (realm) => "Saved to " + realm,
    composerSecretBlocked: (pattern) =>
      "This looks like it contains a secret" +
      (pattern ? " (" + pattern + ")" : "") +
      ", so it wasn't saved. Remove the sensitive value or reference an environment variable name (e.g. env:API_KEY) and try again.",
    composerWriteFailed: "Could not save entry.",

    // Document Reader
    md: "Markdown view",
    raw: "Raw source",
    html: "HTML preview",
    readerViewMode: "Document view mode",
    htmlNotice: "Static HTML preview (scripts & network disabled).",
    htmlRender: "Render static preview",
    htmlHide: "Show raw source",
    payload: "Structured Payload",
    backToList: "Back to list",
    prevEntry: "Previous entry (K)",
    nextEntry: "Next entry (J)",
    mermaidDiagramView: "Diagram",
    mermaidSourceView: "Source",
    mermaidExpand: "Expand diagram",
    mermaidFit: "Fit to column",
    mermaidCopy: "Copy Mermaid source",
    mermaidCopied: "Copied",
    mermaidTooLarge: "Diagram exceeds 50,000-character limit; showing source.",
    mermaidTooMany: "Exceeded 20-diagram limit per document; showing source.",
    mermaidRenderFailed: "Mermaid syntax error — showing source: ",
    mermaidTimeout: "Mermaid render timed out — showing source.",

    // Right Inspector
    properties: "Properties",
    realmProperties: "Realm",
    objectProperties: "Object",
    closeInspector: "Close properties ([)",
    openDocument: "Open full document",
    linkedRefs: "Linked Objects & Tags",
    linkedContext: (n) => "Linked Entries (" + n + ")",
    supersedeChain: "History",
    headTag: "Current",
    activePeers: "Active Peers",
    actions: "Actions",
    copyId: "Copy ID",
    copyRef: "Copy Ref",
    copyLink: "Copy link",
    copyCmd: "Copy command",
    copiedToast: (what) => "Copied " + what,
    copiedLinkToast: "Copied link",
    copiedCmdToast: "Copied command",
    copyUnavailable: "Copy unavailable in this context",
    cliMoveCmd: "Copy CLI move command",
    cliRedactCmd: "Copy CLI redact command",
    cliMoveLabel: "Move via CLI",
    cliRedactLabel: "Redact via CLI",
    cliRequiresBearer: "Irreversible or cross-realm actions run via CLI with a Bearer token:",
    dismiss: "Dismiss",
    propId: "ID",
    propRef: "Ref",
    propKind: "Kind",
    propStatus: "Status",
    propRealm: "Realm",
    propAuthor: "Author",
    propRecorded: "Recorded",
    propSource: "Source",
    propPath: "Path",
    propName: "Name",
    propEntries: "Entries",
    propObjects: "Objects",
    propRules: "Rules",
    propLinked: "Linked",

    // Profile & Auth
    profileTooltip: "Profile & session",
    roleAdmin: "admin",
    roleMember: "member",
    actorHuman: "human",
    actorAgent: "agent",
    displayNameLabel: "Display name",
    displayNamePlaceholder: "Display name",
    save: "Save",
    saving: "Saving...",
    displayNameSaved: "Display name updated",
    saveFailed: "Failed to save",
    signOut: "Sign out",
    authTitleSso: "Sign in to Meru Mind",
    authTitleCli: "Sign in via CLI",
    authSsoDesc: "Continue with your team's single sign-on provider (OIDC).",
    authSsoBtn: "Sign in with SSO",
    authOrCli: "or CLI",
    authCliDescSso: "Sign in from your terminal or SSH session using an SSO device code:",
    authCliDescLocal: "Run this command in your terminal to open a single-use browser sign-in link:",
    copyLoginCmd: "Copy login command",

    // Search Modal
    searchModalPlaceholder: "Search visible realms... (Press Enter)",
    searchClose: "Close search",
    searchHint: "Type keywords and press Enter to search across all visible realms.",
    searchNoResults: (q) => 'No matching entries for "' + q + '".',
    searchFailed: "Search failed",

    // Settings Modal
    settings: "Settings",
    settingsTooltip: "Settings (⌘,)",
    closeSettings: "Close settings",
    appearance: "Appearance",
    realtimeAuth: "Realtime & Session",
    shortcuts: "Shortcuts",
    language: "Language",
    languageDesc: "Switch interface language between English and Simplified Chinese.",
    themeTitle: "Theme",
    themeDesc: "Monochromatic two-tone light or dark liquid glass.",
    themeLight: "Light",
    themeDark: "Dark",
    transportTitle: "Realtime Transport",
    transportDesc: "WebSocket primary with automatic Long-Poll fallback.",
    sessionScopeTitle: "Session Scope",
    sessionScopeDesc: "Browser sessions support reading, writing, and inbox routing. Irreversible actions stay CLI-only.",
    sessionScopeVal: "HttpOnly Cookie",
    shortcutHint: "Active when not typing in an input.",
    scSearch: "Open global search",
    scStep: "Focus next / previous entry",
    scOpen: "Open focused entry",
    scEsc: "Return to list / close dialog",
    scCompose: "Compose a new entry",
    scRefresh: "Refresh current realm",
    scInspector: "Toggle properties panel",
    scSettings: "Open settings",

    // Relative time
    timeJustNow: "just now",
    timeMinAgo: (m) => m + "m ago",
    timeHourAgo: (h) => h + "h ago",
    timeDayAgo: (d) => d + "d ago",

    // Object kinds
    objKindPerson: "Person",
    objKindProject: "Project",
    objKindService: "Service",
    objKindRepo: "Repo",
    objKindEnv: "Environment",

    // Center Object Page (v0.7.0)
    signalRules: "Rules",
    signalPending: "Pending",
    signalPeers: "Active peers",
    ruleGroupWall: "Wall · Realm",
    ruleGroupObject: "Object & ancestors",
    ruleGroupWith: "Linked (--with)",
    objSecPending: "Pending Decisions",
    objSecActiveDecisions: "Active Decisions",
    objSecNarrative: "Summary",
    objSecChildren: "Children",
    objSecCoOccurring: "Co-occurring",
    objSecRecordStream: "Record Stream",
    objEmptyStream: "No records linked to this object yet.",
    showMoreDecisions: (n) => "Show more (+" + n + ")",
    showFewerDecisions: "Show top 5",
    narrativeNonBinding: "Agent summary · non-binding",
    freshnessFresh: "Fresh",
    freshnessSoftStale: "Updates since settled",
    freshnessHardStale: "Outdated summary",
    hardStaleExpand: "Show outdated text",
    hardStaleCollapse: "Hide outdated text",
    hardStaleLoading: "Loading historic text...",
    hardStaleUnavailable: "Historic text unavailable.",
    propParent: "Parent",
    propAliases: "Aliases",
    propState: "State",
    objStateActive: "Active",
    objStateInactive: "Inactive",
    objStateArchived: "Archived",
    objStateSuperseded: "Superseded",

    // Generic errors
    loadEntryFailed: "Failed to load entry",
    loadObjectFailed: "Failed to load object",
  },
  "zh-CN": {
    // Core domain concepts (approved terminology)
    realms: "识界",
    rootRealm: "根识界",
    tabEntries: "记录",
    tabObjects: "对象",
    tabRules: "规矩",
    tabInbox: "待分拣",

    // Record kinds (certainty family)
    kindFinding: "发现",
    kindDecision: "决定",
    kindProposal: "提议",
    kindClaim: "主张",
    kindVerdict: "裁决",
    kindRule: "规矩",
    kindEntry: "记录",
    kindAll: "全部",

    // Record statuses
    statusActive: "生效中",
    statusSuperseded: "已被取代",
    statusRedacted: "已销毁",
    statusDraft: "草稿",
    statusArchived: "已归档",
    redactedTitle: "[已销毁]",
    redactedBody: "该记录的内容已被永久销毁。",

    // Rule origin & whisper banner
    ruleLocal: "本识界",
    ruleInherited: "继承自上级",
    rulesBannerCount: (n) => "规矩 " + n + " 条",
    rulesBannerHint: "展开本识界规矩",
    rulesBannerCollapse: "收起本识界规矩",

    // Topbar & navigation
    toggleNav: "切换导航栏",
    searchPrompt: "搜索可见识界…",
    newEntryTooltip: "新记录 (C)",
    refreshTooltip: "刷新 (R)",
    showInspectorTooltip: "显示属性栏 ([)",
    hideInspectorTooltip: "收起属性栏 ([)",
    realtimeStatusPrefix: "实时连接",
    realtimeWs: "已连接（WebSocket）",
    realtimeLongPoll: "已连接（长轮询）",
    realtimeConnecting: "连接中",
    realtimeDisconnected: "未连接",
    realtimeAuthRequired: "需要重新登录",

    // Presence
    presence: "当前在线",
    activeFocus: "在线",
    activeHere: "同域活跃",
    activeInChildren: "子识界活跃",
    expandRealm: "展开子识界",
    collapseRealm: "折叠子识界",
    expandActor: "展开",
    collapseActor: "折叠",
    inFlight: "按任务",
    people: "按成员",
    presenceGrouping: "在线分组视图",
    unkeyedSection: "未关联任务",
    noActiveTasks: "当前没有进行中的任务",
    browsingTag: "浏览中",
    browserClient: "浏览器",
    actorHumanMember: "人类成员",
    collisionNote: "个独立会话同时施工",
    sessionsPlural: "个会话",
    sessionSingle: "个会话",
    hereTag: "当前域",
    nowTag: "刚刚",
    loadMoreSessions: "加载更多",
    noPresence: "当前无活跃会话。",
    inspectWork: "查看进展详情",
    memberActions: "成员操作",
    openRealmPrefix: "前往",
    copyActorId: "复制成员 ID",
    sessWorking: "工作中",
    sessOnline: "在线",
    sessTurnEnded: (age) => age + " 前结束",
    sessSilent: (age) => "静默 " + age,
    sessActive: (age) => age + " 前活跃",
    sessQuiet: (age) => age + " 前静默",

    // Entries list & filters
    filterEntriesPlaceholder: "筛选记录…",
    showHistory: "包含历史版本",
    loadMoreEntries: "加载更多",
    loadingMoreEntries: "加载中…",
    loadMoreFailed: "加载更多失败，请重试",
    loadMoreWithTotal: (shown, total) => "加载更多 · 已显示 " + shown + " / " + total,
    loadMoreShownOnly: (shown) => "加载更多 · 已显示 " + shown + " 条",
    allEntriesShown: (total) => "已全部显示 · " + total + " 条",
    loadedEntriesCount: (n) => "已加载 " + n + " 条",
    noFilteredEntries: "没有符合当前筛选条件的记录。",
    clearFilter: "清除筛选",
    noBodyText: "暂无正文内容。",

    // Teaching empty states
    emptyEntriesDesc: "记录用于沉淀本识界内的发现、决定与提议，供你和所有 Agent 共同读取。",
    emptyEntriesSubtree: (n, childCount) =>
      "当前识界下还没有直接记录。下级 " + childCount + " 个子识界共有 " + n + " 条记录，可从左侧切换或按 ⌘K 搜索。",
    newEntryBtn: "新记录",
    emptyObjectsDesc: "对象代表本识界里的人、项目或服务。写入记录时通过 --about 关联即可自动出现在这里。",
    emptyObjectsHint: (realm) => 'meru-mind write --in ' + realm + ' --about service:api --title "..."',
    emptyObjectsFiltered: (q) => '没有匹配“' + q + '”的对象。',
    filterObjectsPlaceholder: "按名称或类型筛选对象…",
    emptyRulesDesc: "规矩会自动约束本识界下的所有 Agent。为防误改，规矩仅支持人类在终端通过 CLI 添加：",
    emptyInboxDesc: "待分拣已清空。写入时未指定识界的记录会先落到这里，方便后续分流。",

    // Inbox triage
    chooseRealm: "选择目标识界",
    moveToRealm: "移入",
    routedToast: (dest) => "已移入 " + dest,
    triageConflict: "移动失败，该记录可能已被分拣。",

    // Composer modal
    composerTitle: (realm) => "新记录 · " + realm,
    composerClose: "关闭 (Esc)",
    composerKindLabel: "记录类型",
    composerPlaceholderFinding: "写下你知道的一件事…",
    composerPlaceholderDecision: "定了什么？",
    composerPlaceholderProposal: "你想提议什么？",
    composerBodyPlaceholder: "补充背景、依据或细节…",
    composerSave: "保存",
    composerSaving: "保存中…",
    composerTitleRequired: "请先填写标题再保存。",
    composerSavedToast: (realm) => "已保存到 " + realm,
    composerSecretBlocked: (pattern) =>
      "内容里疑似包含密钥或敏感凭据" +
      (pattern ? "（" + pattern + "）" : "") +
      "，为防泄露未保存。请移除敏感值（或改为环境变量名，如 env:API_KEY）后重试。",
    composerWriteFailed: "保存失败，请稍后重试。",

    // Document Reader
    md: "Markdown 阅读视图",
    raw: "查看原文",
    html: "HTML 沙箱预览",
    readerViewMode: "文档阅读视图",
    htmlNotice: "静态 HTML 沙箱预览（脚本与外链请求已完全禁用）。",
    htmlRender: "渲染静态预览",
    htmlHide: "查看源码",
    payload: "结构化数据",
    backToList: "返回列表",
    prevEntry: "上一条 (K)",
    nextEntry: "下一条 (J)",
    mermaidDiagramView: "图表视图",
    mermaidSourceView: "查看源码",
    mermaidExpand: "展开图表",
    mermaidFit: "适应栏宽",
    mermaidCopy: "复制源码",
    mermaidCopied: "已复制",
    mermaidTooLarge: "图表超过 50,000 字符上限，已显示源码",
    mermaidTooMany: "已超过单篇 20 张图表上限，已显示源码",
    mermaidRenderFailed: "Mermaid 渲染失败，已显示源码：",
    mermaidTimeout: "Mermaid 渲染超时，已显示源码",

    // Right Inspector
    properties: "属性",
    realmProperties: "识界属性",
    objectProperties: "对象属性",
    closeInspector: "收起属性栏 ([)",
    openDocument: "展开全文",
    linkedRefs: "关联对象与标签",
    linkedContext: (n) => "关联记录（" + n + "）",
    supersedeChain: "演进历史",
    headTag: "当前版本",
    activePeers: "同域活跃会话",
    actions: "操作",
    copyId: "复制 ID",
    copyRef: "复制引用",
    copyLink: "复制文档链接",
    copyCmd: "复制命令",
    copiedToast: (what) => "已复制 " + what,
    copiedLinkToast: "已复制链接",
    copiedCmdToast: "已复制命令",
    copyUnavailable: "当前环境不支持复制到剪贴板",
    cliMoveCmd: "复制 CLI 移动命令",
    cliRedactCmd: "复制 CLI 销毁命令",
    cliMoveLabel: "通过 CLI 移动",
    cliRedactLabel: "通过 CLI 销毁",
    cliRequiresBearer: "不可逆或跨识界治理操作需在终端使用 CLI 执行：",
    dismiss: "关闭",
    propId: "ID",
    propRef: "引用",
    propKind: "类型",
    propStatus: "状态",
    propRealm: "识界",
    propAuthor: "作者",
    propRecorded: "时间",
    propSource: "来源",
    propPath: "路径",
    propName: "名称",
    propEntries: "记录",
    propObjects: "对象",
    propRules: "规矩",
    propLinked: "关联数",

    // Profile & Auth
    profileTooltip: "个人资料与会话",
    roleAdmin: "管理员",
    roleMember: "成员",
    actorHuman: "人类",
    actorAgent: "Agent",
    displayNameLabel: "显示名称",
    displayNamePlaceholder: "输入显示名称",
    save: "保存",
    saving: "保存中…",
    displayNameSaved: "显示名称已更新",
    saveFailed: "保存失败",
    signOut: "退出登录",
    authTitleSso: "登录 Meru Mind",
    authTitleCli: "通过 CLI 登录",
    authSsoDesc: "使用团队的单点登录（OIDC）继续。",
    authSsoBtn: "使用 SSO 登录",
    authOrCli: "或通过终端 CLI",
    authCliDescSso: "在终端或 SSH 中运行以下命令，通过设备码完成登录：",
    authCliDescLocal: "在终端运行以下命令获取一次性浏览器登录链接：",
    copyLoginCmd: "复制登录命令",

    // Search Modal
    searchModalPlaceholder: "搜索所有可见识界…（按 Enter）",
    searchClose: "关闭搜索",
    searchHint: "输入关键词后按 Enter，在当前可见识界中搜索。",
    searchNoResults: (q) => "未找到与“" + q + "”相关的记录。",
    searchFailed: "搜索失败",

    // Settings Modal
    settings: "设置",
    settingsTooltip: "设置 (⌘,)",
    closeSettings: "关闭设置",
    appearance: "外观与语言",
    realtimeAuth: "实时同步与会话",
    shortcuts: "快捷键",
    language: "界面语言",
    languageDesc: "在英文与简体中文之间切换界面文案。",
    themeTitle: "外观主题",
    themeDesc: "单色调浅色 / 深色液态玻璃主题。",
    themeLight: "浅色液态玻璃",
    themeDark: "深色液态玻璃",
    transportTitle: "实时传输",
    transportDesc: "优先 WebSocket，不可用时自动降级长轮询。",
    sessionScopeTitle: "会话权限",
    sessionScopeDesc: "浏览器会话支持浏览、写入与待分拣归档，不可逆操作保留在终端 CLI。",
    sessionScopeVal: "HttpOnly Cookie",
    shortcutHint: "未聚焦输入框时生效。",
    scSearch: "打开全局搜索",
    scStep: "切换上一条 / 下一条记录",
    scOpen: "展开当前选中的记录",
    scEsc: "返回列表 / 关闭弹窗",
    scCompose: "撰写新记录",
    scRefresh: "刷新当前识界",
    scInspector: "显示 / 收起右侧属性栏",
    scSettings: "打开设置",

    // Relative time
    timeJustNow: "刚刚",
    timeMinAgo: (m) => m + " 分钟前",
    timeHourAgo: (h) => h + " 小时前",
    timeDayAgo: (d) => d + " 天前",

    // Object kinds
    objKindPerson: "成员",
    objKindProject: "项目",
    objKindService: "服务",
    objKindRepo: "代码库",
    objKindEnv: "环境",

    // Center Object Page (v0.7.0)
    signalRules: "规矩",
    signalPending: "待拍板",
    signalPeers: "活跃协作",
    ruleGroupWall: "墙规矩 · 识界",
    ruleGroupObject: "对象及上级",
    ruleGroupWith: "联动对象 (--with)",
    objSecPending: "待拍板",
    objSecActiveDecisions: "现行决定",
    objSecNarrative: "简介",
    objSecChildren: "下级对象",
    objSecCoOccurring: "关联对象",
    objSecRecordStream: "记录流",
    objEmptyStream: "该对象下暂无关联记录。",
    showMoreDecisions: (n) => "展开更多 +" + n,
    showFewerDecisions: "仅看前 5 条",
    narrativeNonBinding: "Agent 摘要 · 非规矩",
    freshnessFresh: "最新",
    freshnessSoftStale: "其后有新增",
    freshnessHardStale: "摘要已过时",
    hardStaleExpand: "展开历史文本",
    hardStaleCollapse: "收起历史文本",
    hardStaleLoading: "正在加载历史文本…",
    hardStaleUnavailable: "暂无可查看的历史文本。",
    propParent: "上级对象",
    propAliases: "别名",
    propState: "状态",
    objStateActive: "活跃",
    objStateInactive: "非活跃",
    objStateArchived: "已归档",
    objStateSuperseded: "已被取代",

    // Generic errors
    loadEntryFailed: "加载记录失败",
    loadObjectFailed: "加载对象失败",
  },
};

function detectStudioLang() {
  const saved = localStorage.getItem("meru-studio-lang");
  if (saved === "en" || saved === "zh-CN") return saved;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function st(key, ...args) {
  const dict = VOCAB[state.lang] || VOCAB.en;
  const val = dict[key] !== undefined ? dict[key] : VOCAB.en[key];
  if (typeof val === "function") return val(...args);
  return val !== undefined ? val : key;
}

/* ==================== Monochrome Linear SVG Icon Registry (1.5px stroke, 24×24) ==================== */

function makeSvg(elements, size = 16, strokeWidth = 1.5) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const item of elements) {
    if (typeof item === "string") {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", item);
      svg.appendChild(p);
    } else if (item && item.tag) {
      const el = document.createElementNS(SVG_NS, item.tag);
      for (const [k, v] of Object.entries(item.attrs || {})) {
        el.setAttribute(k, String(v));
      }
      svg.appendChild(el);
    }
  }
  return svg;
}

const ICONS = {
  logo: () => makeMeruSubLogo(18),
  realm: () => makeSvg(["M3 7.5A2 2 0 0 1 5 5.5h4.2l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10Z"], 14),
  inbox: () => makeSvg(["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"], 14),
  entries: () => makeSvg(["M5 7h14", "M5 12h14", "M5 17h9"], 14),
  objects: () => makeSvg(["M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z", "M12 12l8-4.5", "M12 12v9", "M12 12L4 7.5"], 14),
  rules: () => makeSvg(["M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z"], 14),

  // Certainty-family kind icons
  kindFinding: (size = 14) => makeSvg([
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 8.5 } },
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 2.6, fill: "currentColor", stroke: "none" } },
  ], size),
  kindDecision: (size = 14) => makeSvg([
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 8.5 } },
    "M8.5 12.2l2.3 2.3 4.8-4.8",
  ], size),
  kindProposal: (size = 14) => makeSvg([
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 8.5, "stroke-dasharray": "3.4 3.1" } },
  ], size),
  kindClaim: (size = 14) => makeSvg([
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 8.5 } },
    "M9.75 9.25v5.5",
    "M14.25 9.25v5.5",
  ], size),
  kindVerdict: (size = 14) => makeSvg([
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 9 } },
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 5 } },
  ], size),
  kindRule: (size = 14) => makeSvg(["M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z"], size),
  kindNeutral: (size = 14) => makeSvg([
    { tag: "circle", attrs: { cx: 12, cy: 12, r: 8 } },
  ], size),

  user: () => makeSvg(["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"], 12),
  users: () => makeSvg([
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ], 13),
  search: () => makeSvg(["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M21 21l-4.35-4.35"], 15),
  plus: () => makeSvg(["M12 5v14", "M5 12h14"], 15),
  refresh: () => makeSvg(["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"], 15),
  panelRight: () => makeSvg(["M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z", "M15 3v18"], 15),
  settings: () => makeSvg([
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
  ], 15),
  dots: () => makeSvg(["M5 12h.01", "M12 12h.01", "M19 12h.01"], 14, 2.2),
  copy: () => makeSvg(["M8 8h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z", "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"], 14),
  check: () => makeSvg(["M5 12.5l4.2 4.2L19 7"], 13),
  arrowRight: () => makeSvg(["M5 12h14", "M13 6l6 6-6 6"], 14),
  arrowLeft: () => makeSvg(["M19 12H5", "M11 18l-6-6 6-6"], 13),
  close: () => makeSvg(["M18 6L6 18", "M6 6l12 12"], 15),
  menu: () => makeSvg(["M4 7h16", "M4 12h16", "M4 17h16"], 16),
  logout: () => makeSvg(["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"], 14),
  work: () => makeSvg(["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"], 13),
  collision: () => makeSvg(["M16 3h5v5", "M4 20L21 3", "M21 16v5h-5", "M15 15l6 6", "M4 4l5 5"], 13),
  chevronRight: () => makeSvg(["M9 6l6 6-6 6"], 12),
  chevronDown: () => makeSvg(["M6 9l6 6 6-6"], 12),
  chevronUp: () => makeSvg(["M18 15l-6-6-6 6"], 14),
  link: () => makeSvg(["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"], 14),
  terminal: () => makeSvg(["M4 17l6-6-6-6", "M12 19h8"], 14),
  bookOpen: () => makeSvg(["M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z", "M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"], 14),
  code: () => makeSvg(["M16 18l6-6-6-6", "M8 6l-6 6 6 6"], 14),
  eye: () => makeSvg(["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"], 14),
  alertTriangle: (size = 14) => makeSvg([
    "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z",
    "M12 9v4",
    "M12 17h.01",
  ], size),
};

function kindMeta(rawKind) {
  const k = String(rawKind || "").trim().toLowerCase();
  switch (k) {
    case "finding":
      return { key: "finding", label: st("kindFinding"), icon: ICONS.kindFinding };
    case "decision":
      return { key: "decision", label: st("kindDecision"), icon: ICONS.kindDecision };
    case "proposal":
      return { key: "proposal", label: st("kindProposal"), icon: ICONS.kindProposal };
    case "claim":
      return { key: "claim", label: st("kindClaim"), icon: ICONS.kindClaim };
    case "verdict":
      return { key: "verdict", label: st("kindVerdict"), icon: ICONS.kindVerdict };
    case "rule":
      return { key: "rule", label: st("kindRule"), icon: ICONS.kindRule };
    default:
      return { key: "other", label: st("kindEntry"), icon: ICONS.kindNeutral };
  }
}

function statusMeta(rawStatus, isRedacted = false) {
  if (isRedacted) return { key: "redacted", label: st("statusRedacted"), notable: true };
  const s = String(rawStatus || "").trim().toLowerCase();
  if (s === "superseded") return { key: "superseded", label: st("statusSuperseded"), notable: true };
  if (s === "retracted" || s === "redacted") return { key: "redacted", label: st("statusRedacted"), notable: true };
  if (s === "draft") return { key: "draft", label: st("statusDraft"), notable: true };
  if (s === "archived") return { key: "archived", label: st("statusArchived"), notable: true };
  return { key: "active", label: st("statusActive"), notable: false };
}

function objectKindLabel(rawKind) {
  const k = String(rawKind || "").trim().toLowerCase();
  if (k === "person") return st("objKindPerson");
  if (k === "project") return st("objKindProject");
  if (k === "service") return st("objKindService");
  if (k === "repo") return st("objKindRepo");
  if (k === "env") return st("objKindEnv");
  return rawKind ? String(rawKind) : st("tabObjects");
}

function objectStateLabel(rawState) {
  const s = String(rawState || "").trim().toLowerCase();
  if (s === "inactive") return st("objStateInactive");
  if (s === "archived") return st("objStateArchived");
  if (s === "superseded") return st("objStateSuperseded");
  return st("objStateActive");
}

const OBJECT_TAG_CHIP_RE = /^[a-z][a-z0-9_-]*:[^\s]+$/i;

function getEntryObjectChips(item) {
  const chips = [];
  const seen = new Set();
  if (Array.isArray(item?.objectRefs)) {
    for (const o of item.objectRefs) {
      if (!o || !o.ref) continue;
      const key = String(o.ref).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      chips.push({ ref: String(o.ref), label: String(o.ref), kind: o.kind || "", name: o.name || "" });
    }
  }
  if (Array.isArray(item?.resourceTags)) {
    for (const tag of item.resourceTags) {
      const t = String(tag || "").trim();
      if (!t || !OBJECT_TAG_CHIP_RE.test(t)) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      chips.push({ ref: t, label: t, kind: t.split(":")[0] || "", name: t.slice(t.indexOf(":") + 1) });
    }
  }
  return chips;
}

function realtimeStatusLabel(status) {
  switch (status) {
    case "ws": return st("realtimeWs");
    case "long-poll": return st("realtimeLongPoll");
    case "connecting": return st("realtimeConnecting");
    case "auth-required": return st("realtimeAuthRequired");
    default: return st("realtimeDisconnected");
  }
}

function formatPulseAge(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "";
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  return m < 60 ? (m + "m") : (Math.floor(m / 60) + "h");
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return formatStamp(iso);
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return st("timeJustNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return st("timeMinAgo", diffMin);
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return st("timeHourAgo", diffHour);
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return st("timeDayAgo", diffDay);
  return String(iso).slice(0, 10);
}

function formatStamp(iso) {
  if (!iso) return "-";
  return String(iso).slice(0, 16).replace("T", " ");
}

function formatAuthorName(entry) {
  if (!entry) return "";
  if (entry.authorDisplayName && String(entry.authorDisplayName).trim()) {
    return String(entry.authorDisplayName).trim();
  }
  if (entry.authorId) {
    if (state.whoami?.actor?.id === entry.authorId && state.whoami?.actor?.displayName) {
      return state.whoami.actor.displayName;
    }
    return "@" + entry.authorId;
  }
  return "";
}

function shortSessionHandle(sessionId) {
  const cleaned = String(sessionId || "").replace(/^ps_/, "");
  return cleaned ? ("#" + cleaned.slice(0, 4)) : "";
}

function isBrowserSession(s) {
  const raw = String(s?.clientType || s?.clientHint || "").trim().toLowerCase();
  return raw === "browser";
}

function sessionClientBucketKey(s) {
  const clientKey = String(s?.clientType || s?.clientHint || s?.actorKind || "session").trim().toLowerCase();
  return String(s?.actorId || "") + "|" + clientKey;
}

function countSessionClientBuckets(sessions) {
  const counts = new Map();
  for (const s of sessions || []) {
    const k = sessionClientBucketKey(s);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

function formatSessionClientName(s) {
  if (isBrowserSession(s)) return st("browserClient");
  if (s?.clientHint && String(s.clientHint).trim()) return String(s.clientHint).trim();
  return s?.actorKind === "human" ? st("actorHuman") : st("actorAgent");
}

function formatSessionDisplayLabel(s, bucketCounts, opts = {}) {
  const whoPrefix = opts.showActor ? (String(s.actorId || "") + " · ") : "";
  const baseName = formatSessionClientName(s);
  const dupCount = bucketCounts ? (bucketCounts.get(sessionClientBucketKey(s)) || 1) : 1;
  const suffix = dupCount > 1 ? (" " + shortSessionHandle(s.sessionId)) : "";
  return whoPrefix + baseName + suffix;
}

function formatHumanRealmPath(realmPath) {
  const p = realmPath || "/";
  if (p === "/") {
    const root = (state.realms || []).find((r) => r.path === "/");
    return realmDisplayName(root);
  }
  return p;
}

function pulseRank(p) {
  return p.online ? 2 : (p.active ? 1 : 0);
}

function groupPulsesByActor(pulses) {
  const byActor = new Map();
  for (const p of pulses || []) {
    const key = String(p.actorId || "unknown");
    let group = byActor.get(key);
    if (!group) {
      group = {
        actorId: key,
        actorKind: p.actorKind || "agent",
        online: false,
        active: false,
        sessions: [],
      };
      byActor.set(key, group);
    }
    group.sessions.push(p);
    if (p.online) group.online = true;
    if (p.active) group.active = true;
  }
  const groups = Array.from(byActor.values());
  for (const g of groups) {
    g.sessions.sort((a, b) => {
      const rankDiff = pulseRank(b) - pulseRank(a);
      if (rankDiff !== 0) return rankDiff;
      return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
    });
  }
  groups.sort((a, b) => {
    const rankDiff = (b.online ? 2 : (b.active ? 1 : 0)) - (a.online ? 2 : (a.active ? 1 : 0));
    if (rankDiff !== 0) return rankDiff;
    return String(b.sessions[0]?.lastSeenAt || "").localeCompare(String(a.sessions[0]?.lastSeenAt || ""));
  });
  return groups;
}

function looksLikeHtmlDoc(text, sourceRef) {
  if (typeof sourceRef === "string" && /\.html?$/i.test(sourceRef.trim())) return true;
  return /^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<div\b|<section\b|<article\b|<main\b|<table\b|<style\b)/i.test(String(text || "").trim());
}

let activeStudioHtmlPreview = null;
let activeStudioMarkdownEl = null;
let activeObjectNarrativeMarkdownEl = null;

function teardownStudioHtmlPreview() {
  if (activeStudioHtmlPreview) {
    try { activeStudioHtmlPreview.teardown(); } catch {}
    activeStudioHtmlPreview = null;
  }
}

function teardownObjectNarrativeMarkdown() {
  if (activeObjectNarrativeMarkdownEl) {
    if (typeof activeObjectNarrativeMarkdownEl.teardown === "function") {
      try { activeObjectNarrativeMarkdownEl.teardown(); } catch {}
    }
    activeObjectNarrativeMarkdownEl = null;
  }
}

function teardownStudioReader() {
  teardownStudioHtmlPreview();
  if (activeStudioMarkdownEl) {
    if (typeof activeStudioMarkdownEl.teardown === "function") {
      try { activeStudioMarkdownEl.teardown(); } catch {}
    }
    activeStudioMarkdownEl = null;
  }
  teardownObjectNarrativeMarkdown();
}

/**
 * Unified whisper-quiet sliding icon switch (Icon Over Text).
 * Used for both sidebar Presence grouping and center Document Reader view modes.
 */
function createIconSwitch({ uiId, ariaLabel, variant, options, activeKey, datasetKey, onChange }) {
  const seg = document.createElement("div");
  seg.className = "meru-icon-switch" + (variant ? (" " + variant) : "");
  seg.dataset.ui = uiId;
  seg.dataset.activeMode = activeKey;
  seg.setAttribute("role", "tablist");
  seg.setAttribute("aria-label", ariaLabel);

  const initialIdx = Math.max(0, options.findIndex((o) => o.key === activeKey));
  seg.style.setProperty("--switch-idx", String(initialIdx));

  const thumb = document.createElement("span");
  thumb.className = "meru-icon-switch-thumb";
  thumb.setAttribute("aria-hidden", "true");
  seg.appendChild(thumb);

  let currentKey = activeKey;
  const buttons = [];
  options.forEach((opt, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "meru-icon-switch-btn" + (opt.key === currentKey ? " active" : "");
    b.dataset[datasetKey] = opt.key;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(opt.key === currentKey));
    b.setAttribute("aria-label", opt.label);
    b.title = opt.label;
    b.appendChild(opt.icon());
    b.addEventListener("click", () => {
      if (currentKey === opt.key) return;
      currentKey = opt.key;
      seg.dataset.activeMode = opt.key;
      seg.style.setProperty("--switch-idx", String(idx));
      for (const btn of buttons) {
        const isAct = btn.dataset[datasetKey] === opt.key;
        btn.classList.toggle("active", isAct);
        btn.setAttribute("aria-selected", String(isAct));
      }
      onChange(opt.key);
    });
    buttons.push(b);
    seg.appendChild(b);
  });

  return seg;
}

/**
 * Quiet monochrome segmented choice group (replaces native OS <select> in Settings).
 */
function createChoiceGroup({ ariaLabel, options, activeKey, onChange, uiId }) {
  const group = document.createElement("div");
  group.className = "meru-choice-group";
  if (uiId) group.dataset.ui = uiId;
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", ariaLabel);

  let currentKey = activeKey;
  const btns = [];
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSelected = opt.key === currentKey;
    btn.className = "meru-choice-btn" + (isSelected ? " active" : "");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(isSelected));
    btn.dataset.choice = opt.key;
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      if (opt.key === currentKey) return;
      currentKey = opt.key;
      for (const b of btns) {
        const act = b.dataset.choice === currentKey;
        b.classList.toggle("active", act);
        b.setAttribute("aria-checked", String(act));
      }
      onChange(opt.key);
    });
    btns.push(btn);
    group.appendChild(btn);
  }
  return group;
}

const app = document.getElementById("app");
const client = createMindClient();

const savedTheme = localStorage.getItem("meru-studio-theme") || "light";
document.documentElement.dataset.theme = savedTheme;

const ACTOR_SESSION_PAGE_SIZE = 5;

const state = {
  lang: detectStudioLang(),
  readerView: "md", // md | raw | html
  oidcEnabled: false,
  oidcLoginUrl: null,
  whoami: null,
  realms: [],
  realmTree: [],
  collapsedRealmIds: new Set(),
  collapsedLoadedForOrgId: null,
  realmCounts: {},
  hasInboxRealm: false,
  activeRealmPath: "/",
  activeTab: "entries", // entries | objects | rules | inbox
  brief: null,
  realmEntries: [],
  realmEntriesTotal: null,
  realmEntriesHasMore: false,
  realmEntriesCursor: null,
  realmEntriesLoadingMore: false,
  entriesReqSeq: 0,
  selectRealmSeq: 0,
  lastWorkspaceViewKey: "",
  entryKindFilter: "all",
  entrySearchFilter: "",
  rulesBannerExpanded: false,
  realmObjects: [],
  objectFilter: "",
  showLedgerHistory: false,
  inboxEntries: [],
  triageTargets: new Map(), // entryId -> targetRealmPath
  pulses: [],
  inFlight: [],
  unkeyedCount: 0,
  selfPulseSessionId: null,
  presenceCollapsed: false,
  presenceMode: "people", // "in-flight" | "people"
  presenceModeUserSet: false,
  collapsedActorIds: new Set(),
  actorVisibleCounts: new Map(),
  presenceHovered: false,
  pendingPulsePatch: null,
  presenceScrollTop: 0,
  openEntry: null, // entry opened full-width in Center Document Reader
  focusedEntryId: null, // list row focused via J/K (or matching openEntry)
  focusedEntry: null, // entry shown in Right Properties Rail
  focusedObjectRef: null, // ref of selected object
  selectedChain: null,
  selectedObject: null,
  selectedObjectActivePeers: [],
  previousObject: null,
  objectRulesExpanded: false,
  objectPeersExpanded: false,
  objectDecisionsExpanded: false,
  objectStaleCardExpanded: false,
  objectStaleCardLoading: false,
  objectStaleCardHistoricMd: null,
  objectEntries: [],
  objectEntriesTotal: null,
  objectEntriesHasMore: false,
  objectEntriesCursor: null,
  objectEntriesLoadingMore: false,
  objectEntriesReqSeq: 0,
  selectObjectSeq: 0,
  objectShowHistory: false,
  railCliCommand: null,
  savedListScrollTop: 0,
  restoreListScrollPending: false,
  inspectorOpen: false, // Auto-collapsed by default when nothing is selected (clean 2-pane workspace)
  inspectorPinned: false, // Set when user explicitly opens/closes inspector via toggle button or [
  mobileNavOpen: false,
  pumpStatus: "disconnected",
  pumpGeneration: null,
  pumpCursorSeq: 0,
  lastSyncedAt: null,
  modal: null, // null | "search" | "write" | "settings"
  settingsTab: "appearance",
  searchQuery: "",
  searchResults: null,
  writeKind: "finding",
  writeTitle: "",
  writeBody: "",
  writeSubmitting: false,
  writeError: null, // null | { kind: "secret" | "error", text: string }
  popover: null,
};

document.documentElement.lang = state.lang;

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = String(msg);
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label || st("copiedCmdToast"));
  } catch {
    showToast(st("copyUnavailable"));
  }
}

function makeIconBtn(iconEl, label, onClick, extraClass = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "meru-icon-btn" + (extraClass ? " " + extraClass : "");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.appendChild(iconEl);
  btn.addEventListener("click", onClick);
  return btn;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function pathDepth(p) {
  if (!p || p === "/") return 0;
  return p.split("/").filter(Boolean).length;
}

function realmDisplayName(realm) {
  if (!realm) return st("rootRealm");
  if (realm.path === "/") return realm.name || st("rootRealm");
  return realm.name || realm.path.slice(1);
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem("meru-studio-theme", normalized);
  if (activeStudioMarkdownEl && typeof activeStudioMarkdownEl.setTheme === "function") {
    activeStudioMarkdownEl.setTheme(normalized);
  }
  for (const el of document.querySelectorAll("meru-markdown")) {
    if (el !== activeStudioMarkdownEl && typeof el.setTheme === "function") {
      el.setTheme(normalized);
    }
  }
}

function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") {
    return { left: 12, right: 12, top: 12, bottom: 12 };
  }
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

function pointRect(x, y) {
  return { left: x, right: x, top: y, bottom: y };
}

function getPopoverLayer() {
  let layer = document.getElementById("meru-popover-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "meru-popover-layer";
    document.body.appendChild(layer);
  }
  return layer;
}

function positionPopoverElement(pop, popoverState) {
  if (!pop || !popoverState) return;
  const margin = 12;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchor = popoverState.anchorRect || pointRect(popoverState.x || margin, popoverState.y || margin);
  const placement = popoverState.placement || "right";
  const box = pop.getBoundingClientRect();
  const w = box.width;
  const h = box.height;
  const clamp = (v, min, max) => Math.max(min, Math.min(v, Math.max(min, max)));

  let left = margin;
  let top = margin;

  if (placement === "above") {
    left = clamp(anchor.left, margin, vw - w - margin);
    const aboveTop = anchor.top - h - gap;
    if (aboveTop >= margin) {
      top = clamp(aboveTop, margin, vh - h - margin);
    } else {
      top = clamp(anchor.bottom + gap, margin, vh - h - margin);
    }
  } else if (placement === "below" || placement === "below-end") {
    const rawLeft = placement === "below-end" ? (anchor.right - w) : anchor.left;
    left = clamp(rawLeft, margin, vw - w - margin);
    const belowTop = anchor.bottom + 6;
    if (belowTop + h <= vh - margin) {
      top = Math.max(margin, belowTop);
    } else {
      top = clamp(anchor.top - h - 6, margin, vh - h - margin);
    }
  } else {
    left = anchor.right + gap;
    if (left + w > vw - margin) {
      left = clamp(anchor.left - w - gap, margin, vw - w - margin);
    } else {
      left = clamp(left, margin, vw - w - margin);
    }
    if (anchor.top + h <= vh - margin) {
      top = Math.max(margin, anchor.top);
    } else {
      top = clamp(anchor.bottom - h, margin, vh - h - margin);
    }
  }

  pop.style.left = Math.round(left) + "px";
  pop.style.top = Math.round(top) + "px";
}

let renderedPopoverRef = null;
let renderedModalKey = "";

function renderPopoverLayer(force = true) {
  const layer = getPopoverLayer();
  if (!force && state.popover && state.popover === renderedPopoverRef && layer.firstChild) {
    return;
  }
  clearEl(layer);
  renderedPopoverRef = state.popover || null;
  if (!state.popover) return;
  const pop = renderPopover();
  if (!pop) return;
  pop.style.visibility = "hidden";
  layer.appendChild(pop);
  positionPopoverElement(pop, state.popover);
  pop.style.visibility = "visible";
}

function closePopover() {
  if (!state.popover && !renderedPopoverRef) return;
  state.popover = null;
  renderedPopoverRef = null;
  renderPopoverLayer(true);
}

function getModalLayer() {
  let layer = document.getElementById("meru-modal-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "meru-modal-layer";
    document.body.appendChild(layer);
  }
  return layer;
}

function currentModalKey() {
  if (!state.modal || !state.whoami) return "";
  return state.modal + "|" + state.lang + "|" + state.settingsTab;
}

function renderModalLayer(force = true) {
  const layer = getModalLayer();
  const nextKey = currentModalKey();
  if (!force && nextKey === renderedModalKey) {
    return;
  }
  clearEl(layer);
  renderedModalKey = nextKey;
  if (!nextKey) return;
  const modal = renderModal();
  if (modal) layer.appendChild(modal);
}

function closeModal() {
  if (!state.modal && !renderedModalKey) return;
  state.modal = null;
  renderedModalKey = "";
  renderModalLayer(true);
}

function getOrgId() {
  return state.whoami?.org?.id || state.whoami?.organization?.id || "default";
}

function getOrgName() {
  return state.whoami?.org?.name || state.whoami?.organization?.name || "Workspace";
}

function collapsedStorageKey(orgId) {
  return "meru-studio-collapsed-realms:" + String(orgId || "default");
}

function ensureCollapsedRealmsLoaded() {
  const orgId = getOrgId();
  if (state.collapsedLoadedForOrgId === orgId) return;
  state.collapsedLoadedForOrgId = orgId;
  const next = new Set();
  try {
    const raw = localStorage.getItem(collapsedStorageKey(orgId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === "string" && id.trim()) next.add(id);
        }
      }
    }
  } catch {
    // ignore corrupt localStorage entry
  }
  state.collapsedRealmIds = next;
}

function persistCollapsedRealms() {
  const orgId = getOrgId();
  try {
    localStorage.setItem(
      collapsedStorageKey(orgId),
      JSON.stringify(Array.from(state.collapsedRealmIds)),
    );
  } catch {
    // ignore storage quota errors
  }
}

function toggleRealmCollapsed(realmId) {
  if (!realmId) return;
  ensureCollapsedRealmsLoaded();
  if (state.collapsedRealmIds.has(realmId)) {
    state.collapsedRealmIds.delete(realmId);
  } else {
    state.collapsedRealmIds.add(realmId);
  }
  persistCollapsedRealms();
  render();
}

function getEffectiveRealmTree() {
  if (Array.isArray(state.realmTree) && state.realmTree.length > 0) {
    return state.realmTree;
  }
  const byId = new Map();
  for (const r of state.realms || []) {
    byId.set(r.id, { realm: r, counts: state.realmCounts[r.path] || {}, children: [] });
  }
  const roots = [];
  for (const node of byId.values()) {
    const pid = node.realm.parentId;
    if (pid && byId.has(pid)) {
      byId.get(pid).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function expandAncestorsForPath(targetPath) {
  if (!targetPath) return;
  ensureCollapsedRealmsLoaded();
  const ancestors = [];
  function walk(nodes, chain) {
    for (const node of nodes || []) {
      if (node.realm?.path === targetPath) {
        for (const id of chain) ancestors.push(id);
        return true;
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        if (walk(node.children, [...chain, node.realm.id])) return true;
      }
    }
    return false;
  }
  walk(getEffectiveRealmTree(), []);
  let changed = false;
  for (const id of ancestors) {
    if (state.collapsedRealmIds.has(id)) {
      state.collapsedRealmIds.delete(id);
      changed = true;
    }
  }
  if (changed) persistCollapsedRealms();
}

function collectActiveDescendantPaths(node, activeSet, out = []) {
  for (const child of node.children || []) {
    if (child.realm?.path && activeSet.has(child.realm.path)) {
      out.push(child.realm.path);
    }
    collectActiveDescendantPaths(child, activeSet, out);
  }
  return out;
}

function flattenRealmTreeCounts(nodes, out = {}) {
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    if (n?.realm?.path) {
      out[n.realm.path] = n.counts || {};
    }
    if (Array.isArray(n?.children)) {
      flattenRealmTreeCounts(n.children, out);
    }
  }
  return out;
}

function normalizeTabParam(rawTab) {
  if (rawTab === "overview" || rawTab === "conclusions" || rawTab === "entries") return "entries";
  if (rawTab === "objects" || rawTab === "rules" || rawTab === "inbox") return rawTab;
  return null;
}

/* ==================== URL as Single Source of Truth ==================== */

function isReservedShellPath(pathname) {
  return pathname === "/_meru/shell" || pathname === "/_meru/shell/";
}

function normalizeRealmPathname(rawPath) {
  if (!rawPath || rawPath === "/" || rawPath === "/index.html") return "/";
  const trimmed = rawPath.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

function parseUrlState() {
  const loc = window.location;
  const sp = new URLSearchParams(loc.search);
  const onShell = isReservedShellPath(loc.pathname);
  const realmPath = onShell
    ? normalizeRealmPathname(sp.get("realm") || "/")
    : normalizeRealmPathname(loc.pathname);
  const tab = normalizeTabParam(sp.get("tab") || "");
  const entryId = sp.get("entry") || null;
  const objectRef = sp.get("object") || null;
  const rawView = sp.get("view") || "";
  const view = (rawView === "md" || rawView === "raw" || rawView === "html") ? rawView : null;
  return { realmPath, tab, entryId, objectRef, view };
}

function buildUrlFromState() {
  const onShell = isReservedShellPath(window.location.pathname);
  const basePath = onShell ? "/_meru/shell" : (state.activeRealmPath || "/");
  const sp = new URLSearchParams();
  if (onShell && state.activeRealmPath && state.activeRealmPath !== "/") {
    sp.set("realm", state.activeRealmPath);
  }
  const activeObjRef = state.selectedObject?.ref || state.previousObject?.ref || null;
  const defaultTab = state.activeRealmPath === "/inbox" ? "inbox" : "entries";
  if (!activeObjRef && state.activeTab && state.activeTab !== defaultTab) {
    sp.set("tab", state.activeTab);
  }
  if (activeObjRef) {
    sp.set("object", activeObjRef);
  }
  if (state.openEntry?.id) {
    sp.set("entry", state.openEntry.id);
    if (state.readerView && state.readerView !== "md") {
      sp.set("view", state.readerView);
    }
  }
  const qs = sp.toString();
  return qs ? (basePath + "?" + qs) : basePath;
}

function syncUrlFromState(replace = false) {
  try {
    const nextUrl = buildUrlFromState();
    const currentUrl = window.location.pathname + window.location.search;
    if (nextUrl === currentUrl) return;
    if (replace) {
      window.history.replaceState({ meru: true }, "", nextUrl);
    } else {
      window.history.pushState({ meru: true }, "", nextUrl);
    }
  } catch {
    // ignore history API errors in restricted contexts
  }
}

function getFilteredRealmEntries() {
  const base = state.realmEntries.filter((x) => x.kind !== "rule");
  const q = state.entrySearchFilter.trim().toLowerCase();
  return base.filter((item) => {
    if (state.entryKindFilter !== "all") {
      const km = kindMeta(item.extKind || item.kind);
      if (km.key !== state.entryKindFilter) return false;
    }
    if (q) {
      const hay = [item.title, item.snippet, item.body, item.authorId, item.authorDisplayName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function getVisibleListEntries() {
  if (state.selectedObject || state.previousObject) {
    return state.objectEntries || [];
  }
  if (state.activeTab === "entries") {
    return getFilteredRealmEntries();
  }
  if (state.activeTab === "rules") {
    return state.brief?.middleMind?.rules?.items || [];
  }
  if (state.activeTab === "inbox") {
    return state.inboxEntries || [];
  }
  return [];
}

function applyPulsePayload(pulseRes, deferIfHovered = false) {
  if (!pulseRes || !Array.isArray(pulseRes.pulses)) return;
  if (deferIfHovered && state.presenceHovered) {
    state.pendingPulsePatch = pulseRes;
    return;
  }
  state.pendingPulsePatch = null;
  state.pulses = pulseRes.pulses;
  state.inFlight = Array.isArray(pulseRes.inFlight) ? pulseRes.inFlight : [];
  state.unkeyedCount = typeof pulseRes.unkeyedCount === "number" ? pulseRes.unkeyedCount : 0;
  if (!state.presenceModeUserSet) {
    state.presenceMode = state.inFlight.length > 0 ? "in-flight" : "people";
  }
}

/* ==================== Data Loading ==================== */

async function loadRealmEntries(realmPath, reset = true, opts = {}) {
  const reqRealm = realmPath;
  const reqToken = ++state.entriesReqSeq;
  const limit = opts.preserveLoadedCount
    ? Math.min(200, Math.max(25, state.realmEntries.length))
    : 25;
  let res;
  try {
    res = await client.ls({
      ref: realmPath,
      only: "entries",
      limit,
      cursor: reset ? undefined : (state.realmEntriesCursor || undefined),
      history: state.showLedgerHistory ? "true" : undefined,
    });
  } catch (err) {
    if (state.activeRealmPath !== reqRealm || reqToken !== state.entriesReqSeq) {
      return { ok: false, stale: true, error: err };
    }
    if (reset && opts.clearOnFailure) {
      state.realmEntries = [];
      state.realmEntriesTotal = null;
      state.realmEntriesCursor = null;
      state.realmEntriesHasMore = false;
    }
    return { ok: false, stale: false, error: err };
  }
  if (state.activeRealmPath !== reqRealm || reqToken !== state.entriesReqSeq) {
    return { ok: false, stale: true };
  }
  const batch = Array.isArray(res?.items) ? res.items : [];
  if (reset) {
    state.realmEntries = batch;
  } else {
    const seen = new Set(state.realmEntries.map((x) => x.id));
    for (const item of batch) {
      if (!seen.has(item.id)) state.realmEntries.push(item);
    }
  }
  state.realmEntriesTotal = typeof res?.totalMatched === "number"
    ? res.totalMatched
    : (typeof res?.total === "number" ? res.total : null);
  state.realmEntriesCursor = res?.nextCursor || null;
  state.realmEntriesHasMore = Boolean(state.realmEntriesCursor);
  return { ok: true, stale: false };
}

function getWritablePulseRealm(preferredPath) {
  const boundPath = state.whoami?.bound?.realmPath || "/";
  if (boundPath === "/") return preferredPath || "/";
  if (preferredPath === boundPath) return boundPath;
  return boundPath;
}

async function selectRealm(realmPath, preferredTab, opts = {}) {
  const mySeq = ++state.selectRealmSeq;
  const isBg = Boolean(opts.background);
  const prevRealm = state.activeRealmPath;
  state.activeRealmPath = realmPath;
  expandAncestorsForPath(realmPath);
  if (!isBg) {
    state.mobileNavOpen = false;
    closePopover();
  }
  if (prevRealm !== realmPath) {
    state.objectFilter = "";
    state.entryKindFilter = "all";
    state.entrySearchFilter = "";
    state.rulesBannerExpanded = false;
    state.realmEntriesTotal = null;
    state.realmEntriesLoadingMore = false;
  }
  if (!opts.keepReader) {
    teardownStudioReader();
    state.openEntry = null;
    state.railCliCommand = null;
    if (!opts.keepObject && !isBg) {
      state.focusedEntryId = null;
      state.focusedEntry = null;
      state.focusedObjectRef = null;
      state.selectedChain = null;
      state.selectedObject = null;
      state.selectedObjectActivePeers = [];
      state.previousObject = null;
      state.objectEntries = [];
      state.objectEntriesTotal = null;
      state.objectEntriesHasMore = false;
      state.objectEntriesCursor = null;
      state.objectEntriesLoadingMore = false;
      if (prevRealm !== realmPath) {
        state.savedListScrollTop = 0;
      }
      if (!state.inspectorPinned) {
        state.inspectorOpen = false;
      }
    } else if (prevRealm !== realmPath) {
      state.focusedEntryId = null;
      state.focusedEntry = null;
      state.focusedObjectRef = null;
      state.selectedChain = null;
      state.selectedObject = null;
      state.selectedObjectActivePeers = [];
      state.previousObject = null;
      state.savedListScrollTop = 0;
      if (!state.inspectorPinned) {
        state.inspectorOpen = false;
      }
    }
  }
  const normalizedPreferred = preferredTab ? normalizeTabParam(preferredTab) : null;
  if (normalizedPreferred) {
    state.activeTab = normalizedPreferred;
  } else if (realmPath === "/inbox") {
    state.activeTab = "inbox";
  } else {
    state.activeTab = "entries";
  }

  const shouldCheckOpenEntry = Boolean(opts.keepReader && state.openEntry && prevRealm === realmPath);
  const openEntryIdBefore = shouldCheckOpenEntry ? state.openEntry.id : null;

  const [showRes, objRes, inboxRes, openEntryCheck] = await Promise.all([
    client.brief(realmPath),
    client.ls({ ref: realmPath, only: "objects", limit: 120 }).catch(() => ({ objects: [] })),
    realmPath === "/inbox"
      ? client.ls({ ref: "/inbox", only: "entries", limit: 50 }).catch(() => ({ items: [] }))
      : Promise.resolve(null),
    openEntryIdBefore ? fetchFlatEntry(openEntryIdBefore).catch(() => null) : Promise.resolve(null),
  ]);
  if (mySeq !== state.selectRealmSeq) return;

  await loadRealmEntries(realmPath, true, {
    preserveLoadedCount: Boolean(opts.preserveLoadedCount),
    clearOnFailure: prevRealm !== realmPath,
  });
  if (mySeq !== state.selectRealmSeq) return;

  state.brief = showRes?.refType === "realm" ? showRes.brief : null;
  state.realmObjects = (objRes?.objects || objRes?.items || []).filter((o) => o.kind !== "category");
  if (inboxRes) state.inboxEntries = inboxRes.items || [];
  state.lastSyncedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const pulseRealm = getWritablePulseRealm(realmPath);
  const selfPulse = await client.pulse.setFocus([realmPath], null, pulseRealm, "browser").catch(() => null);
  if (mySeq !== state.selectRealmSeq) return;
  if (selfPulse?.sessionId) state.selfPulseSessionId = selfPulse.sessionId;
  const pulseRes = await client.pulse.list().catch(() => null);
  if (mySeq !== state.selectRealmSeq) return;
  if (pulseRes?.pulses) {
    applyPulsePayload(pulseRes, false);
  }
  if (!opts.skipUrlSync) {
    syncUrlFromState(Boolean(opts.replaceUrl));
  }

  if (shouldCheckOpenEntry && state.openEntry && state.openEntry.id === openEntryIdBefore) {
    const readerMounted = document.querySelector(
      '[data-ui="center-doc-reader"] .reader-canvas[data-entry-id="' + CSS.escape(openEntryIdBefore) + '"]',
    );
    const nextFlat = openEntryCheck?.flat || null;
    const entryUnchanged = Boolean(
      readerMounted &&
      (!nextFlat || (
        nextFlat.body === state.openEntry.body &&
        nextFlat.title === state.openEntry.title &&
        nextFlat.status === state.openEntry.status &&
        nextFlat.redactedAt === state.openEntry.redactedAt &&
        nextFlat.updatedAt === state.openEntry.updatedAt
      )),
    );
    if (entryUnchanged) {
      replaceSidebarInPlace();
      return;
    }
    if (nextFlat) {
      state.openEntry = nextFlat;
      state.focusedEntry = nextFlat;
      state.selectedChain = openEntryCheck.chainRes;
    }
  }
  render();
}

async function loadObjectEntries(objRef, reset = true, opts = {}) {
  const reqToken = ++state.objectEntriesReqSeq;
  const limit = opts.preserveLoadedCount
    ? Math.min(200, Math.max(25, state.objectEntries.length))
    : 25;
  let res;
  try {
    res = await client.ls({
      ref: objRef,
      limit,
      cursor: reset ? undefined : (state.objectEntriesCursor || undefined),
      history: state.objectShowHistory ? "true" : undefined,
    });
  } catch (err) {
    if (reqToken !== state.objectEntriesReqSeq) {
      return { ok: false, stale: true, error: err };
    }
    if (reset && opts.clearOnFailure) {
      state.objectEntries = [];
      state.objectEntriesTotal = null;
      state.objectEntriesCursor = null;
      state.objectEntriesHasMore = false;
    }
    return { ok: false, stale: false, error: err };
  }
  if (reqToken !== state.objectEntriesReqSeq) {
    return { ok: false, stale: true };
  }
  const batch = Array.isArray(res?.items) ? res.items : [];
  if (reset) {
    state.objectEntries = batch;
  } else {
    const seen = new Set(state.objectEntries.map((x) => x.id));
    for (const item of batch) {
      if (!seen.has(item.id)) state.objectEntries.push(item);
    }
  }
  state.objectEntriesTotal = typeof res?.totalMatched === "number"
    ? res.totalMatched
    : (typeof res?.total === "number" ? res.total : null);
  state.objectEntriesCursor = res?.nextCursor || null;
  state.objectEntriesHasMore = Boolean(state.objectEntriesCursor);
  return { ok: true, stale: false };
}

async function selectObjectByRef(objRef, openInspector = false, opts = {}) {
  const mySeq = ++state.selectObjectSeq;
  const prevRef = state.selectedObject?.ref || null;
  const isSameObject = Boolean(prevRef && prevRef === objRef);
  try {
    const [res, streamRes] = await Promise.all([
      client.show(objRef),
      loadObjectEntries(objRef, true, {
        preserveLoadedCount: Boolean(opts.preserveLoadedCount && isSameObject),
        clearOnFailure: !isSameObject,
      }),
    ]);
    if (mySeq !== state.selectObjectSeq) return false;
    if (res?.refType === "object" && res.card) {
      const canonicalChanged = !prevRef || prevRef !== res.card.ref;
      if (!opts.keepReader) {
        teardownStudioReader();
        state.openEntry = null;
        state.focusedEntryId = null;
        state.focusedEntry = null;
        state.selectedChain = null;
        state.previousObject = null;
      } else {
        teardownObjectNarrativeMarkdown();
      }
      state.selectedObject = res.card;
      state.selectedObjectActivePeers = Array.isArray(res.activePeers) ? res.activePeers : [];
      state.focusedObjectRef = res.card.ref || objRef;
      state.railCliCommand = null;
      if (canonicalChanged) {
        state.objectRulesExpanded = false;
        state.objectPeersExpanded = false;
        state.objectDecisionsExpanded = false;
        state.objectStaleCardExpanded = false;
        state.objectStaleCardLoading = false;
        state.objectStaleCardHistoricMd = null;
        state.objectEntriesLoadingMore = false;
        state.objectShowHistory = false;
      } else if (res.card.cardFreshness?.status !== "hard_stale") {
        state.objectStaleCardExpanded = false;
        state.objectStaleCardHistoricMd = null;
      }
      // If initial loadObjectEntries failed or used a non-canonical ref and returned empty while counts.total > 0, retry with canonical ref
      if (streamRes && !streamRes.ok && res.card.ref && res.card.ref !== objRef) {
        await loadObjectEntries(res.card.ref, true, { clearOnFailure: true });
        if (mySeq !== state.selectObjectSeq) return false;
      }
      if (openInspector) {
        state.inspectorOpen = true;
      } else if (!state.inspectorPinned) {
        state.inspectorOpen = false;
      }
      if (!opts.skipUrlSync) syncUrlFromState(Boolean(opts.replaceUrl));
      if (!opts.skipRender) render();
      return true;
    }
  } catch (err) {
    if (mySeq === state.selectObjectSeq && !opts.silent) {
      showToast(err?.message || st("loadObjectFailed"));
    }
  }
  return false;
}

async function fetchFlatEntry(entryId) {
  const [showRes, chainRes] = await Promise.all([
    client.show(entryId, { full: true }),
    entryId.startsWith("rec_") ? client.chain(entryId).catch(() => null) : Promise.resolve(null),
  ]);
  if (showRes?.refType !== "entry") return null;
  const e = showRes.entry;
  const linkedMeta = {
    objectIds: Array.isArray(e.objectIds) ? e.objectIds : [],
    objectRefs: Array.isArray(e.objectRefs) ? e.objectRefs : [],
    resourceTags: Array.isArray(e.resourceTags) ? e.resourceTags : [],
  };
  const flat = e.kind === "record"
    ? { ...e.record, ...linkedMeta, realmPath: e.realmPath, body: showRes.content }
    : e.kind === "seabed"
      ? { ...e.seabed, ...linkedMeta, realmPath: e.realmPath, title: e.seabed.kind + ":" + e.seabed.id, body: showRes.content }
      : { id: entryId, title: entryId, ...linkedMeta, body: showRes.content };
  return { flat, chainRes };
}

function pickInitialReaderView(flat, requestedView) {
  const rawBody = String(flat?.body || flat?.snippet || "");
  const payloadIdx = rawBody.indexOf("\n## Payload\n");
  const mainBody = payloadIdx >= 0 ? rawBody.slice(0, payloadIdx).trim() : rawBody;
  const isHtmlDoc = looksLikeHtmlDoc(mainBody, flat?.sourceRef);
  if (requestedView === "raw") return "raw";
  if (requestedView === "html" && isHtmlDoc) return "html";
  if (requestedView === "md") return "md";
  return isHtmlDoc ? "html" : "md";
}

async function openEntryInCenter(entryId, opts = {}) {
  try {
    if (!state.openEntry) {
      const wsScroll = document.querySelector(".workspace-scroll");
      if (wsScroll) state.savedListScrollTop = wsScroll.scrollTop;
    }
    const fetched = await fetchFlatEntry(entryId);
    if (!fetched) return;
    const { flat, chainRes } = fetched;
    const activeObj = state.selectedObject || state.previousObject;
    if (opts.fromObject === false) {
      state.previousObject = null;
    } else if ((opts.fromObject || state.selectedObject) && activeObj) {
      state.previousObject = activeObj;
    } else if (!state.previousObject) {
      state.previousObject = null;
    }
    state.selectedObject = null;
    state.focusedObjectRef = null;
    state.openEntry = flat;
    state.focusedEntryId = flat.id;
    state.focusedEntry = flat;
    state.selectedChain = chainRes;
    state.railCliCommand = null;
    state.readerView = pickInitialReaderView(flat, opts.requestedView || null);
    if (window.innerWidth > 1120) {
      state.inspectorOpen = true;
    }
    if (flat.realmPath && state.realms.some((r) => r.path === flat.realmPath)) {
      expandAncestorsForPath(flat.realmPath);
    }
    if (!opts.skipUrlSync) {
      syncUrlFromState(Boolean(opts.replaceUrl));
    }
    render();
  } catch (err) {
    showToast(err?.message || st("loadEntryFailed"));
  }
}

function closeReaderToList(opts = {}) {
  if (!state.openEntry) return;
  teardownStudioReader();
  const returnObj = opts.ignorePreviousObject ? null : state.previousObject;
  state.previousObject = null;
  state.openEntry = null;
  state.focusedEntryId = null;
  state.focusedEntry = null;
  state.selectedChain = null;
  state.railCliCommand = null;
  if (returnObj) {
    state.selectedObject = returnObj;
    state.focusedObjectRef = returnObj.ref || null;
  }
  state.restoreListScrollPending = true;
  if (!state.inspectorPinned) {
    state.inspectorOpen = false;
  }
  if (!opts.skipUrlSync) {
    syncUrlFromState(Boolean(opts.replaceUrl));
  }
  render();
}

async function focusEntryInList(entryId, summaryHint = null) {
  state.focusedEntryId = entryId;
  state.selectedObject = null;
  state.focusedObjectRef = null;
  state.railCliCommand = null;
  if (summaryHint) {
    state.focusedEntry = summaryHint;
  }
  if (window.innerWidth > 1120) {
    state.inspectorOpen = true;
  }
  render();
  requestAnimationFrame(() => {
    const rowEl = document.querySelector('[data-list-entry-id="' + CSS.escape(entryId) + '"]');
    if (rowEl && typeof rowEl.scrollIntoView === "function") {
      rowEl.scrollIntoView({ block: "nearest" });
    }
  });
  try {
    const fetched = await fetchFlatEntry(entryId);
    if (!fetched || state.focusedEntryId !== entryId) return;
    state.focusedEntry = fetched.flat;
    state.selectedChain = fetched.chainRes;
    render();
  } catch {
    // keep summary hint if full fetch fails quietly
  }
}

async function selectEntryById(entryId, _openInspector = true, fromObject = false) {
  await openEntryInCenter(entryId, { fromObject });
}

async function refreshAll(opts = {}) {
  const startSeq = state.selectRealmSeq;
  ensureCollapsedRealmsLoaded();
  const [treeRes, pulseRes] = await Promise.all([
    client.tree({ ref: "/", depth: "all", objects: false }),
    client.pulse.list().catch(() => ({ pulses: [] })),
  ]);
  if (opts.background && state.selectRealmSeq !== startSeq) return;
  state.realms = treeRes.realms || [];
  state.realmTree = Array.isArray(treeRes.realmTree) ? treeRes.realmTree : [];
  state.realmCounts = flattenRealmTreeCounts(state.realmTree);
  applyPulsePayload(pulseRes, false);
  state.hasInboxRealm = state.realms.some((r) => r.path === "/inbox");
  if (state.hasInboxRealm) {
    const lsInbox = await client.ls({ ref: "/inbox", only: "entries", limit: 50 }).catch(() => ({ items: [] }));
    if (opts.background && state.selectRealmSeq !== startSeq) return;
    state.inboxEntries = lsInbox.items || [];
  } else {
    state.inboxEntries = [];
  }
  const desiredRealm = opts.realmPath || state.activeRealmPath;
  const targetPath = state.realms.some((r) => r.path === desiredRealm)
    ? desiredRealm
    : (state.realms[0]?.path || "/");
  const activeObjRef = state.selectedObject?.ref || null;
  const keepCount = Boolean(
    opts.preserveLoadedCount ?? (targetPath === state.activeRealmPath && state.realmEntries.length > 25),
  );
  await selectRealm(targetPath, opts.tab || state.activeTab, {
    keepReader: Boolean(opts.keepReader ?? state.openEntry),
    keepObject: Boolean(opts.keepObject ?? activeObjRef),
    preserveLoadedCount: keepCount,
    skipUrlSync: Boolean(opts.skipUrlSync),
    replaceUrl: Boolean(opts.replaceUrl),
    background: Boolean(opts.background),
  });
  if (activeObjRef && state.selectedObject?.ref === activeObjRef && !state.openEntry) {
    await selectObjectByRef(activeObjRef, false, {
      skipUrlSync: true,
      preserveLoadedCount: state.objectEntries.length > 25,
      silent: Boolean(opts.background),
    });
  }
}

function openWriteModal() {
  closePopover();
  state.writeError = null;
  state.modal = "write";
  renderModalLayer();
  const inp = document.getElementById("composer-title-input");
  if (inp) inp.focus();
}

/* ==================== Clean Studio Entry Row Builder ==================== */

function buildStudioEntryRow(item, opts = {}) {
  const isRedacted = Boolean(item.redactedAt) || item.status === "retracted";
  const km = kindMeta(item.extKind || item.kind);
  const sm = statusMeta(item.status, isRedacted);
  const isSelected = state.focusedEntryId === item.id;

  const row = document.createElement("div");
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.className = "studio-entry-row" +
    (isSelected ? " selected" : "") +
    (isRedacted ? " redacted" : "") +
    (opts.compact ? " compact" : "");
  row.dataset.listEntryId = item.id;
  row.dataset.ui = "studio-entry-row";

  const iconCol = document.createElement("span");
  iconCol.className = "studio-entry-icon kind-" + km.key;
  iconCol.title = km.label;
  iconCol.setAttribute("aria-label", km.label);
  iconCol.appendChild(km.icon(15));
  row.appendChild(iconCol);

  const mainCol = document.createElement("div");
  mainCol.className = "studio-entry-main";

  const headLine = document.createElement("div");
  headLine.className = "studio-entry-head";

  const titleEl = document.createElement("span");
  titleEl.className = "studio-entry-title";
  titleEl.textContent = isRedacted ? st("redactedTitle") : String(item.title || st("kindEntry"));
  headLine.appendChild(titleEl);

  if (sm.notable) {
    const statusPill = document.createElement("span");
    statusPill.className = "studio-entry-status status-" + sm.key;
    statusPill.textContent = sm.label;
    headLine.appendChild(statusPill);
  }
  mainCol.appendChild(headLine);

  const excerptRaw = isRedacted
    ? ""
    : String(item.snippet ?? item.body ?? item.payload?.body ?? item.text ?? "").replace(/\s+/g, " ").trim();
  if (excerptRaw) {
    const excerpt = document.createElement("p");
    excerpt.className = "studio-entry-excerpt";
    excerpt.textContent = excerptRaw;
    mainCol.appendChild(excerpt);
  }

  const metaLine = document.createElement("div");
  metaLine.className = "studio-entry-meta";

  const kindText = document.createElement("span");
  kindText.textContent = km.label;
  metaLine.appendChild(kindText);

  const authorName = formatAuthorName(item);
  if (authorName) {
    const sep1 = document.createElement("span");
    sep1.className = "meta-sep";
    sep1.setAttribute("aria-hidden", "true");
    sep1.textContent = "·";
    const authEl = document.createElement("span");
    authEl.textContent = authorName;
    metaLine.appendChild(sep1);
    metaLine.appendChild(authEl);
  }

  const tsIso = item.occurredAt || item.createdAt || "";
  if (tsIso) {
    const sep2 = document.createElement("span");
    sep2.className = "meta-sep";
    sep2.setAttribute("aria-hidden", "true");
    sep2.textContent = "·";
    const timeEl = document.createElement("time");
    timeEl.setAttribute("datetime", String(tsIso));
    timeEl.title = formatStamp(tsIso);
    timeEl.textContent = formatRelativeTime(tsIso);
    metaLine.appendChild(sep2);
    metaLine.appendChild(timeEl);
  }

  const objChips = !isRedacted ? getEntryObjectChips(item) : [];
  if (objChips.length > 0) {
    const chipsWrap = document.createElement("span");
    chipsWrap.className = "entry-object-chips";
    for (const chip of objChips.slice(0, 4)) {
      const chipBtn = document.createElement("button");
      chipBtn.type = "button";
      chipBtn.className = "entry-object-chip";
      chipBtn.dataset.ui = "entry-object-chip";
      chipBtn.dataset.objectRef = chip.ref;
      chipBtn.textContent = chip.label;
      chipBtn.title = chip.ref;
      chipBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void selectObjectByRef(chip.ref, false);
      });
      chipsWrap.appendChild(chipBtn);
    }
    metaLine.appendChild(chipsWrap);
  }

  mainCol.appendChild(metaLine);
  row.appendChild(mainCol);

  const openRow = () => {
    const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
    if (sel && String(sel).trim().length > 0) return;
    void openEntryInCenter(item.id, { fromObject: Boolean(opts.fromObject) });
  };
  row.addEventListener("click", openRow);
  row.addEventListener("keydown", (ev) => {
    if (ev.target !== row) return;
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      openRow();
    }
  });

  return row;
}

/* ==================== Component Builders ==================== */

function renderAuthScreen() {
  clearEl(app);
  const screen = document.createElement("main");
  screen.className = "auth-screen";
  const card = document.createElement("section");
  card.className = "auth-card";

  const brand = document.createElement("div");
  brand.className = "brand-identity";
  const mark = document.createElement("span");
  mark.className = "brand-mark";
  mark.appendChild(ICONS.logo());
  const word = document.createElement("span");
  word.className = "brand-wordmark";
  word.textContent = "Meru Mind";
  brand.appendChild(mark);
  brand.appendChild(word);
  card.appendChild(brand);

  const h1 = document.createElement("h1");
  h1.className = "auth-title";
  h1.textContent = state.oidcEnabled ? st("authTitleSso") : st("authTitleCli");
  card.appendChild(h1);

  if (state.oidcEnabled) {
    const pSso = document.createElement("p");
    pSso.className = "auth-desc";
    pSso.textContent = st("authSsoDesc");
    card.appendChild(pSso);

    const returnTo = window.location.pathname + window.location.search;
    const ssoUrl = (state.oidcLoginUrl || "/_meru/oidc/login") +
      "?return_to=" + encodeURIComponent(returnTo || "/");
    const ssoBtn = document.createElement("a");
    ssoBtn.className = "meru-btn primary auth-sso-btn";
    ssoBtn.dataset.ui = "sso-login-btn";
    ssoBtn.href = ssoUrl;
    ssoBtn.textContent = st("authSsoBtn");
    card.appendChild(ssoBtn);

    const div = document.createElement("div");
    div.className = "auth-divider";
    const span = document.createElement("span");
    span.textContent = st("authOrCli");
    div.appendChild(span);
    card.appendChild(div);
  }

  const p = document.createElement("p");
  p.className = "auth-desc";
  p.textContent = state.oidcEnabled ? st("authCliDescSso") : st("authCliDescLocal");
  card.appendChild(p);

  const cmdText = state.oidcEnabled
    ? ("meru-mind login --url " + window.location.origin)
    : ("meru-mind ui login --url " + window.location.origin);
  const cmdRow = document.createElement("div");
  cmdRow.className = "cli-cmd-row";
  const code = document.createElement("code");
  code.className = "cli-cmd-text";
  code.textContent = cmdText;
  cmdRow.appendChild(code);
  cmdRow.appendChild(makeIconBtn(ICONS.copy(), st("copyLoginCmd"), () => copyText(cmdText)));
  card.appendChild(cmdRow);

  screen.appendChild(card);
  app.appendChild(screen);
}

function buildPresencePane() {
  const inFlight = state.inFlight || [];
  const unkeyedPulses = (state.pulses || []).filter((p) => !p.keys || p.keys.length === 0);
  const unkeyedActorGroups = groupPulsesByActor(unkeyedPulses);
  const actorGroups = groupPulsesByActor(state.pulses);

  const presencePane = document.createElement("section");
  presencePane.className = "presence-pane" + (state.presenceCollapsed ? " collapsed" : "");
  presencePane.dataset.ui = "presence-pane";
  presencePane.addEventListener("mouseenter", () => {
    state.presenceHovered = true;
  });
  presencePane.addEventListener("mouseleave", () => {
    state.presenceHovered = false;
    if (state.pendingPulsePatch) {
      const pending = state.pendingPulsePatch;
      applyPulsePayload(pending, false);
      updatePresencePanel();
    }
  });

  const presenceHeader = document.createElement("div");
  presenceHeader.className = "presence-header";

  const toggleSectionBtn = document.createElement("button");
  toggleSectionBtn.type = "button";
  toggleSectionBtn.className = "presence-collapse-btn";
  toggleSectionBtn.dataset.ui = "presence-section-toggle";
  toggleSectionBtn.setAttribute("aria-expanded", String(!state.presenceCollapsed));
  toggleSectionBtn.appendChild(state.presenceCollapsed ? ICONS.chevronRight() : ICONS.chevronDown());
  const pLbl = document.createElement("span");
  pLbl.textContent = st("presence");
  toggleSectionBtn.appendChild(pLbl);
  if (state.pulses.length > 0) {
    const totalCnt = document.createElement("span");
    totalCnt.className = "realm-count-muted";
    totalCnt.textContent = String(state.pulses.length);
    toggleSectionBtn.appendChild(totalCnt);
  }
  toggleSectionBtn.addEventListener("click", () => {
    state.presenceCollapsed = !state.presenceCollapsed;
    closePopover();
    updatePresencePanel();
  });
  presenceHeader.appendChild(toggleSectionBtn);

  const pScroll = !state.presenceCollapsed ? document.createElement("div") : null;
  if (pScroll) {
    pScroll.className = "presence-scroll";
    pScroll.dataset.ui = "presence-scroll";
  }

  function buildFlatActorRow(g) {
    const row = document.createElement("div");
    row.className = "member-row presence-flat-actor-row";
    row.dataset.actorId = g.actorId;
    row.tabIndex = 0;

    const left = document.createElement("div");
    left.className = "member-left";
    const av = document.createElement("span");
    av.className = "member-avatar";
    av.appendChild(ICONS.user());
    const nm = document.createElement("span");
    nm.className = "member-name";
    nm.textContent = g.actorId;
    const dot = document.createElement("span");
    dot.className = "status-dot" + (g.online ? "" : (g.active ? " active" : " idle"));
    const countLabel = g.sessions.length + " " + (g.sessions.length === 1 ? st("sessionSingle") : st("sessionsPlural"));
    const actorKindLabel = g.actorKind === "human" ? st("actorHumanMember") : st("actorAgent");
    const tip = [g.actorId, actorKindLabel, countLabel].filter(Boolean).join(" · ");
    dot.title = tip;
    row.title = tip;
    left.appendChild(av);
    left.appendChild(nm);
    left.appendChild(dot);

    const rightWrap = document.createElement("div");
    rightWrap.className = "member-right";
    if (g.sessions.length > 1) {
      const cnt = document.createElement("span");
      cnt.className = "realm-count-muted";
      cnt.textContent = String(g.sessions.length);
      rightWrap.appendChild(cnt);
    }
    const dotsBtn = document.createElement("button");
    dotsBtn.type = "button";
    dotsBtn.className = "row-dots-btn";
    dotsBtn.title = st("memberActions");
    dotsBtn.setAttribute("aria-label", st("memberActions") + " " + g.actorId);
    dotsBtn.appendChild(ICONS.dots());
    dotsBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.popover = {
        kind: "member-menu",
        anchorRect: rectOf(dotsBtn),
        placement: "right",
        group: g,
        pulse: g.sessions[0],
      };
      renderPopoverLayer();
    });
    rightWrap.appendChild(dotsBtn);

    row.appendChild(left);
    row.appendChild(rightWrap);
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.popover = {
        kind: "member-card",
        anchorRect: rectOf(row),
        placement: "right",
        group: g,
        pulse: g.sessions[0],
      };
      renderPopoverLayer();
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      state.popover = {
        kind: "member-menu",
        anchorRect: pointRect(ev.clientX, ev.clientY),
        placement: "right",
        group: g,
        pulse: g.sessions[0],
      };
      renderPopoverLayer();
    });
    return row;
  }

  let scrollLoadBound = false;
  function populatePresenceScroll(animate) {
    if (!pScroll) return;
    pScroll.textContent = "";
    pScroll.classList.remove("meru-panel-enter");
    if (animate) {
      void pScroll.offsetWidth;
      pScroll.classList.add("meru-panel-enter");
    }

    if (state.presenceMode === "in-flight") {
      if (inFlight.length === 0 && unkeyedPulses.length === 0) {
        const empty = document.createElement("div");
        empty.className = "presence-empty";
        empty.textContent = st("noPresence");
        pScroll.appendChild(empty);
      } else {
        for (const w of inFlight.slice(0, 12)) {
          const row = document.createElement("div");
          row.className = "member-row work-flight-row" + (w.hasCollision ? " has-collision" : "");
          row.dataset.workKey = w.key;
          row.tabIndex = 0;

          const left = document.createElement("div");
          left.className = "member-left";
          const av = document.createElement("span");
          av.className = "member-avatar" + (w.hasCollision ? " collision" : "");
          av.appendChild(w.hasCollision ? ICONS.collision() : ICONS.work());
          const nm = document.createElement("span");
          nm.className = "member-name";
          nm.textContent = w.label;
          const anyOnline = w.participants.some((p) => p.online || p.state === "working");
          const anyActive = w.participants.some((p) => p.active);
          const dot = document.createElement("span");
          dot.className = "status-dot" + (w.hasCollision ? " collision" : (anyOnline ? "" : (anyActive ? " active" : " idle")));
          const tip = [
            w.key,
            w.hasCollision ? (w.workingRoots + " " + st("collisionNote")) : (w.participants.length + " " + (w.participants.length === 1 ? st("sessionSingle") : st("sessionsPlural"))),
            w.realms.join(", "),
          ].filter(Boolean).join(" · ");
          row.title = tip;
          dot.title = tip;
          left.appendChild(av);
          left.appendChild(nm);
          left.appendChild(dot);

          const rightWrap = document.createElement("div");
          rightWrap.className = "member-right";
          if (w.participants.length > 1) {
            const cnt = document.createElement("span");
            cnt.className = "realm-count-muted";
            cnt.textContent = String(w.participants.length);
            rightWrap.appendChild(cnt);
          }
          const dotsBtn = document.createElement("button");
          dotsBtn.type = "button";
          dotsBtn.className = "row-dots-btn";
          dotsBtn.title = st("inspectWork");
          dotsBtn.setAttribute("aria-label", st("inspectWork") + " " + w.label);
          dotsBtn.appendChild(ICONS.dots());
          dotsBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.popover = {
              kind: "work-card",
              anchorRect: rectOf(dotsBtn),
              placement: "right",
              work: w,
            };
            renderPopoverLayer();
          });
          rightWrap.appendChild(dotsBtn);

          row.appendChild(left);
          row.appendChild(rightWrap);
          row.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.popover = {
              kind: "work-card",
              anchorRect: rectOf(row),
              placement: "right",
              work: w,
            };
            renderPopoverLayer();
          });
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            state.popover = {
              kind: "work-card",
              anchorRect: pointRect(ev.clientX, ev.clientY),
              placement: "right",
              work: w,
            };
            renderPopoverLayer();
          });
          pScroll.appendChild(row);
        }

        if (unkeyedPulses.length > 0) {
          if (inFlight.length === 0) {
            const hint = document.createElement("div");
            hint.className = "presence-section-hint";
            hint.dataset.ui = "presence-no-active-tasks";
            hint.textContent = st("noActiveTasks");
            pScroll.appendChild(hint);
          } else {
            const divider = document.createElement("div");
            divider.className = "presence-section-divider";
            divider.dataset.ui = "presence-unkeyed-section";
            divider.textContent = st("unkeyedSection") + " · " + unkeyedPulses.length;
            pScroll.appendChild(divider);
          }
          for (const g of unkeyedActorGroups) {
            pScroll.appendChild(buildFlatActorRow(g));
          }
        }
      }
    } else {
      if (actorGroups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "presence-empty";
        empty.textContent = st("noPresence");
        pScroll.appendChild(empty);
      } else {
        const expandableActorsWithMore = [];
        for (const g of actorGroups) {
          const isActorCollapsed = state.collapsedActorIds.has(g.actorId);
          const visibleLimit = state.actorVisibleCounts.get(g.actorId) || ACTOR_SESSION_PAGE_SIZE;
          const bucketCounts = countSessionClientBuckets(g.sessions);

          const groupEl = document.createElement("div");
          groupEl.className = "presence-actor-group";
          groupEl.dataset.actorGroup = g.actorId;

          const row = document.createElement("div");
          row.className = "member-row presence-actor-row";
          row.dataset.actorId = g.actorId;
          row.tabIndex = 0;

          const left = document.createElement("div");
          left.className = "member-left";

          const chev = document.createElement("button");
          chev.type = "button";
          chev.className = "realm-chevron-btn";
          chev.dataset.ui = "actor-chevron";
          chev.dataset.actorId = g.actorId;
          chev.setAttribute("aria-expanded", String(!isActorCollapsed));
          chev.title = (isActorCollapsed ? st("expandActor") : st("collapseActor")) + " " + g.actorId;
          chev.setAttribute("aria-label", chev.title);
          chev.appendChild(isActorCollapsed ? ICONS.chevronRight() : ICONS.chevronDown());
          chev.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.presenceScrollTop = pScroll.scrollTop;
            if (state.collapsedActorIds.has(g.actorId)) {
              state.collapsedActorIds.delete(g.actorId);
            } else {
              state.collapsedActorIds.add(g.actorId);
            }
            populatePresenceScroll(false);
          });

          const av = document.createElement("span");
          av.className = "member-avatar";
          av.appendChild(ICONS.user());
          const nm = document.createElement("span");
          nm.className = "member-name";
          nm.textContent = g.actorId;
          const dot = document.createElement("span");
          dot.className = "status-dot" + (g.online ? "" : (g.active ? " active" : " idle"));
          const countLabel = g.sessions.length + " " + (g.sessions.length === 1 ? st("sessionSingle") : st("sessionsPlural"));
          const actorKindLabel = g.actorKind === "human" ? st("actorHumanMember") : st("actorAgent");
          const tip = [g.actorId, actorKindLabel, countLabel].filter(Boolean).join(" · ");
          dot.title = tip;
          row.title = tip;
          left.appendChild(chev);
          left.appendChild(av);
          left.appendChild(nm);
          left.appendChild(dot);

          const rightWrap = document.createElement("div");
          rightWrap.className = "member-right";
          if (g.sessions.length > 1) {
            const cnt = document.createElement("span");
            cnt.className = "realm-count-muted";
            cnt.textContent = String(g.sessions.length);
            rightWrap.appendChild(cnt);
          }
          const dotsBtn = document.createElement("button");
          dotsBtn.type = "button";
          dotsBtn.className = "row-dots-btn";
          dotsBtn.title = st("memberActions");
          dotsBtn.setAttribute("aria-label", st("memberActions") + " " + g.actorId);
          dotsBtn.appendChild(ICONS.dots());
          dotsBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.popover = {
              kind: "member-menu",
              anchorRect: rectOf(dotsBtn),
              placement: "right",
              group: g,
              pulse: g.sessions[0],
            };
            renderPopoverLayer();
          });
          rightWrap.appendChild(dotsBtn);

          row.appendChild(left);
          row.appendChild(rightWrap);

          row.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.popover = {
              kind: "member-card",
              anchorRect: rectOf(row),
              placement: "right",
              group: g,
              pulse: g.sessions[0],
            };
            renderPopoverLayer();
          });
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            state.popover = {
              kind: "member-menu",
              anchorRect: pointRect(ev.clientX, ev.clientY),
              placement: "right",
              group: g,
              pulse: g.sessions[0],
            };
            renderPopoverLayer();
          });
          groupEl.appendChild(row);

          if (!isActorCollapsed) {
            const sessList = document.createElement("div");
            sessList.className = "presence-actor-sessions";
            sessList.dataset.actorSessions = g.actorId;
            const visibleSessions = g.sessions.slice(0, visibleLimit);
            for (const s of visibleSessions) {
              const sBtn = document.createElement("button");
              sBtn.type = "button";
              sBtn.className = "presence-session-row";
              sBtn.dataset.sessionId = s.sessionId;
              const sDot = document.createElement("span");
              sDot.className = "status-dot" + (s.state === "working" || s.online ? "" : (s.state === "turn_ended" ? " paused" : (s.active ? " active" : " idle")));
              const sLabel = document.createElement("span");
              sLabel.className = "presence-session-label";
              sLabel.textContent = formatSessionDisplayLabel(s, bucketCounts, { showActor: false });
              const sDetail = document.createElement("span");
              sDetail.className = "presence-session-detail";
              sDetail.textContent = s.activity || s.note || formatHumanRealmPath(s.realmPath || "/");
              sBtn.title = [sLabel.textContent, s.sessionId || "", formatHumanRealmPath(s.realmPath || "/"), s.activity || s.note || ""].filter(Boolean).join(" · ");
              sBtn.appendChild(sDot);
              sBtn.appendChild(sLabel);
              sBtn.appendChild(sDetail);
              sBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                state.popover = {
                  kind: "member-card",
                  anchorRect: rectOf(sBtn),
                  placement: "right",
                  group: g,
                  pulse: s,
                };
                renderPopoverLayer();
              });
              sessList.appendChild(sBtn);
            }

            const remaining = g.sessions.length - visibleSessions.length;
            if (remaining > 0) {
              expandableActorsWithMore.push(g.actorId);
              const moreBtn = document.createElement("button");
              moreBtn.type = "button";
              moreBtn.className = "presence-load-more-btn";
              moreBtn.dataset.ui = "presence-load-more";
              moreBtn.dataset.actorId = g.actorId;
              moreBtn.textContent = st("loadMoreSessions") + " (+" + remaining + ")";
              moreBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                state.presenceScrollTop = pScroll.scrollTop;
                state.actorVisibleCounts.set(g.actorId, visibleLimit + ACTOR_SESSION_PAGE_SIZE);
                populatePresenceScroll(false);
              });
              sessList.appendChild(moreBtn);
            }
            groupEl.appendChild(sessList);
          }

          pScroll.appendChild(groupEl);
        }

        if (expandableActorsWithMore.length > 0 && !scrollLoadBound) {
          scrollLoadBound = true;
          pScroll.addEventListener("scroll", () => {
            state.presenceScrollTop = pScroll.scrollTop;
            const nearBottom = pScroll.scrollTop + pScroll.clientHeight >= pScroll.scrollHeight - 24;
            if (!nearBottom) return;
            for (const g of actorGroups) {
              if (state.collapsedActorIds.has(g.actorId)) continue;
              const cur = state.actorVisibleCounts.get(g.actorId) || ACTOR_SESSION_PAGE_SIZE;
              if (g.sessions.length > cur) {
                state.actorVisibleCounts.set(g.actorId, cur + ACTOR_SESSION_PAGE_SIZE);
                populatePresenceScroll(false);
                break;
              }
            }
          });
        }
      }
    }
  }

  if (!state.presenceCollapsed) {
    const seg = createIconSwitch({
      uiId: "presence-mode-switch",
      ariaLabel: st("presenceGrouping"),
      options: [
        { key: "in-flight", label: st("inFlight"), icon: ICONS.work },
        { key: "people", label: st("people"), icon: ICONS.users },
      ],
      activeKey: state.presenceMode,
      datasetKey: "presenceMode",
      onChange: (mKey) => {
        state.presenceMode = mKey;
        state.presenceModeUserSet = true;
        state.presenceScrollTop = 0;
        closePopover();
        populatePresenceScroll(true);
        if (pScroll) pScroll.scrollTop = 0;
      },
    });
    presenceHeader.appendChild(seg);
  }
  presencePane.appendChild(presenceHeader);

  if (pScroll) {
    populatePresenceScroll(false);
    presencePane.appendChild(pScroll);
    if (state.presenceScrollTop > 0) {
      pScroll.scrollTop = state.presenceScrollTop;
    }
  }

  return presencePane;
}

function updatePresencePanel() {
  const existing = document.querySelector('[data-ui="presence-pane"]');
  if (!existing) return;
  const prevScroll = existing.querySelector(".presence-scroll")?.scrollTop || 0;
  state.presenceScrollTop = prevScroll;
  const next = buildPresencePane();
  existing.replaceWith(next);
  const nextScroll = next.querySelector(".presence-scroll");
  if (nextScroll) nextScroll.scrollTop = prevScroll;
}

function replaceSidebarInPlace() {
  const existing = document.querySelector(".studio-sidebar");
  if (!existing) return;
  const realmTop = existing.querySelector(".sidebar-scroll")?.scrollTop || 0;
  const presenceTop = existing.querySelector(".presence-scroll")?.scrollTop || 0;
  state.presenceScrollTop = presenceTop;
  const next = buildSidebar();
  existing.replaceWith(next);
  const nextRealmScroll = next.querySelector(".sidebar-scroll");
  if (nextRealmScroll) nextRealmScroll.scrollTop = realmTop;
  const nextPresenceScroll = next.querySelector(".presence-scroll");
  if (nextPresenceScroll) nextPresenceScroll.scrollTop = presenceTop;
}

function buildSidebar() {
  const aside = document.createElement("aside");
  aside.className = "studio-sidebar";

  const brandBar = document.createElement("div");
  brandBar.className = "brand-bar";

  const identity = document.createElement("div");
  identity.className = "brand-identity";
  const mark = document.createElement("span");
  mark.className = "brand-mark";
  mark.appendChild(ICONS.logo());
  const word = document.createElement("span");
  word.className = "brand-wordmark";
  word.textContent = "Meru Mind";
  const lamp = document.createElement("span");
  lamp.className = "ws-lamp";
  lamp.dataset.ui = "ws-connection-status";
  lamp.dataset.status = state.pumpStatus;
  lamp.title = st("realtimeStatusPrefix") + ": " + realtimeStatusLabel(state.pumpStatus);
  identity.appendChild(mark);
  identity.appendChild(word);
  identity.appendChild(lamp);
  brandBar.appendChild(identity);
  aside.appendChild(brandBar);

  const scroll = document.createElement("div");
  scroll.className = "sidebar-scroll sidebar-realms-scroll";

  const realmLabel = document.createElement("div");
  realmLabel.className = "nav-group-label";
  realmLabel.textContent = st("realms");
  scroll.appendChild(realmLabel);

  ensureCollapsedRealmsLoaded();
  const activeRealmSet = new Set();
  for (const p of state.pulses || []) {
    if (!p.active || p.sessionId === state.selfPulseSessionId) continue;
    if (p.realmPath) activeRealmSet.add(p.realmPath);
  }

  function appendRealmTreeNode(node, depth) {
    const r = node.realm;
    if (!r) return;
    const children = Array.isArray(node.children) ? node.children : [];
    const hasChildren = children.length > 0;
    const isCollapsed = hasChildren && state.collapsedRealmIds.has(r.id);
    const effectiveDepth = r.path === "/inbox" ? 0 : Math.min(depth, 5);

    const row = document.createElement("div");
    row.className = "realm-row realm-depth-" + effectiveDepth + (r.path === state.activeRealmPath ? " active" : "");
    row.dataset.realmPath = r.path;
    row.dataset.realmId = r.id;

    if (hasChildren) {
      const chev = document.createElement("button");
      chev.type = "button";
      chev.className = "realm-chevron-btn";
      chev.dataset.ui = "realm-chevron";
      chev.dataset.realmId = r.id;
      chev.dataset.realmPath = r.path;
      chev.setAttribute("aria-expanded", String(!isCollapsed));
      const chevLabel = (isCollapsed ? st("expandRealm") : st("collapseRealm")) + ": " + r.path;
      chev.title = chevLabel;
      chev.setAttribute("aria-label", chevLabel);
      chev.appendChild(isCollapsed ? ICONS.chevronRight() : ICONS.chevronDown());
      chev.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleRealmCollapsed(r.id);
      });
      row.appendChild(chev);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "realm-chevron-spacer";
      spacer.setAttribute("aria-hidden", "true");
      row.appendChild(spacer);
    }

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "realm-select-btn";
    selectBtn.dataset.realmPath = r.path;

    const left = document.createElement("span");
    left.className = "realm-row-left";
    const ico = document.createElement("span");
    ico.className = "realm-icon";
    ico.appendChild(r.path === "/inbox" ? ICONS.inbox() : ICONS.realm());
    const name = document.createElement("span");
    name.className = "realm-label";
    if (r.path === "/") {
      name.textContent = st("rootRealm") + " (/)";
    } else if (r.path === "/inbox") {
      name.textContent = st("tabInbox");
    } else if (pathDepth(r.path) >= 2) {
      name.textContent = r.slug || r.path.split("/").pop();
    } else {
      name.textContent = r.path;
    }
    name.title = (r.name || r.path) + " (" + r.path + ")";
    left.appendChild(ico);
    left.appendChild(name);
    selectBtn.appendChild(left);

    const rightMeta = document.createElement("span");
    rightMeta.className = "realm-row-right";
    const directActive = activeRealmSet.has(r.path);
    const activeDescendants = isCollapsed
      ? collectActiveDescendantPaths(node, activeRealmSet)
      : [];
    if (directActive || activeDescendants.length > 0) {
      const liveDot = document.createElement("span");
      liveDot.className = "status-dot realm-live-dot";
      liveDot.dataset.ui = "realm-live-dot";
      if (!directActive && activeDescendants.length > 0) {
        liveDot.dataset.inherited = "true";
        liveDot.title = st("activeInChildren") + ": " + activeDescendants.join(", ");
      } else {
        liveDot.title = st("activeHere");
      }
      rightMeta.appendChild(liveDot);
    }

    const rc = state.realmCounts[r.path] || node.counts;
    if (r.path === "/inbox" && state.inboxEntries.length > 0) {
      const cnt = document.createElement("span");
      cnt.className = "queue-count";
      cnt.textContent = String(state.inboxEntries.length);
      rightMeta.appendChild(cnt);
    } else if (rc && (rc.subtreeConclusions || rc.directConclusions)) {
      const cnt = document.createElement("span");
      cnt.className = "realm-count-muted";
      cnt.textContent = fmtNum(
        r.path === "/" || isCollapsed
          ? (rc.subtreeConclusions || rc.directConclusions)
          : (rc.directConclusions || rc.subtreeConclusions),
      );
      rightMeta.appendChild(cnt);
    }
    if (rightMeta.childNodes.length > 0) {
      selectBtn.appendChild(rightMeta);
    }

    selectBtn.addEventListener("click", () => { void selectRealm(r.path); });
    row.appendChild(selectBtn);
    scroll.appendChild(row);

    if (hasChildren && !isCollapsed) {
      for (const child of children) {
        appendRealmTreeNode(child, effectiveDepth + 1);
      }
    }
  }

  for (const rootNode of getEffectiveRealmTree()) {
    appendRealmTreeNode(rootNode, 0);
  }

  aside.appendChild(scroll);
  aside.appendChild(buildPresencePane());

  const dock = document.createElement("div");
  dock.className = "utility-dock";
  dock.dataset.ui = "utility-dock";

  const profileBtn = document.createElement("button");
  profileBtn.type = "button";
  profileBtn.className = "profile-trigger";
  profileBtn.dataset.ui = "profile-trigger";
  profileBtn.title = st("profileTooltip");
  const myDisplayName = state.whoami.actor.displayName || state.whoami.actor.id;
  const avCircle = document.createElement("span");
  avCircle.className = "avatar-circle";
  avCircle.textContent = String(myDisplayName || "U").slice(0, 1).toUpperCase();
  const actorLabel = document.createElement("span");
  actorLabel.className = "actor-label";
  actorLabel.textContent = myDisplayName;
  profileBtn.appendChild(avCircle);
  profileBtn.appendChild(actorLabel);
  profileBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (state.popover && state.popover.kind === "profile") {
      closePopover();
      return;
    }
    state.popover = {
      kind: "profile",
      anchorRect: rectOf(profileBtn),
      placement: "above",
    };
    renderPopoverLayer();
  });

  const gearBtn = makeIconBtn(ICONS.settings(), st("settingsTooltip"), () => {
    closePopover();
    state.modal = "settings";
    renderModalLayer();
  });
  gearBtn.dataset.ui = "settings-trigger";

  dock.appendChild(profileBtn);
  dock.appendChild(gearBtn);
  aside.appendChild(dock);

  return aside;
}

function buildTopbar() {
  const header = document.createElement("header");
  header.className = "studio-topbar";

  const left = document.createElement("div");
  left.className = "topbar-left";

  const menuBtn = makeIconBtn(ICONS.menu(), st("toggleNav"), () => {
    state.mobileNavOpen = !state.mobileNavOpen;
    render();
  }, "mobile-menu-btn");
  left.appendChild(menuBtn);

  const crumb = document.createElement("span");
  crumb.className = "scope-crumb";
  crumb.textContent = getOrgName() + " / " + (state.activeRealmPath === "/" ? st("rootRealm") : state.activeRealmPath.slice(1));
  left.appendChild(crumb);

  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "search-trigger";
  searchBtn.dataset.ui = "global-search-trigger";
  const sLeft = document.createElement("span");
  sLeft.className = "search-trigger-left";
  sLeft.appendChild(ICONS.search());
  const sText = document.createElement("span");
  sText.textContent = st("searchPrompt");
  sLeft.appendChild(sText);
  const kbd = document.createElement("span");
  kbd.className = "kbd-hint";
  kbd.textContent = "⌘K";
  searchBtn.appendChild(sLeft);
  searchBtn.appendChild(kbd);
  searchBtn.addEventListener("click", openSearchModal);

  const actions = document.createElement("div");
  actions.className = "topbar-actions";
  const newBtn = makeIconBtn(ICONS.plus(), st("newEntryTooltip"), () => {
    openWriteModal();
  });
  newBtn.dataset.ui = "new-entry-trigger";
  actions.appendChild(newBtn);

  actions.appendChild(makeIconBtn(ICONS.refresh(), st("refreshTooltip"), () => {
    void refreshAll();
  }));

  const inspectorBtn = makeIconBtn(
    ICONS.panelRight(),
    state.inspectorOpen ? st("hideInspectorTooltip") : st("showInspectorTooltip"),
    () => {
      state.inspectorOpen = !state.inspectorOpen;
      state.inspectorPinned = state.inspectorOpen;
      render();
    },
    state.inspectorOpen ? "active" : "",
  );
  inspectorBtn.dataset.ui = "inspector-toggle";
  actions.appendChild(inspectorBtn);

  header.appendChild(left);
  header.appendChild(searchBtn);
  header.appendChild(actions);
  return header;
}

/* ==================== Workspace Tab Sections ==================== */

function buildRulesWhisperBanner(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const box = document.createElement("div");
  box.className = "rules-whisper-banner" + (state.rulesBannerExpanded ? " expanded" : "");
  box.dataset.ui = "rules-whisper-banner";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "rules-whisper-toggle";
  toggleBtn.setAttribute("aria-expanded", String(state.rulesBannerExpanded));
  toggleBtn.title = state.rulesBannerExpanded ? st("rulesBannerCollapse") : st("rulesBannerHint");

  const left = document.createElement("span");
  left.className = "rules-whisper-left";
  left.appendChild(ICONS.kindRule(14));
  const txt = document.createElement("span");
  txt.textContent = st("rulesBannerCount", rules.length);
  left.appendChild(txt);

  const chev = document.createElement("span");
  chev.className = "rules-whisper-chev";
  chev.appendChild(state.rulesBannerExpanded ? ICONS.chevronDown() : ICONS.chevronRight());

  toggleBtn.appendChild(left);
  toggleBtn.appendChild(chev);
  toggleBtn.addEventListener("click", () => {
    state.rulesBannerExpanded = !state.rulesBannerExpanded;
    render();
  });
  box.appendChild(toggleBtn);

  if (state.rulesBannerExpanded) {
    const list = document.createElement("div");
    list.className = "rules-whisper-list";
    rules.forEach((rule, idx) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "rule-row compact" + (state.focusedEntryId === rule.id ? " selected" : "");
      row.dataset.ruleId = rule.id;
      row.dataset.listEntryId = rule.id;

      const num = document.createElement("span");
      num.className = "rule-idx";
      num.textContent = String(idx + 1);

      const title = document.createElement("span");
      title.className = "rule-title";
      title.textContent = rule.title;

      const origin = document.createElement("span");
      origin.className = "origin-tag";
      origin.textContent = rule.inherited ? st("ruleInherited") : st("ruleLocal");

      row.appendChild(num);
      row.appendChild(title);
      row.appendChild(origin);
      row.addEventListener("click", () => { void openEntryInCenter(rule.id); });
      list.appendChild(row);
    });
    box.appendChild(list);
  }

  return box;
}

function buildRulesSection(rules) {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "rules";

  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "teaching-empty";
    empty.dataset.ui = "empty-rules";

    const ico = document.createElement("div");
    ico.className = "teaching-empty-icon";
    ico.appendChild(ICONS.kindRule(18));
    empty.appendChild(ico);

    const desc = document.createElement("p");
    desc.className = "teaching-empty-desc";
    desc.textContent = st("emptyRulesDesc");
    empty.appendChild(desc);

    const cmdText = 'meru-mind rule add --in ' + state.activeRealmPath + ' --title "..." --body "..." --as-human';
    const cmdRow = document.createElement("div");
    cmdRow.className = "cli-cmd-row teaching-empty-cli";
    const code = document.createElement("code");
    code.className = "cli-cmd-text";
    code.textContent = cmdText;
    code.title = cmdText;
    cmdRow.appendChild(code);
    cmdRow.appendChild(makeIconBtn(ICONS.copy(), st("copyCmd"), () => copyText(cmdText)));
    empty.appendChild(cmdRow);

    sec.appendChild(empty);
    return sec;
  }

  const list = document.createElement("div");
  list.className = "rule-list";
  rules.forEach((rule, idx) => {
    const row = document.createElement("button");
    row.type = "button";
    const isFocused = state.focusedEntryId === rule.id;
    row.className = "rule-row" + (isFocused ? " selected" : "");
    row.dataset.ruleId = rule.id;
    row.dataset.listEntryId = rule.id;

    const num = document.createElement("span");
    num.className = "rule-idx";
    num.textContent = String(idx + 1);

    const title = document.createElement("span");
    title.className = "rule-title";
    title.textContent = rule.title;

    const origin = document.createElement("span");
    origin.className = "origin-tag";
    origin.textContent = rule.inherited ? st("ruleInherited") : st("ruleLocal");

    row.appendChild(num);
    row.appendChild(title);
    row.appendChild(origin);
    row.addEventListener("click", () => { void openEntryInCenter(rule.id); });
    list.appendChild(row);
  });
  sec.appendChild(list);
  return sec;
}

function buildInboxTriageSection() {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "inbox-triage";

  if (state.inboxEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "teaching-empty";
    empty.dataset.ui = "empty-inbox";
    const ico = document.createElement("div");
    ico.className = "teaching-empty-icon";
    ico.appendChild(ICONS.inbox());
    const desc = document.createElement("p");
    desc.className = "teaching-empty-desc";
    desc.textContent = st("emptyInboxDesc");
    empty.appendChild(ico);
    empty.appendChild(desc);
    sec.appendChild(empty);
    return sec;
  }

  const targets = state.realms.filter((r) => r.path !== "/inbox");
  const defaultTarget = targets.find((t) => t.path === "/ops")?.path || targets[0]?.path || "/";
  const stack = document.createElement("div");
  stack.className = "triage-stack";

  for (const item of state.inboxEntries) {
    const wrap = document.createElement("div");
    wrap.className = "triage-item";

    wrap.appendChild(buildStudioEntryRow(item, { compact: true }));

    if (targets.length > 0) {
      const selectedTarget = state.triageTargets.get(item.id) || defaultTarget;
      if (!state.triageTargets.has(item.id)) {
        state.triageTargets.set(item.id, selectedTarget);
      }

      const bar = document.createElement("div");
      bar.className = "triage-controls";

      const destGroup = document.createElement("div");
      destGroup.className = "triage-dest-group";

      // Custom accessible monochrome realm picker (zero native OS <select>)
      const pickerBtn = document.createElement("button");
      pickerBtn.type = "button";
      pickerBtn.className = "realm-picker-trigger";
      pickerBtn.dataset.ui = "triage-realm-picker";
      pickerBtn.setAttribute("aria-haspopup", "listbox");
      pickerBtn.setAttribute("aria-label", st("chooseRealm"));
      const pickerVal = document.createElement("span");
      pickerVal.className = "realm-picker-value";
      pickerVal.textContent = selectedTarget;
      pickerBtn.appendChild(ICONS.realm());
      pickerBtn.appendChild(pickerVal);
      pickerBtn.appendChild(ICONS.chevronDown());
      pickerBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.popover = {
          kind: "triage-picker",
          anchorRect: rectOf(pickerBtn),
          placement: "below",
          entryId: item.id,
          triggerValEl: pickerVal,
          targets,
          selected: state.triageTargets.get(item.id) || defaultTarget,
        };
        renderPopoverLayer();
      });
      destGroup.appendChild(pickerBtn);

      const moveBtn = document.createElement("button");
      moveBtn.type = "button";
      moveBtn.className = "meru-btn primary";
      moveBtn.dataset.triageEntry = item.id;
      moveBtn.appendChild(ICONS.arrowRight());
      const lbl = document.createElement("span");
      lbl.textContent = st("moveToRealm");
      moveBtn.appendChild(lbl);
      moveBtn.addEventListener("click", async () => {
        const dest = state.triageTargets.get(item.id) || defaultTarget;
        moveBtn.disabled = true;
        try {
          await client.inbox.triage(item.id, dest, { expectedFromRealmRef: "/inbox" });
          showToast(st("routedToast", dest));
          await refreshAll();
        } catch (err) {
          showToast(err?.message || st("triageConflict"));
          moveBtn.disabled = false;
        }
      });

      bar.appendChild(destGroup);
      bar.appendChild(moveBtn);
      wrap.appendChild(bar);
    }

    stack.appendChild(wrap);
  }
  sec.appendChild(stack);
  return sec;
}

function buildObjectsSection() {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "objects";

  if (state.realmObjects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "teaching-empty";
    empty.dataset.ui = "empty-objects";

    const ico = document.createElement("div");
    ico.className = "teaching-empty-icon";
    ico.appendChild(ICONS.objects());
    empty.appendChild(ico);

    const desc = document.createElement("p");
    desc.className = "teaching-empty-desc";
    desc.textContent = st("emptyObjectsDesc");
    empty.appendChild(desc);

    const hintCmd = st("emptyObjectsHint", state.activeRealmPath);
    const cmdRow = document.createElement("div");
    cmdRow.className = "cli-cmd-row teaching-empty-cli";
    const code = document.createElement("code");
    code.className = "cli-cmd-text";
    code.textContent = hintCmd;
    code.title = hintCmd;
    cmdRow.appendChild(code);
    cmdRow.appendChild(makeIconBtn(ICONS.copy(), st("copyCmd"), () => copyText(hintCmd)));
    empty.appendChild(cmdRow);

    sec.appendChild(empty);
    return sec;
  }

  const listWrap = document.createElement("div");

  function renderObjectsGrid() {
    clearEl(listWrap);
    const q = state.objectFilter.trim().toLowerCase();
    const filtered = q
      ? state.realmObjects.filter((o) =>
          String(o.name || "").toLowerCase().includes(q) ||
          String(o.ref || "").toLowerCase().includes(q) ||
          String(o.kind || "").toLowerCase().includes(q))
      : state.realmObjects;

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = st("emptyObjectsFiltered", state.objectFilter);
      listWrap.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "object-chip-grid";
    for (const obj of filtered) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "object-row-btn" + (state.selectedObject?.ref === obj.ref ? " selected" : "");
      btn.dataset.objectRef = obj.ref;

      const main = document.createElement("span");
      main.className = "object-row-main";
      const nm = document.createElement("span");
      nm.className = "object-row-name";
      nm.textContent = obj.name || obj.ref;
      const kd = document.createElement("span");
      kd.className = "object-row-kind";
      kd.textContent = objectKindLabel(obj.kind) + " · " + obj.realmPath;
      main.appendChild(nm);
      main.appendChild(kd);

      btn.appendChild(main);
      btn.appendChild(ICONS.arrowRight());
      btn.addEventListener("click", () => { void selectObjectByRef(obj.ref, false); });
      grid.appendChild(btn);
    }
    listWrap.appendChild(grid);
  }

  if (state.realmObjects.length > 6) {
    const bar = document.createElement("div");
    bar.className = "filter-inline-bar";
    const inp = document.createElement("input");
    inp.className = "filter-inline-input";
    inp.type = "search";
    inp.placeholder = st("filterObjectsPlaceholder");
    inp.value = state.objectFilter;
    inp.addEventListener("input", () => {
      state.objectFilter = inp.value;
      renderObjectsGrid();
    });
    bar.appendChild(inp);
    sec.appendChild(bar);
  }

  renderObjectsGrid();
  sec.appendChild(listWrap);
  return sec;
}

function buildEntriesSection(rules, rc) {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "entries";

  const rulesBanner = buildRulesWhisperBanner(rules);
  if (rulesBanner) {
    sec.appendChild(rulesBanner);
  }

  const allNonRuleEntries = state.realmEntries.filter((x) => x.kind !== "rule");
  const hasAnyEntries = allNonRuleEntries.length > 0;
  const hasActiveFilter = state.entryKindFilter !== "all" || Boolean(state.entrySearchFilter.trim()) || state.showLedgerHistory;

  if (!hasAnyEntries && !hasActiveFilter) {
    const empty = document.createElement("div");
    empty.className = "teaching-empty";
    empty.dataset.ui = "empty-entries";

    const ico = document.createElement("div");
    ico.className = "teaching-empty-icon";
    ico.appendChild(ICONS.entries());
    empty.appendChild(ico);

    const subtreeConclusions = rc.subtreeConclusions ?? 0;
    const childRealmsCount = rc.childRealmsCount ?? 0;
    const desc = document.createElement("p");
    desc.className = "teaching-empty-desc";
    desc.textContent = (subtreeConclusions > 0 && childRealmsCount > 0)
      ? st("emptyEntriesSubtree", fmtNum(subtreeConclusions), childRealmsCount)
      : st("emptyEntriesDesc");
    empty.appendChild(desc);

    const actions = document.createElement("div");
    actions.className = "teaching-empty-actions";
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "meru-btn primary";
    createBtn.dataset.ui = "empty-new-entry-btn";
    createBtn.appendChild(ICONS.plus());
    const createLbl = document.createElement("span");
    createLbl.textContent = st("newEntryBtn");
    createBtn.appendChild(createLbl);
    createBtn.addEventListener("click", () => openWriteModal());
    actions.appendChild(createBtn);
    empty.appendChild(actions);

    sec.appendChild(empty);
    return sec;
  }

  const listWrap = document.createElement("div");

  function renderEntriesList(restoreFocus = false) {
    clearEl(listWrap);
    const items = getFilteredRealmEntries();

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state empty-filter-row";
      const txt = document.createElement("span");
      txt.textContent = st("noFilteredEntries");
      empty.appendChild(txt);
      if (state.entryKindFilter !== "all" || state.entrySearchFilter.trim()) {
        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "meru-btn";
        clearBtn.textContent = st("clearFilter");
        clearBtn.addEventListener("click", () => {
          state.entryKindFilter = "all";
          state.entrySearchFilter = "";
          render();
        });
        empty.appendChild(clearBtn);
      }
      listWrap.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "entry-list";
    for (const item of items) {
      list.appendChild(buildStudioEntryRow(item));
    }
    listWrap.appendChild(list);

    const isFiltered = state.entryKindFilter !== "all" || Boolean(state.entrySearchFilter.trim());
    const localRuleCount = state.realmEntries.length - state.realmEntries.filter((x) => x.kind !== "rule").length;
    const effectiveTotal = (!isFiltered && typeof state.realmEntriesTotal === "number")
      ? Math.max(items.length, state.realmEntriesTotal - localRuleCount)
      : null;

    if (state.realmEntriesHasMore) {
      const foot = document.createElement("div");
      foot.className = "entries-pagination-footer";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "load-more-pill";
      btn.dataset.ui = "load-more-entries";
      btn.disabled = Boolean(state.realmEntriesLoadingMore);
      btn.textContent = state.realmEntriesLoadingMore
        ? st("loadingMoreEntries")
        : (effectiveTotal !== null
          ? st("loadMoreWithTotal", fmtNum(items.length), fmtNum(effectiveTotal))
          : st("loadMoreShownOnly", fmtNum(items.length)));
      btn.addEventListener("click", async () => {
        if (state.realmEntriesLoadingMore) return;
        state.realmEntriesLoadingMore = true;
        btn.disabled = true;
        btn.textContent = st("loadingMoreEntries");
        const loadRes = await loadRealmEntries(state.activeRealmPath, false);
        state.realmEntriesLoadingMore = false;
        if (!loadRes || loadRes.stale) return;
        if (!loadRes.ok) {
          state.realmEntriesHasMore = true;
          renderEntriesList(false);
          showToast(loadRes.error?.message || st("loadMoreFailed"));
          return;
        }
        renderEntriesList(true);
        const tabCnt = document.querySelector('.tab-btn[data-tab="entries"] .tab-count');
        if (tabCnt) {
          const nonRuleCount = state.realmEntries.filter((x) => x.kind !== "rule").length;
          const nextTabCount = Math.max(
            state.brief?.buckets?.conclusions ?? rc.directConclusions ?? 0,
            nonRuleCount,
          );
          tabCnt.textContent = fmtNum(nextTabCount);
        }
      });
      foot.appendChild(btn);
      listWrap.appendChild(foot);
      if (restoreFocus && typeof btn.focus === "function") {
        btn.focus({ preventScroll: true });
      }
    } else if (items.length > 25) {
      const foot = document.createElement("div");
      foot.className = "entries-pagination-footer";
      const endEl = document.createElement("div");
      endEl.className = "entries-pagination-end";
      endEl.dataset.ui = "entries-all-shown";
      endEl.tabIndex = -1;
      endEl.textContent = st("allEntriesShown", fmtNum(items.length));
      foot.appendChild(endEl);
      listWrap.appendChild(foot);
      if (restoreFocus && typeof endEl.focus === "function") {
        endEl.focus({ preventScroll: true });
      }
    }
  }

  // Clean filter/kind toolbar shown ONLY when entries exist (or filters active)
  const toolbar = document.createElement("div");
  toolbar.className = "entries-toolbar";
  toolbar.dataset.ui = "entries-toolbar";

  const leftTools = document.createElement("div");
  leftTools.className = "entries-toolbar-left";

  const presentKinds = new Set(allNonRuleEntries.map((x) => kindMeta(x.extKind || x.kind).key));
  const filterableKinds = ["finding", "decision", "proposal", "claim", "verdict"].filter(
    (k) => presentKinds.has(k) || state.entryKindFilter === k,
  );
  if (filterableKinds.length > 1 || state.entryKindFilter !== "all") {
    const filterGroup = document.createElement("div");
    filterGroup.className = "kind-filter-group";
    filterGroup.setAttribute("role", "group");
    filterGroup.setAttribute("aria-label", st("composerKindLabel"));

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "kind-filter-btn" + (state.entryKindFilter === "all" ? " active" : "");
    allBtn.textContent = st("kindAll");
    allBtn.addEventListener("click", () => {
      state.entryKindFilter = "all";
      render();
    });
    filterGroup.appendChild(allBtn);

    for (const k of filterableKinds) {
      const km = kindMeta(k);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kind-filter-btn" + (state.entryKindFilter === k ? " active" : "");
      b.appendChild(km.icon(13));
      const lbl = document.createElement("span");
      lbl.textContent = km.label;
      b.appendChild(lbl);
      b.addEventListener("click", () => {
        state.entryKindFilter = k;
        render();
      });
      filterGroup.appendChild(b);
    }
    leftTools.appendChild(filterGroup);
  }

  if (allNonRuleEntries.length > 4 || state.entrySearchFilter) {
    const searchInp = document.createElement("input");
    searchInp.type = "search";
    searchInp.className = "entries-search-input";
    searchInp.placeholder = st("filterEntriesPlaceholder");
    searchInp.value = state.entrySearchFilter;
    searchInp.addEventListener("input", () => {
      state.entrySearchFilter = searchInp.value;
      renderEntriesList();
    });
    leftTools.appendChild(searchInp);
  }

  toolbar.appendChild(leftTools);

  const histToggle = document.createElement("label");
  histToggle.className = "history-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.ui = "entries-history-toggle";
  cb.checked = state.showLedgerHistory;
  cb.addEventListener("change", async () => {
    state.showLedgerHistory = cb.checked;
    await loadRealmEntries(state.activeRealmPath, true);
    render();
  });
  const histLbl = document.createElement("span");
  histLbl.textContent = st("showHistory");
  histToggle.appendChild(cb);
  histToggle.appendChild(histLbl);
  toolbar.appendChild(histToggle);

  sec.appendChild(toolbar);
  renderEntriesList();
  sec.appendChild(listWrap);

  return sec;
}

/* ==================== Center Full Document Reader ==================== */

function buildDocumentReader() {
  const main = document.createElement("main");
  main.className = "workspace-col doc-reader-col";
  main.dataset.ui = "center-doc-reader";

  const e = state.openEntry;
  const isRedacted = Boolean(e.redactedAt) || e.status === "retracted";
  const km = kindMeta(e.extKind || e.kind);
  const sm = statusMeta(e.status, isRedacted);
  const rawBody = isRedacted
    ? st("redactedBody")
    : String(e.body || e.snippet || st("noBodyText"));
  const payloadSplitIdx = !isRedacted ? rawBody.indexOf("\n## Payload\n") : -1;
  const mainBodyText = payloadSplitIdx >= 0 ? rawBody.slice(0, payloadSplitIdx).trim() : rawBody;
  const rawPayloadText = payloadSplitIdx >= 0 ? rawBody.slice(payloadSplitIdx + "\n## Payload\n".length).trim() : "";
  const isHtmlDoc = !isRedacted && looksLikeHtmlDoc(mainBodyText, e.sourceRef);

  const visibleEntries = getVisibleListEntries();
  const currentIdx = visibleEntries.findIndex((item) => item.id === e.id);
  const prevItem = currentIdx > 0 ? visibleEntries[currentIdx - 1] : null;
  const nextItem = currentIdx >= 0 && currentIdx < visibleEntries.length - 1 ? visibleEntries[currentIdx + 1] : null;

  const toolbar = document.createElement("div");
  toolbar.className = "reader-toolbar";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "reader-back-btn";
  backBtn.dataset.ui = "reader-back";
  backBtn.title = st("backToList") + " (Esc)";
  backBtn.appendChild(ICONS.arrowLeft());
  const backLbl = document.createElement("span");
  backLbl.textContent = state.previousObject
    ? state.previousObject.ref
    : (e.realmPath || state.activeRealmPath || "/");
  backBtn.appendChild(backLbl);
  backBtn.addEventListener("click", () => {
    closeReaderToList();
  });
  toolbar.appendChild(backBtn);

  const rightControls = document.createElement("div");
  rightControls.className = "reader-toolbar-right";

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "reader-doc-body";

  function populateReaderBody(animate) {
    teardownStudioReader();
    bodyWrap.textContent = "";
    const parentCanvas = bodyWrap.closest(".reader-canvas");
    if (parentCanvas) parentCanvas.classList.remove("has-expanded-mermaid");
    bodyWrap.classList.remove("meru-panel-enter");
    if (animate) {
      void bodyWrap.offsetWidth;
      bodyWrap.classList.add("meru-panel-enter");
    }
    if (isRedacted) {
      const body = document.createElement("p");
      body.className = "inspector-body redacted";
      body.textContent = mainBodyText;
      bodyWrap.appendChild(body);
      return;
    }
    const effectiveView = (state.readerView === "html" && !isHtmlDoc) ? "md" : state.readerView;
    if (effectiveView === "raw") {
      const pre = document.createElement("pre");
      pre.className = "reader-raw-pre";
      pre.textContent = mainBodyText;
      bodyWrap.appendChild(pre);
    } else if (effectiveView === "html") {
      const htmlBox = document.createElement("div");
      htmlBox.className = "reader-html-box";
      bodyWrap.appendChild(htmlBox);
      const currentId = e.id;
      loadMarkdownTools().then((mod) => {
        if (state.openEntry?.id !== currentId || state.readerView !== "html") return;
        activeStudioHtmlPreview = mod.mountStaticHtmlPreview(htmlBox, mainBodyText, {
          notice: st("htmlNotice"),
          renderBtn: st("htmlRender"),
          hideBtn: st("htmlHide"),
        });
      }).catch(() => {
        const pre = document.createElement("pre");
        pre.className = "html-source-pre";
        pre.textContent = mainBodyText;
        htmlBox.appendChild(pre);
      });
    } else {
      const mdEl = document.createElement("meru-markdown");
      mdEl.className = "reader-markdown";
      mdEl.enableMermaid = true;
      mdEl.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      mdEl.labels = {
        mermaidDiagramView: st("mermaidDiagramView"),
        mermaidSourceView: st("mermaidSourceView"),
        mermaidExpand: st("mermaidExpand"),
        mermaidFit: st("mermaidFit"),
        mermaidCopy: st("mermaidCopy"),
        mermaidCopied: st("mermaidCopied"),
        mermaidTooLarge: st("mermaidTooLarge"),
        mermaidTooMany: st("mermaidTooMany"),
        mermaidRenderFailed: st("mermaidRenderFailed"),
        mermaidTimeout: st("mermaidTimeout"),
      };
      mdEl.source = mainBodyText;
      activeStudioMarkdownEl = mdEl;
      bodyWrap.appendChild(mdEl);
    }
  }

  if (!isRedacted) {
    const modeOptions = isHtmlDoc
      ? [
          { key: "html", label: st("html"), icon: ICONS.eye },
          { key: "md", label: st("md"), icon: ICONS.bookOpen },
          { key: "raw", label: st("raw"), icon: ICONS.code },
        ]
      : [
          { key: "md", label: st("md"), icon: ICONS.bookOpen },
          { key: "raw", label: st("raw"), icon: ICONS.code },
        ];
    const effectiveView = (state.readerView === "html" && !isHtmlDoc) ? "md" : state.readerView;
    const seg = createIconSwitch({
      uiId: "reader-view-switch",
      ariaLabel: st("readerViewMode"),
      variant: "toolbar",
      options: modeOptions,
      activeKey: effectiveView,
      datasetKey: "readerView",
      onChange: (mKey) => {
        state.readerView = mKey;
        syncUrlFromState(true);
        populateReaderBody(true);
      },
    });
    rightControls.appendChild(seg);
  }

  const navGroup = document.createElement("div");
  navGroup.className = "reader-nav-group";
  const prevBtn = makeIconBtn(ICONS.chevronUp(), st("prevEntry"), () => {
    if (prevItem) void openEntryInCenter(prevItem.id, { fromObject: Boolean(state.previousObject) });
  });
  prevBtn.dataset.ui = "reader-prev";
  prevBtn.disabled = !prevItem;
  const nextBtn = makeIconBtn(ICONS.chevronDown(), st("nextEntry"), () => {
    if (nextItem) void openEntryInCenter(nextItem.id, { fromObject: Boolean(state.previousObject) });
  });
  nextBtn.dataset.ui = "reader-next";
  nextBtn.disabled = !nextItem;
  navGroup.appendChild(prevBtn);
  navGroup.appendChild(nextBtn);
  rightControls.appendChild(navGroup);

  toolbar.appendChild(rightControls);
  main.appendChild(toolbar);

  const scroll = document.createElement("div");
  scroll.className = "reader-scroll";

  const canvas = document.createElement("article");
  canvas.className = "reader-canvas";
  canvas.dataset.entryId = e.id;
  canvas.addEventListener("meru-mermaid-expand-change", (ev) => {
    const expCount = Number(ev?.detail?.expandedCount || 0);
    canvas.classList.toggle("has-expanded-mermaid", expCount > 0);
  });

  const h1 = document.createElement("h1");
  h1.className = "reader-doc-title";
  h1.textContent = isRedacted ? st("redactedTitle") : String(e.title || st("kindEntry"));
  canvas.appendChild(h1);

  const submeta = document.createElement("div");
  submeta.className = "reader-doc-submeta";
  const kindTag = document.createElement("span");
  kindTag.className = "reader-kind-tag";
  kindTag.appendChild(km.icon(13));
  const kindLbl = document.createElement("span");
  kindLbl.textContent = km.label;
  kindTag.appendChild(kindLbl);
  submeta.appendChild(kindTag);

  if (sm.notable) {
    const stSpan = document.createElement("span");
    stSpan.className = "studio-entry-status status-" + sm.key;
    stSpan.textContent = sm.label;
    submeta.appendChild(stSpan);
  }
  const authorName = formatAuthorName(e);
  if (authorName) {
    const authSpan = document.createElement("span");
    authSpan.textContent = authorName;
    submeta.appendChild(authSpan);
  }
  const tsIso = e.occurredAt || e.createdAt;
  if (tsIso) {
    const tsSpan = document.createElement("time");
    tsSpan.setAttribute("datetime", String(tsIso));
    tsSpan.title = formatStamp(tsIso);
    tsSpan.textContent = formatRelativeTime(tsIso);
    submeta.appendChild(tsSpan);
  }
  const readerObjChips = !isRedacted ? getEntryObjectChips(e) : [];
  if (readerObjChips.length > 0) {
    const chipsWrap = document.createElement("span");
    chipsWrap.className = "entry-object-chips reader-object-chips";
    for (const chip of readerObjChips) {
      const chipBtn = document.createElement("button");
      chipBtn.type = "button";
      chipBtn.className = "entry-object-chip";
      chipBtn.dataset.ui = "entry-object-chip";
      chipBtn.dataset.objectRef = chip.ref;
      chipBtn.textContent = chip.label;
      chipBtn.title = chip.ref;
      chipBtn.addEventListener("click", () => {
        void selectObjectByRef(chip.ref, false);
      });
      chipsWrap.appendChild(chipBtn);
    }
    submeta.appendChild(chipsWrap);
  }
  canvas.appendChild(submeta);

  populateReaderBody(false);
  canvas.appendChild(bodyWrap);

  if (rawPayloadText) {
    const det = document.createElement("details");
    det.className = "payload-details";
    const sum = document.createElement("summary");
    sum.textContent = st("payload");
    const pre = document.createElement("pre");
    pre.className = "payload-pre";
    pre.textContent = rawPayloadText.replace(/^```json\n?|\n?```$/g, "");
    det.appendChild(sum);
    det.appendChild(pre);
    canvas.appendChild(det);
  }

  scroll.appendChild(canvas);
  main.appendChild(scroll);
  return main;
}

/* ==================== Center Object Page (v0.7.0) ==================== */

function getObjectActivePeers(card) {
  const bySession = new Map();
  for (const p of state.selectedObjectActivePeers || []) {
    if (p && p.sessionId && p.sessionId !== state.selfPulseSessionId) {
      bySession.set(p.sessionId, p);
    }
  }
  const keyLower = (String(card.kind || "") + ":" + String(card.name || "")).toLowerCase();
  const refLower = String(card.ref || "").toLowerCase();
  for (const p of state.pulses || []) {
    if (!p || !p.active || !p.sessionId || p.sessionId === state.selfPulseSessionId) continue;
    const keysMatch = Array.isArray(p.keys) && p.keys.some((k) => String(k).toLowerCase() === keyLower || String(k).toLowerCase() === refLower);
    const focusMatch = Array.isArray(p.focus) && p.focus.some((f) => String(f).toLowerCase() === keyLower || String(f).toLowerCase() === refLower);
    if ((keysMatch || focusMatch) && !bySession.has(p.sessionId)) {
      bySession.set(p.sessionId, p);
    }
  }
  return Array.from(bySession.values());
}

function buildObjectBriefSummaryRow(item, kindFallback) {
  const km = kindMeta(item.kind || kindFallback);
  const row = document.createElement("button");
  row.type = "button";
  row.className = "object-brief-row";
  row.dataset.ui = "object-brief-row";
  row.dataset.entryId = item.id;

  const iconWrap = document.createElement("span");
  iconWrap.className = "studio-entry-icon kind-" + km.key;
  iconWrap.appendChild(km.icon(14));
  row.appendChild(iconWrap);

  const main = document.createElement("div");
  main.className = "object-brief-row-main";

  const title = document.createElement("div");
  title.className = "object-brief-row-title";
  title.textContent = String(item.title || item.id);
  main.appendChild(title);

  const snippet = String(item.snippet || "").replace(/\s+/g, " ").trim();
  if (snippet && snippet !== String(item.title || "").trim()) {
    const snipEl = document.createElement("p");
    snipEl.className = "object-brief-row-snippet";
    snipEl.textContent = snippet;
    main.appendChild(snipEl);
  }

  const meta = document.createElement("div");
  meta.className = "object-brief-row-meta";
  const metaParts = [];
  if (item.authorId) metaParts.push("@" + item.authorId);
  const tsIso = item.occurredAt || item.createdAt;
  if (tsIso) metaParts.push(formatRelativeTime(tsIso));
  if (item.realmPath) metaParts.push(item.realmPath);
  meta.textContent = metaParts.join(" · ");
  main.appendChild(meta);

  row.appendChild(main);
  row.addEventListener("click", () => {
    void openEntryInCenter(item.id, { fromObject: true });
  });
  return row;
}

function buildObjectPage() {
  teardownObjectNarrativeMarkdown();
  const card = state.selectedObject;
  const main = document.createElement("main");
  main.className = "workspace-col object-page-col";
  main.dataset.ui = "center-object-page";
  main.dataset.objectRef = card.ref || "";

  const scroll = document.createElement("div");
  scroll.className = "workspace-scroll object-page-scroll";

  const canvas = document.createElement("div");
  canvas.className = "object-page-canvas";

  // 1. Header: Breadcrumb (/<realm> › <kind> › <name>) + Title + State Badge + Inspector Toggle
  const header = document.createElement("header");
  header.className = "object-page-header";
  header.dataset.ui = "object-page-header";

  const headTop = document.createElement("div");
  headTop.className = "object-page-head-top";

  const crumbNav = document.createElement("nav");
  crumbNav.className = "object-breadcrumb";
  crumbNav.setAttribute("aria-label", "Breadcrumb");

  const realmLinkPath = card.realmPath || state.activeRealmPath || "/";
  const realmBtn = document.createElement("button");
  realmBtn.type = "button";
  realmBtn.className = "object-crumb-btn";
  realmBtn.dataset.ui = "object-crumb-realm";
  realmBtn.textContent = realmLinkPath;
  realmBtn.addEventListener("click", () => {
    void selectRealm(realmLinkPath, "entries");
  });
  crumbNav.appendChild(realmBtn);

  const sep1 = document.createElement("span");
  sep1.className = "object-crumb-sep";
  sep1.setAttribute("aria-hidden", "true");
  sep1.textContent = "›";
  crumbNav.appendChild(sep1);

  const kindCrumb = document.createElement("span");
  kindCrumb.className = "object-crumb-kind";
  kindCrumb.textContent = objectKindLabel(card.kind);
  crumbNav.appendChild(kindCrumb);

  const sep2 = document.createElement("span");
  sep2.className = "object-crumb-sep";
  sep2.setAttribute("aria-hidden", "true");
  sep2.textContent = "›";
  crumbNav.appendChild(sep2);

  const nameCrumb = document.createElement("span");
  nameCrumb.className = "object-crumb-name";
  nameCrumb.textContent = String(card.name || card.ref);
  crumbNav.appendChild(nameCrumb);

  headTop.appendChild(crumbNav);

  const objInspectorBtn = makeIconBtn(
    ICONS.panelRight(),
    state.inspectorOpen ? st("hideInspectorTooltip") : st("showInspectorTooltip"),
    () => {
      state.inspectorOpen = !state.inspectorOpen;
      state.inspectorPinned = state.inspectorOpen;
      render();
    },
    state.inspectorOpen ? "active" : "",
  );
  objInspectorBtn.dataset.ui = "object-inspector-toggle";
  headTop.appendChild(objInspectorBtn);
  header.appendChild(headTop);

  const titleRow = document.createElement("div");
  titleRow.className = "object-page-title-row";

  const h1 = document.createElement("h1");
  h1.className = "object-page-title";
  h1.dataset.ui = "object-page-title";
  h1.textContent = String(card.name || card.ref);
  titleRow.appendChild(h1);

  if (card.object?.state && card.object.state !== "active") {
    const stBadge = document.createElement("span");
    stBadge.className = "object-state-badge state-" + String(card.object.state);
    stBadge.dataset.ui = "object-state-badge";
    stBadge.textContent = String(card.object.stateLabel || objectStateLabel(card.object.state));
    titleRow.appendChild(stBadge);
  }
  header.appendChild(titleRow);
  canvas.appendChild(header);

  // 2. Single-Row Linear SVG Signal Bar (V5: zero count-0 items, V6: zero inventory numbers, V7: exact untruncated rules)
  const rules = Array.isArray(card.rules) ? card.rules : [];
  const pendingItems = Array.isArray(card.pendingDecisions?.items) ? card.pendingDecisions.items : [];
  const pendingTotal = typeof card.pendingDecisions?.totalCount === "number"
    ? card.pendingDecisions.totalCount
    : pendingItems.length;
  const activeDecItems = Array.isArray(card.activeDecisions?.items) ? card.activeDecisions.items : [];
  const activeDecTotal = typeof card.activeDecisions?.totalCount === "number"
    ? card.activeDecisions.totalCount
    : activeDecItems.length;
  const objectPeers = getObjectActivePeers(card);

  if (rules.length > 0 || pendingTotal > 0 || objectPeers.length > 0) {
    const signalBar = document.createElement("div");
    signalBar.className = "object-signal-bar";
    signalBar.dataset.ui = "object-signal-bar";
    signalBar.setAttribute("role", "toolbar");

    if (rules.length > 0) {
      const rulesBtn = document.createElement("button");
      rulesBtn.type = "button";
      rulesBtn.className = "signal-pill" + (state.objectRulesExpanded ? " active" : "");
      rulesBtn.dataset.ui = "signal-rules-btn";
      rulesBtn.setAttribute("aria-expanded", String(state.objectRulesExpanded));
      rulesBtn.appendChild(ICONS.kindRule(14));
      const lbl = document.createElement("span");
      lbl.className = "signal-pill-label";
      lbl.textContent = st("signalRules");
      rulesBtn.appendChild(lbl);
      const cnt = document.createElement("span");
      cnt.className = "signal-pill-count";
      cnt.dataset.ui = "signal-rules-count";
      cnt.textContent = fmtNum(rules.length);
      rulesBtn.appendChild(cnt);
      const chev = document.createElement("span");
      chev.className = "signal-pill-chev";
      chev.appendChild(state.objectRulesExpanded ? ICONS.chevronDown() : ICONS.chevronRight());
      rulesBtn.appendChild(chev);
      rulesBtn.addEventListener("click", () => {
        state.objectRulesExpanded = !state.objectRulesExpanded;
        render();
      });
      signalBar.appendChild(rulesBtn);
    }

    if (pendingTotal > 0) {
      const pendBtn = document.createElement("button");
      pendBtn.type = "button";
      pendBtn.className = "signal-pill signal-warn";
      pendBtn.dataset.ui = "signal-pending-btn";
      pendBtn.appendChild(ICONS.kindProposal(14));
      const lbl = document.createElement("span");
      lbl.className = "signal-pill-label";
      lbl.textContent = st("signalPending");
      pendBtn.appendChild(lbl);
      const cnt = document.createElement("span");
      cnt.className = "signal-pill-count";
      cnt.textContent = fmtNum(pendingTotal);
      pendBtn.appendChild(cnt);
      pendBtn.addEventListener("click", () => {
        const targetSec = canvas.querySelector('[data-section="object-pending-decisions"]');
        if (targetSec && typeof targetSec.scrollIntoView === "function") {
          targetSec.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
      signalBar.appendChild(pendBtn);
    }

    if (objectPeers.length > 0) {
      const peersBtn = document.createElement("button");
      peersBtn.type = "button";
      peersBtn.className = "signal-pill signal-live" + (state.objectPeersExpanded ? " active" : "");
      peersBtn.dataset.ui = "signal-peers-btn";
      peersBtn.setAttribute("aria-expanded", String(state.objectPeersExpanded));
      peersBtn.appendChild(ICONS.users());
      const lbl = document.createElement("span");
      lbl.className = "signal-pill-label";
      lbl.textContent = st("signalPeers");
      peersBtn.appendChild(lbl);
      const cnt = document.createElement("span");
      cnt.className = "signal-pill-count";
      cnt.textContent = fmtNum(objectPeers.length);
      peersBtn.appendChild(cnt);
      peersBtn.addEventListener("click", () => {
        state.objectPeersExpanded = !state.objectPeersExpanded;
        render();
      });
      signalBar.appendChild(peersBtn);
    }

    canvas.appendChild(signalBar);
  }

  // Expandable Untruncated Rules Drawer (grouped: Wall / Object & ancestors / --with)
  if (state.objectRulesExpanded && rules.length > 0) {
    const rulesPanel = document.createElement("section");
    rulesPanel.className = "object-rules-panel";
    rulesPanel.dataset.ui = "object-rules-panel";

    const groups = [
      { key: "realm", label: st("ruleGroupWall"), items: rules.filter((r) => r.scopeSource === "realm") },
      { key: "object", label: st("ruleGroupObject"), items: rules.filter((r) => r.scopeSource === "object") },
      { key: "with", label: st("ruleGroupWith"), items: rules.filter((r) => r.scopeSource === "with") },
    ];
    let ruleIdx = 0;
    for (const grp of groups) {
      if (grp.items.length === 0) continue;
      const gWrap = document.createElement("div");
      gWrap.className = "object-rules-group";
      gWrap.dataset.ruleGroup = grp.key;

      const gHead = document.createElement("div");
      gHead.className = "object-rules-group-head";
      gHead.textContent = grp.label + " (" + grp.items.length + ")";
      gWrap.appendChild(gHead);

      const gList = document.createElement("div");
      gList.className = "object-rules-group-list";
      for (const rule of grp.items) {
        ruleIdx += 1;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "rule-row compact";
        row.dataset.ruleId = rule.id;

        const num = document.createElement("span");
        num.className = "rule-idx";
        num.textContent = String(ruleIdx);

        const title = document.createElement("span");
        title.className = "rule-title";
        title.textContent = rule.title;

        const src = document.createElement("span");
        src.className = "origin-tag";
        src.textContent = rule.sourceRef || rule.realmPath || "";

        row.appendChild(num);
        row.appendChild(title);
        row.appendChild(src);
        row.addEventListener("click", () => {
          void openEntryInCenter(rule.id, { fromObject: true });
        });
        gList.appendChild(row);
      }
      gWrap.appendChild(gList);
      rulesPanel.appendChild(gWrap);
    }
    canvas.appendChild(rulesPanel);
  }

  // Expandable Active Peers Drawer
  if (state.objectPeersExpanded && objectPeers.length > 0) {
    const peersPanel = document.createElement("div");
    peersPanel.className = "object-peers-panel";
    peersPanel.dataset.ui = "object-peers-panel";
    const groupsByActor = new Map(groupPulsesByActor(state.pulses).map((g) => [g.actorId, g]));
    for (const peer of objectPeers) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "peer-chip";
      const dot = document.createElement("span");
      dot.className = "status-dot" + (peer.online ? "" : " active");
      const who = document.createElement("span");
      who.className = "peer-chip-who";
      who.textContent = peer.clientHint ? (peer.actorId + " · " + peer.clientHint) : peer.actorId;
      chip.appendChild(dot);
      chip.appendChild(who);
      const summary = peer.activity || peer.note || "";
      if (summary) {
        const ctx = document.createElement("span");
        ctx.className = "peer-chip-ctx";
        ctx.textContent = summary;
        chip.appendChild(ctx);
      }
      const age = document.createElement("span");
      age.className = "peer-chip-age";
      age.textContent = peer.online ? st("nowTag") : formatPulseAge(peer.ageSeconds);
      chip.appendChild(age);
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const group = groupsByActor.get(peer.actorId) || {
          actorId: peer.actorId,
          actorKind: peer.actorKind,
          online: peer.online,
          active: peer.active,
          sessions: [peer],
        };
        state.popover = {
          kind: "member-card",
          anchorRect: rectOf(chip),
          placement: "below",
          group,
          pulse: peer,
        };
        renderPopoverLayer();
      });
      peersPanel.appendChild(chip);
    }
    canvas.appendChild(peersPanel);
  }

  // 3. Pending Decisions (pinned; omitted if 0)
  if (pendingTotal > 0 && pendingItems.length > 0) {
    const sec = document.createElement("section");
    sec.className = "object-section";
    sec.dataset.section = "object-pending-decisions";

    const secHead = document.createElement("div");
    secHead.className = "object-section-head";
    const secTitle = document.createElement("h2");
    secTitle.className = "object-section-title";
    secTitle.textContent = st("objSecPending");
    const secCount = document.createElement("span");
    secCount.className = "object-section-count";
    secCount.textContent = fmtNum(pendingTotal);
    secHead.appendChild(secTitle);
    secHead.appendChild(secCount);
    sec.appendChild(secHead);

    const list = document.createElement("div");
    list.className = "object-brief-list";
    for (const item of pendingItems) {
      list.appendChild(buildObjectBriefSummaryRow(item, "proposal"));
    }
    sec.appendChild(list);
    canvas.appendChild(sec);
  }

  // 4. Active Decisions (pinned top 5 + expand-more toggle; omitted if 0)
  if (activeDecTotal > 0 && activeDecItems.length > 0) {
    const sec = document.createElement("section");
    sec.className = "object-section";
    sec.dataset.section = "object-active-decisions";

    const secHead = document.createElement("div");
    secHead.className = "object-section-head";
    const secTitle = document.createElement("h2");
    secTitle.className = "object-section-title";
    secTitle.textContent = st("objSecActiveDecisions");
    const secCount = document.createElement("span");
    secCount.className = "object-section-count";
    secCount.textContent = fmtNum(activeDecTotal);
    secHead.appendChild(secTitle);
    secHead.appendChild(secCount);
    sec.appendChild(secHead);

    const visibleDecs = state.objectDecisionsExpanded ? activeDecItems : activeDecItems.slice(0, 5);
    const list = document.createElement("div");
    list.className = "object-brief-list";
    for (const item of visibleDecs) {
      list.appendChild(buildObjectBriefSummaryRow(item, "decision"));
    }
    sec.appendChild(list);

    if (activeDecItems.length > 5 || activeDecTotal > 5) {
      const moreCount = Math.max(activeDecItems.length, activeDecTotal) - 5;
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "object-expand-btn";
      moreBtn.dataset.ui = "object-decisions-expand";
      moreBtn.setAttribute("aria-expanded", String(state.objectDecisionsExpanded));
      moreBtn.textContent = state.objectDecisionsExpanded
        ? st("showFewerDecisions")
        : st("showMoreDecisions", moreCount);
      moreBtn.addEventListener("click", () => {
        state.objectDecisionsExpanded = !state.objectDecisionsExpanded;
        render();
      });
      sec.appendChild(moreBtn);
    }

    canvas.appendChild(sec);
  }

  // 5. L3 Narrative Card (`card_object`) with V3 Freshness UI & XSS-Safe <meru-markdown>
  if (card.narrativeCard) {
    const nc = card.narrativeCard;
    const freshness = card.cardFreshness || nc.freshness || { status: "fresh", summaryLine: null, reasons: [] };
    const status = freshness.status || "fresh";

    const sec = document.createElement("section");
    sec.className = "object-section object-narrative-section is-" + status;
    sec.dataset.section = "object-narrative-card";
    sec.dataset.freshness = status;

    const secHead = document.createElement("div");
    secHead.className = "object-narrative-head";

    const headLeft = document.createElement("div");
    headLeft.className = "object-narrative-head-left";
    const secTitle = document.createElement("h2");
    secTitle.className = "object-section-title";
    secTitle.textContent = st("objSecNarrative");
    headLeft.appendChild(secTitle);

    const nonBinding = document.createElement("span");
    nonBinding.className = "narrative-nonbinding-tag";
    nonBinding.dataset.ui = "narrative-nonbinding-tag";
    nonBinding.textContent = st("narrativeNonBinding");
    headLeft.appendChild(nonBinding);
    secHead.appendChild(headLeft);

    const freshBadge = document.createElement("span");
    freshBadge.className = "freshness-badge is-" + status;
    freshBadge.dataset.ui = "card-freshness-badge";
    freshBadge.dataset.freshness = status;
    if (status === "fresh") {
      freshBadge.textContent = st("freshnessFresh");
    } else if (status === "soft_stale") {
      freshBadge.textContent = freshness.summaryLine || st("freshnessSoftStale");
    } else {
      freshBadge.textContent = st("freshnessHardStale");
    }
    secHead.appendChild(freshBadge);
    sec.appendChild(secHead);

    const mountNarrativeMarkdown = (sourceMd, isHistoric = false) => {
      const bodyBox = document.createElement("div");
      bodyBox.className = "object-narrative-body" + (isHistoric ? " is-historic" : "");
      bodyBox.dataset.ui = "object-narrative-body";
      const mdEl = document.createElement("meru-markdown");
      mdEl.className = "object-narrative-markdown";
      mdEl.dataset.ui = "object-narrative-markdown";
      mdEl.enableMermaid = false;
      mdEl.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      mdEl.source = String(sourceMd || "");
      activeObjectNarrativeMarkdownEl = mdEl;
      bodyBox.appendChild(mdEl);
      return bodyBox;
    };

    if (status === "hard_stale") {
      // Collapsed by default to a 1-line warning banner; historic text fetched strictly on demand
      const banner = document.createElement("div");
      banner.className = "hard-stale-banner";
      banner.dataset.ui = "hard-stale-banner";

      const bannerLeft = document.createElement("div");
      bannerLeft.className = "hard-stale-banner-left";
      bannerLeft.appendChild(ICONS.alertTriangle(14));
      const bannerText = document.createElement("span");
      bannerText.className = "hard-stale-banner-text";
      bannerText.textContent = freshness.summaryLine || st("freshnessHardStale");
      bannerLeft.appendChild(bannerText);
      banner.appendChild(bannerLeft);

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "hard-stale-toggle-btn";
      toggleBtn.dataset.ui = "hard-stale-expand-btn";
      toggleBtn.setAttribute("aria-expanded", String(state.objectStaleCardExpanded));
      toggleBtn.disabled = state.objectStaleCardLoading;
      toggleBtn.textContent = state.objectStaleCardLoading
        ? st("hardStaleLoading")
        : (state.objectStaleCardExpanded ? st("hardStaleCollapse") : st("hardStaleExpand"));
      toggleBtn.addEventListener("click", async () => {
        if (state.objectStaleCardLoading) return;
        if (state.objectStaleCardExpanded) {
          state.objectStaleCardExpanded = false;
          render();
          return;
        }
        state.objectStaleCardExpanded = true;
        if (state.objectStaleCardHistoricMd !== null) {
          render();
          return;
        }
        const targetRef = card.ref;
        state.objectStaleCardLoading = true;
        render();
        try {
          const staleRes = await client.show(targetRef, { include_stale_narrative: 1 });
          if (state.selectedObject?.ref !== targetRef) return;
          state.objectStaleCardHistoricMd = staleRes?.card?.narrativeCard?.historicNarrativeMd ?? "";
        } catch (err) {
          if (state.selectedObject?.ref !== targetRef) return;
          state.objectStaleCardHistoricMd = "";
          showToast(err?.message || st("loadObjectFailed"));
        } finally {
          if (state.selectedObject?.ref === targetRef) {
            state.objectStaleCardLoading = false;
            render();
          }
        }
      });
      banner.appendChild(toggleBtn);
      sec.appendChild(banner);

      if (state.objectStaleCardExpanded && !state.objectStaleCardLoading) {
        if (state.objectStaleCardHistoricMd) {
          sec.appendChild(mountNarrativeMarkdown(state.objectStaleCardHistoricMd, true));
        } else {
          const unavail = document.createElement("div");
          unavail.className = "hard-stale-unavail";
          unavail.textContent = st("hardStaleUnavailable");
          sec.appendChild(unavail);
        }
      }
    } else if (nc.narrativeMd) {
      sec.appendChild(mountNarrativeMarkdown(nc.narrativeMd, false));
    }

    if (nc.settledBy || nc.createdAt) {
      const foot = document.createElement("div");
      foot.className = "object-narrative-meta";
      foot.textContent = [
        nc.settledBy ? ("@" + nc.settledBy) : "",
        nc.createdAt ? formatRelativeTime(nc.createdAt) : "",
      ].filter(Boolean).join(" · ");
      sec.appendChild(foot);
    }

    canvas.appendChild(sec);
  }

  // 6. Children & Co-occurring Objects (omitted if both empty)
  const children = Array.isArray(card.children) ? card.children : [];
  const coOccurring = Array.isArray(card.coOccurring) ? card.coOccurring : [];
  if (children.length > 0 || coOccurring.length > 0) {
    const sec = document.createElement("section");
    sec.className = "object-section object-relations-section";
    sec.dataset.section = "object-relations";

    if (children.length > 0) {
      const row = document.createElement("div");
      row.className = "object-rel-row";
      const lbl = document.createElement("span");
      lbl.className = "object-rel-label";
      lbl.textContent = st("objSecChildren");
      row.appendChild(lbl);
      const wrap = document.createElement("div");
      wrap.className = "object-rel-chips";
      for (const ch of children) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "object-rel-chip";
        btn.dataset.ui = "object-rel-chip";
        btn.dataset.objectRef = ch.ref;
        btn.textContent = ch.ref;
        btn.addEventListener("click", () => { void selectObjectByRef(ch.ref, false); });
        wrap.appendChild(btn);
      }
      row.appendChild(wrap);
      sec.appendChild(row);
    }

    if (coOccurring.length > 0) {
      const row = document.createElement("div");
      row.className = "object-rel-row";
      const lbl = document.createElement("span");
      lbl.className = "object-rel-label";
      lbl.textContent = st("objSecCoOccurring");
      row.appendChild(lbl);
      const wrap = document.createElement("div");
      wrap.className = "object-rel-chips";
      for (const co of coOccurring) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "object-rel-chip";
        btn.dataset.ui = "object-rel-chip";
        btn.dataset.objectRef = co.ref;
        btn.textContent = co.ref;
        btn.title = co.ref + " (" + co.sharedCount + ")";
        btn.addEventListener("click", () => { void selectObjectByRef(co.ref, false); });
        wrap.appendChild(btn);
      }
      row.appendChild(wrap);
      sec.appendChild(row);
    }

    canvas.appendChild(sec);
  }

  // 7. Record Stream (chronological entries + v0.6.6 scroll-preserving Load More pagination)
  const streamSec = document.createElement("section");
  streamSec.className = "object-section object-stream-section";
  streamSec.dataset.section = "object-record-stream";

  const streamHead = document.createElement("div");
  streamHead.className = "object-section-head";

  const streamHeadLeft = document.createElement("div");
  streamHeadLeft.className = "object-section-head-left";
  const streamTitle = document.createElement("h2");
  streamTitle.className = "object-section-title";
  streamTitle.textContent = st("objSecRecordStream");
  streamHeadLeft.appendChild(streamTitle);
  streamHead.appendChild(streamHeadLeft);

  const histToggle = document.createElement("label");
  histToggle.className = "history-toggle";
  const histCb = document.createElement("input");
  histCb.type = "checkbox";
  histCb.dataset.ui = "object-history-toggle";
  histCb.checked = state.objectShowHistory;
  histCb.addEventListener("change", async () => {
    state.objectShowHistory = histCb.checked;
    await loadObjectEntries(card.ref, true);
    renderObjectStreamList(false);
  });
  const histLbl = document.createElement("span");
  histLbl.textContent = st("showHistory");
  histToggle.appendChild(histCb);
  histToggle.appendChild(histLbl);
  streamHead.appendChild(histToggle);
  streamSec.appendChild(streamHead);

  const streamWrap = document.createElement("div");
  streamWrap.dataset.ui = "object-stream-wrap";

  function renderObjectStreamList(restoreFocus = false) {
    const prevScrollTop = scroll.scrollTop;
    clearEl(streamWrap);
    const items = state.objectEntries || [];

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.dataset.ui = "object-empty-stream";
      empty.textContent = st("objEmptyStream");
      streamWrap.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "entry-list";
    for (const item of items) {
      list.appendChild(buildStudioEntryRow(item, { fromObject: true, currentObjectRef: card.ref }));
    }
    streamWrap.appendChild(list);

    const effectiveTotal = typeof state.objectEntriesTotal === "number"
      ? Math.max(items.length, state.objectEntriesTotal)
      : null;

    if (state.objectEntriesHasMore) {
      const foot = document.createElement("div");
      foot.className = "entries-pagination-footer";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "load-more-pill";
      btn.dataset.ui = "object-load-more-entries";
      btn.disabled = Boolean(state.objectEntriesLoadingMore);
      btn.textContent = state.objectEntriesLoadingMore
        ? st("loadingMoreEntries")
        : (effectiveTotal !== null
          ? st("loadMoreWithTotal", fmtNum(items.length), fmtNum(effectiveTotal))
          : st("loadMoreShownOnly", fmtNum(items.length)));
      btn.addEventListener("click", async () => {
        if (state.objectEntriesLoadingMore) return;
        const lockedScrollTop = scroll.scrollTop;
        state.objectEntriesLoadingMore = true;
        btn.disabled = true;
        btn.textContent = st("loadingMoreEntries");
        const loadRes = await loadObjectEntries(card.ref, false);
        state.objectEntriesLoadingMore = false;
        if (!loadRes || loadRes.stale) return;
        if (!loadRes.ok) {
          state.objectEntriesHasMore = true;
          renderObjectStreamList(false);
          scroll.scrollTop = lockedScrollTop;
          showToast(loadRes.error?.message || st("loadMoreFailed"));
          return;
        }
        renderObjectStreamList(true);
        scroll.scrollTop = lockedScrollTop;
      });
      foot.appendChild(btn);
      streamWrap.appendChild(foot);
      if (restoreFocus && typeof btn.focus === "function") {
        btn.focus({ preventScroll: true });
      }
    } else if (items.length > 25) {
      const foot = document.createElement("div");
      foot.className = "entries-pagination-footer";
      const endEl = document.createElement("div");
      endEl.className = "entries-pagination-end";
      endEl.dataset.ui = "object-entries-all-shown";
      endEl.tabIndex = -1;
      endEl.textContent = st("allEntriesShown", fmtNum(items.length));
      foot.appendChild(endEl);
      streamWrap.appendChild(foot);
      if (restoreFocus && typeof endEl.focus === "function") {
        endEl.focus({ preventScroll: true });
      }
    }
    if (restoreFocus) {
      scroll.scrollTop = prevScrollTop;
    }
  }

  renderObjectStreamList(false);
  streamSec.appendChild(streamWrap);
  canvas.appendChild(streamSec);

  scroll.appendChild(canvas);
  main.appendChild(scroll);
  return main;
}

/* ==================== Main Workspace ==================== */

function buildWorkspace() {
  if (state.openEntry) {
    return buildDocumentReader();
  }
  if (state.selectedObject) {
    return buildObjectPage();
  }
  const main = document.createElement("main");
  main.className = "workspace-col";

  const rules = state.brief?.middleMind?.rules?.items || [];
  const rc = state.realmCounts[state.activeRealmPath] || {};
  const nonRuleEntries = state.realmEntries.filter((x) => x.kind !== "rule");
  const directEntriesCount = state.brief?.buckets?.conclusions ?? rc.directConclusions ?? nonRuleEntries.length;
  const activeRealmObj = state.realms.find((r) => r.path === state.activeRealmPath);

  const head = document.createElement("div");
  head.className = "workspace-header";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  const h1 = document.createElement("h1");
  h1.className = "page-title";
  h1.textContent = state.activeRealmPath === "/inbox" ? st("tabInbox") : realmDisplayName(activeRealmObj);
  titleRow.appendChild(h1);
  head.appendChild(titleRow);

  const scopeText = state.brief?.realm?.scope || activeRealmObj?.scope || "";
  if (scopeText) {
    const scopeP = document.createElement("p");
    scopeP.className = "scope-line";
    scopeP.textContent = scopeText;
    head.appendChild(scopeP);
  }

  // Contextual inline Active Peers strip: strictly hidden when 0 other peers are active here
  const realmPeers = (state.pulses || []).filter(
    (p) => p.realmPath === state.activeRealmPath && p.active && p.sessionId !== state.selfPulseSessionId,
  );
  if (realmPeers.length > 0) {
    const peersBar = document.createElement("div");
    peersBar.className = "realm-peers-bar";
    peersBar.dataset.ui = "realm-peers-bar";

    const peersLbl = document.createElement("span");
    peersLbl.className = "realm-peers-label";
    peersLbl.textContent = st("activeHere");
    peersBar.appendChild(peersLbl);

    const groupsByActor = new Map(groupPulsesByActor(state.pulses).map((g) => [g.actorId, g]));
    const shownPeers = realmPeers.slice(0, 4);
    for (const peer of shownPeers) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "peer-chip";
      const dot = document.createElement("span");
      dot.className = "status-dot" + (peer.online ? "" : " active");
      const who = document.createElement("span");
      who.className = "peer-chip-who";
      who.textContent = peer.clientHint ? (peer.actorId + " · " + peer.clientHint) : peer.actorId;
      chip.appendChild(dot);
      chip.appendChild(who);

      const summary = peer.activity || peer.note || "";
      if (summary) {
        const ctx = document.createElement("span");
        ctx.className = "peer-chip-ctx";
        ctx.textContent = summary;
        chip.appendChild(ctx);
      }

      const age = document.createElement("span");
      age.className = "peer-chip-age";
      age.textContent = peer.online ? st("nowTag") : formatPulseAge(peer.ageSeconds);
      chip.appendChild(age);

      chip.title = [
        peer.actorId + " (" + (peer.actorKind === "human" ? st("actorHuman") : st("actorAgent")) + (peer.clientHint ? ", " + peer.clientHint : "") + " " + shortSessionHandle(peer.sessionId) + ")",
        peer.activity || "",
        peer.note ? ('"' + peer.note + '"') : "",
      ].filter(Boolean).join(" · ");

      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const group = groupsByActor.get(peer.actorId) || {
          actorId: peer.actorId,
          actorKind: peer.actorKind,
          online: peer.online,
          active: peer.active,
          sessions: [peer],
        };
        state.popover = {
          kind: "member-card",
          anchorRect: rectOf(chip),
          placement: "below",
          group,
          pulse: peer,
        };
        renderPopoverLayer();
      });
      peersBar.appendChild(chip);
    }

    if (realmPeers.length > shownPeers.length) {
      const more = document.createElement("span");
      more.className = "realm-peers-more";
      more.textContent = "+" + (realmPeers.length - shownPeers.length);
      peersBar.appendChild(more);
    }
    head.appendChild(peersBar);
  }

  // Clean 3-tab bar (+ conditional Inbox tab when /inbox exists); count pills hidden when 0
  const tabs = document.createElement("div");
  tabs.className = "tab-bar";
  tabs.setAttribute("role", "tablist");

  const tabDefs = [
    { id: "entries", label: st("tabEntries"), icon: ICONS.entries, count: Math.max(directEntriesCount, nonRuleEntries.length) },
    { id: "objects", label: st("tabObjects"), icon: ICONS.objects, count: state.realmObjects.length },
    { id: "rules", label: st("tabRules"), icon: ICONS.rules, count: rules.length },
  ];
  if (state.hasInboxRealm) {
    tabDefs.push({ id: "inbox", label: st("tabInbox"), icon: ICONS.inbox, count: state.inboxEntries.length });
  }

  for (const t of tabDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.className = "tab-btn" + (state.activeTab === t.id ? " active" : "");
    btn.setAttribute("aria-selected", String(state.activeTab === t.id));
    btn.dataset.tab = t.id;
    const ico = document.createElement("span");
    ico.className = "tab-icon";
    ico.appendChild(t.icon());
    const lbl = document.createElement("span");
    lbl.textContent = t.label;
    btn.appendChild(ico);
    btn.appendChild(lbl);
    if (typeof t.count === "number" && t.count > 0) {
      const cnt = document.createElement("span");
      cnt.className = "tab-count";
      cnt.textContent = fmtNum(t.count);
      btn.appendChild(cnt);
    }
    btn.addEventListener("click", () => {
      state.activeTab = t.id;
      syncUrlFromState(true);
      render();
    });
    tabs.appendChild(btn);
  }
  head.appendChild(tabs);
  main.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "workspace-scroll";

  if (state.activeTab === "entries") {
    if (state.activeRealmPath === "/inbox" && state.hasInboxRealm && state.inboxEntries.length > 0) {
      scroll.appendChild(buildInboxTriageSection());
    } else {
      scroll.appendChild(buildEntriesSection(rules, rc));
    }
  } else if (state.activeTab === "objects") {
    scroll.appendChild(buildObjectsSection());
  } else if (state.activeTab === "rules") {
    scroll.appendChild(buildRulesSection(rules));
  } else if (state.activeTab === "inbox") {
    scroll.appendChild(buildInboxTriageSection());
  }

  main.appendChild(scroll);
  return main;
}

/* ==================== Right Properties Rail ==================== */

function buildPropList(rows) {
  const list = document.createElement("dl");
  list.className = "prop-list";
  for (const row of rows) {
    if (!row || row.value === undefined || row.value === null || row.value === "") continue;
    const item = document.createElement("div");
    item.className = "prop-row";
    const dt = document.createElement("dt");
    dt.className = "prop-label";
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.className = "prop-value" + (row.mono ? " mono" : "");

    if (row.copyValue) {
      const wrap = document.createElement("span");
      wrap.className = "prop-id-wrap";
      const valSpan = document.createElement("span");
      valSpan.className = "prop-id-text";
      valSpan.textContent = String(row.value);
      valSpan.title = String(row.value);
      const cpBtn = makeIconBtn(
        ICONS.copy(),
        row.copyLabel || st("copyId"),
        () => { void copyText(row.copyValue, st("copiedToast", row.copyValue)); },
        "prop-copy-btn",
      );
      cpBtn.dataset.ui = row.copyUi || "prop-copy-id";
      wrap.appendChild(valSpan);
      wrap.appendChild(cpBtn);
      dd.appendChild(wrap);
    } else if (typeof row.onClick === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prop-value-btn" + (row.mono ? " mono" : "");
      btn.textContent = String(row.value);
      btn.title = row.title || String(row.value);
      btn.addEventListener("click", row.onClick);
      dd.appendChild(btn);
    } else {
      dd.textContent = String(row.value);
      dd.title = row.title || String(row.value);
    }
    item.appendChild(dt);
    item.appendChild(dd);
    list.appendChild(item);
  }
  return list;
}

function buildInspector() {
  const aside = document.createElement("aside");
  aside.className = "inspector-col";
  aside.dataset.ui = "properties-rail";

  const focusEntry = state.openEntry || state.focusedEntry;

  const head = document.createElement("div");
  head.className = "inspector-head";
  const heading = document.createElement("span");
  heading.className = "inspector-heading";
  heading.textContent = state.selectedObject
    ? st("objectProperties")
    : (focusEntry ? st("properties") : st("realmProperties"));
  head.appendChild(heading);

  const headActions = document.createElement("div");
  headActions.className = "inspector-head-actions";
  if (focusEntry || state.selectedObject) {
    const actionsBtn = makeIconBtn(ICONS.dots(), st("actions"), (ev) => {
      ev.stopPropagation();
      state.popover = {
        kind: "rail-actions",
        anchorRect: rectOf(actionsBtn),
        placement: "below-end",
        entry: focusEntry || null,
        object: state.selectedObject || null,
      };
      renderPopoverLayer();
    });
    actionsBtn.dataset.ui = "rail-actions-trigger";
    headActions.appendChild(actionsBtn);
  }
  headActions.appendChild(makeIconBtn(ICONS.close(), st("closeInspector"), () => {
    state.inspectorOpen = false;
    state.inspectorPinned = false;
    render();
  }));
  head.appendChild(headActions);
  aside.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "inspector-scroll";

  // Mode 1: Object focus (optional metadata drawer — read-only, zero settle/rule mutation controls)
  if (state.selectedObject) {
    const card = state.selectedObject;
    const title = document.createElement("h3");
    title.className = "inspector-title";
    title.textContent = card.name || card.ref;
    scroll.appendChild(title);

    const objMeta = card.object || null;
    const rawAliases = Array.isArray(card.aliases)
      ? card.aliases
      : (Array.isArray(objMeta?.aliases) ? objMeta.aliases : []);
    const aliases = rawAliases.filter(Boolean);
    const stateVal = objMeta?.state
      ? (objMeta.stateLabel ? (objectStateLabel(objMeta.state) + " · " + objMeta.stateLabel) : objectStateLabel(objMeta.state))
      : null;

    scroll.appendChild(buildPropList([
      { label: st("propRef"), value: card.ref, mono: true, copyValue: card.ref, copyLabel: st("copyRef") },
      objMeta?.id ? { label: st("propId"), value: objMeta.id, mono: true, copyValue: objMeta.id, copyLabel: st("copyId") } : null,
      { label: st("propKind"), value: objectKindLabel(card.kind) },
      {
        label: st("propRealm"),
        value: card.realmPath,
        mono: true,
        onClick: card.realmPath ? () => { void selectRealm(card.realmPath, "entries"); } : null,
      },
      card.parentRef ? {
        label: st("propParent"),
        value: card.parentRef,
        mono: true,
        onClick: () => { void selectObjectByRef(card.parentRef, false); },
      } : null,
      stateVal ? { label: st("propState"), value: stateVal } : null,
      objMeta?.stateSince ? { label: st("propRecorded"), value: formatStamp(objMeta.stateSince), mono: true } : null,
    ]));

    if (aliases.length > 0) {
      const sec = document.createElement("div");
      sec.className = "rail-section";
      const lbl = document.createElement("div");
      lbl.className = "rail-section-head";
      lbl.textContent = st("propAliases");
      sec.appendChild(lbl);

      const chipWrap = document.createElement("div");
      chipWrap.className = "rail-chip-wrap";
      for (const alias of aliases) {
        const chip = document.createElement("span");
        chip.className = "rail-alias-chip";
        chip.textContent = String(alias);
        chipWrap.appendChild(chip);
      }
      sec.appendChild(chipWrap);
      scroll.appendChild(sec);
    }

    aside.appendChild(scroll);
    return aside;
  }

  // Mode 2: Entry focus
  if (focusEntry) {
    const e = focusEntry;
    const isRedacted = Boolean(e.redactedAt) || e.status === "retracted";
    const km = kindMeta(e.extKind || e.kind);
    const sm = statusMeta(e.status, isRedacted);

    if (!state.openEntry) {
      const title = document.createElement("h3");
      title.className = "inspector-title";
      title.textContent = isRedacted ? st("redactedTitle") : String(e.title || st("kindEntry"));
      scroll.appendChild(title);

      const snippet = isRedacted ? "" : String(e.snippet || e.body || "").trim();
      if (snippet) {
        const ex = document.createElement("p");
        ex.className = "rail-focus-excerpt";
        ex.textContent = snippet.slice(0, 220);
        scroll.appendChild(ex);
      }

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "meru-btn rail-open-btn";
      openBtn.dataset.ui = "rail-open-doc";
      openBtn.appendChild(ICONS.bookOpen());
      const lbl = document.createElement("span");
      lbl.textContent = st("openDocument");
      openBtn.appendChild(lbl);
      openBtn.addEventListener("click", () => { void openEntryInCenter(e.id); });
      scroll.appendChild(openBtn);
    }

    scroll.appendChild(buildPropList([
      { label: st("propId"), value: e.id, mono: true, copyValue: e.id, copyLabel: st("copyId"), copyUi: "inspector-copy-id" },
      { label: st("propKind"), value: km.label },
      { label: st("propStatus"), value: sm.label },
      {
        label: st("propRealm"),
        value: e.realmPath || state.activeRealmPath,
        mono: true,
        onClick: () => { void selectRealm(e.realmPath || state.activeRealmPath); },
      },
      { label: st("propAuthor"), value: formatAuthorName(e) || null },
      {
        label: st("propRecorded"),
        value: formatStamp(e.occurredAt || e.createdAt),
        mono: true,
      },
      { label: st("propSource"), value: e.sourceRef || null, mono: true },
    ]));

    // Linked Objects & Resource Tags — hidden when empty
    const objRefItems = Array.isArray(e.objectRefs) && e.objectRefs.length > 0
      ? e.objectRefs.map((o) => o.ref).filter(Boolean)
      : (Array.isArray(e.objectIds) ? e.objectIds : []);
    const linkedRefs = [
      ...objRefItems,
      ...(Array.isArray(e.refs) ? e.refs : []),
      ...(Array.isArray(e.resourceTags) ? e.resourceTags.map((t) => "#" + t) : []),
    ].filter(Boolean);
    const uniqueRefs = Array.from(new Set(linkedRefs));
    if (uniqueRefs.length > 0) {
      const sec = document.createElement("div");
      sec.className = "rail-section";
      const lbl = document.createElement("div");
      lbl.className = "rail-section-head";
      lbl.textContent = st("linkedRefs");
      sec.appendChild(lbl);

      const chipWrap = document.createElement("div");
      chipWrap.className = "rail-chip-wrap";
      for (const ref of uniqueRefs) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "rail-ref-chip";
        chip.textContent = ref;
        chip.addEventListener("click", () => {
          if (ref.startsWith("#")) {
            const rawTag = ref.slice(1);
            if (OBJECT_TAG_CHIP_RE.test(rawTag)) {
              void selectObjectByRef(rawTag, false);
            } else {
              void copyText(ref, st("copiedToast", ref));
            }
          } else {
            void selectObjectByRef(ref, false);
          }
        });
        chipWrap.appendChild(chip);
      }
      sec.appendChild(chipWrap);
      scroll.appendChild(sec);
    }

    // Supersede History — hidden if <= 1 revision
    if (state.selectedChain && Array.isArray(state.selectedChain.nodes) && state.selectedChain.nodes.length > 1) {
      const sec = document.createElement("div");
      sec.className = "rail-section";

      const chLabel = document.createElement("div");
      chLabel.className = "rail-section-head";
      const cLeft = document.createElement("span");
      cLeft.textContent = st("supersedeChain");
      const cRight = document.createElement("span");
      cRight.textContent = String(state.selectedChain.nodes.length);
      chLabel.appendChild(cLeft);
      chLabel.appendChild(cRight);
      sec.appendChild(chLabel);

      const rail = document.createElement("div");
      rail.className = "chain-rail";
      for (const n of state.selectedChain.nodes) {
        const nKm = kindMeta(n.extKind || n.kind);
        const nSm = statusMeta(n.status, Boolean(n.redactedAt) || n.status === "retracted");
        const node = document.createElement("button");
        node.type = "button";
        const isHead = n.id === state.selectedChain.currentHeadId;
        const isCurr = n.id === e.id;
        node.className = "chain-node" + (isHead ? " head" : "") + (isCurr ? " current" : "");
        const nt = document.createElement("div");
        nt.className = "chain-node-title";
        nt.textContent = n.title || st("kindEntry");
        const nm = document.createElement("div");
        nm.className = "chain-node-meta";
        nm.textContent = [
          isHead ? st("headTag") : null,
          nKm.label,
          nSm.notable ? nSm.label : null,
        ].filter(Boolean).join(" · ");
        node.appendChild(nt);
        node.appendChild(nm);
        node.addEventListener("click", () => { void openEntryInCenter(n.id); });
        rail.appendChild(node);
      }
      sec.appendChild(rail);
      scroll.appendChild(sec);
    }

    // Active Peers touching this realm/entry — hidden if 0 peers
    const entryRealm = e.realmPath || state.activeRealmPath;
    const relevantPeers = (state.pulses || []).filter(
      (p) =>
        p.active &&
        p.sessionId !== state.selfPulseSessionId &&
        (p.realmPath === entryRealm || (Array.isArray(p.focus) && p.focus.includes(e.id))),
    );
    if (relevantPeers.length > 0) {
      const sec = document.createElement("div");
      sec.className = "rail-section";
      const lbl = document.createElement("div");
      lbl.className = "rail-section-head";
      lbl.textContent = st("activePeers");
      sec.appendChild(lbl);
      const list = document.createElement("div");
      list.className = "rail-peer-list";
      for (const peer of relevantPeers.slice(0, 5)) {
        const pRow = document.createElement("div");
        pRow.className = "rail-peer-row";
        const dot = document.createElement("span");
        dot.className = "status-dot realm-live-dot";
        const who = document.createElement("span");
        who.className = "rail-peer-who";
        who.textContent = peer.clientHint ? (peer.actorId + " · " + peer.clientHint) : peer.actorId;
        const act = document.createElement("span");
        act.className = "rail-peer-act";
        act.textContent = peer.activity || peer.note || (peer.online ? st("nowTag") : formatPulseAge(peer.ageSeconds));
        pRow.appendChild(dot);
        pRow.appendChild(who);
        pRow.appendChild(act);
        list.appendChild(pRow);
      }
      sec.appendChild(list);
      scroll.appendChild(sec);
    }

    // Contextual CLI Governance Command Box — shown only on explicit request
    if (state.railCliCommand) {
      const cliBlock = document.createElement("div");
      cliBlock.className = "rail-section rail-cli-box";
      cliBlock.dataset.ui = "rail-cli-box";
      const top = document.createElement("div");
      top.className = "rail-section-head";
      const lbl = document.createElement("span");
      lbl.textContent = state.railCliCommand.label || "CLI";
      top.appendChild(lbl);
      top.appendChild(makeIconBtn(ICONS.close(), st("dismiss"), () => {
        state.railCliCommand = null;
        render();
      }));
      cliBlock.appendChild(top);

      const note = document.createElement("p");
      note.className = "cli-boundary-note";
      note.textContent = st("cliRequiresBearer");
      cliBlock.appendChild(note);

      const cmdRow = document.createElement("div");
      cmdRow.className = "cli-cmd-row";
      const cmdCode = document.createElement("code");
      cmdCode.className = "cli-cmd-text";
      cmdCode.textContent = state.railCliCommand.cmd;
      cmdCode.title = state.railCliCommand.cmd;
      cmdRow.appendChild(cmdCode);
      cmdRow.appendChild(makeIconBtn(ICONS.copy(), st("copyCmd"), () => copyText(state.railCliCommand.cmd)));
      cliBlock.appendChild(cmdRow);
      scroll.appendChild(cliBlock);
    }

    aside.appendChild(scroll);
    return aside;
  }

  // Mode 3: Realm properties (when inspector explicitly toggled open with nothing selected)
  const activeRealmObj = state.realms.find((r) => r.path === state.activeRealmPath);
  const rc = state.realmCounts[state.activeRealmPath] || {};
  const rulesCount = state.brief?.middleMind?.rules?.items?.length || 0;
  scroll.appendChild(buildPropList([
    { label: st("propPath"), value: state.activeRealmPath, mono: true },
    { label: st("propName"), value: realmDisplayName(activeRealmObj) },
    { label: st("propEntries"), value: fmtNum(rc.subtreeConclusions ?? rc.directConclusions ?? 0), mono: true },
    { label: st("propObjects"), value: fmtNum(rc.subtreeObjects ?? state.realmObjects.length), mono: true },
    { label: st("propRules"), value: fmtNum(rulesCount), mono: true },
  ]));

  const realmPeers = (state.pulses || []).filter(
    (p) => p.active && p.sessionId !== state.selfPulseSessionId && p.realmPath === state.activeRealmPath,
  );
  if (realmPeers.length > 0) {
    const sec = document.createElement("div");
    sec.className = "rail-section";
    const lbl = document.createElement("div");
    lbl.className = "rail-section-head";
    lbl.textContent = st("activePeers");
    sec.appendChild(lbl);
    const list = document.createElement("div");
    list.className = "rail-peer-list";
    for (const peer of realmPeers.slice(0, 6)) {
      const pRow = document.createElement("div");
      pRow.className = "rail-peer-row";
      const dot = document.createElement("span");
      dot.className = "status-dot realm-live-dot";
      const who = document.createElement("span");
      who.className = "rail-peer-who";
      who.textContent = peer.clientHint ? (peer.actorId + " · " + peer.clientHint) : peer.actorId;
      const act = document.createElement("span");
      act.className = "rail-peer-act";
      act.textContent = peer.activity || peer.note || (peer.online ? st("nowTag") : formatPulseAge(peer.ageSeconds));
      pRow.appendChild(dot);
      pRow.appendChild(who);
      pRow.appendChild(act);
      list.appendChild(pRow);
    }
    sec.appendChild(list);
    scroll.appendChild(sec);
  }

  aside.appendChild(scroll);
  return aside;
}

/* ==================== Popovers & Modals ==================== */

function formatSessionStateBadge(s) {
  const age = formatPulseAge(s.ageSeconds);
  if (s.state === "turn_ended") return st("sessTurnEnded", age);
  if (s.state === "silent") return st("sessSilent", age);
  if (s.state === "working" || (s.online && s.mode === "working")) return st("sessWorking");
  if (isBrowserSession(s) && (s.online || s.active)) return st("browsingTag");
  if (s.online) return st("sessOnline");
  if (s.active) return st("sessActive", age);
  return st("sessQuiet", age);
}

function buildPopoverSessionItem(s, opts = {}) {
  const item = document.createElement("div");
  item.className = "popover-session-item" + (opts.isChild ? " is-child" : "");

  const topRow = document.createElement("div");
  topRow.className = "popover-session-top";
  const leftMeta = document.createElement("span");
  leftMeta.className = "popover-session-client";
  const sDot = document.createElement("span");
  sDot.className = "status-dot" + (
    s.state === "working" || s.online ? "" : (s.state === "turn_ended" ? " paused" : (s.active ? " active" : " idle"))
  );
  const clientText = document.createElement("span");
  clientText.textContent = formatSessionDisplayLabel(s, opts.bucketCounts || null, { showActor: Boolean(opts.showActor) });
  if (s.sessionId) {
    clientText.title = String(s.sessionId);
    leftMeta.title = String(s.sessionId);
  }
  leftMeta.appendChild(sDot);
  leftMeta.appendChild(clientText);

  const ageMeta = document.createElement("span");
  ageMeta.className = "popover-session-age";
  ageMeta.textContent = formatSessionStateBadge(s);
  topRow.appendChild(leftMeta);
  topRow.appendChild(ageMeta);
  item.appendChild(topRow);

  if (s.activity) {
    const actEl = document.createElement("div");
    actEl.className = "popover-session-activity";
    actEl.textContent = s.activity;
    item.appendChild(actEl);
  }

  if (s.note) {
    const noteEl = document.createElement("div");
    noteEl.className = "popover-session-note";
    noteEl.textContent = s.note;
    item.appendChild(noteEl);
  }

  const targetRealm = s.realmPath || (s.focus && s.focus[0]) || "/";
  const realmLabel = formatHumanRealmPath(targetRealm);
  const realmBtn = document.createElement("button");
  realmBtn.type = "button";
  realmBtn.className = "popover-session-realm";
  realmBtn.title = targetRealm;
  realmBtn.appendChild(ICONS.arrowRight());
  const rSpan = document.createElement("span");
  rSpan.textContent = targetRealm === state.activeRealmPath
    ? (realmLabel + " · " + st("hereTag"))
    : realmLabel;
  realmBtn.appendChild(rSpan);
  realmBtn.addEventListener("click", () => {
    closePopover();
    void selectRealm(targetRealm);
  });
  item.appendChild(realmBtn);
  return item;
}

function renderPopover() {
  if (!state.popover) return null;
  const isWideCard = state.popover.kind === "member-card" || state.popover.kind === "work-card";
  const pop = document.createElement("div");
  pop.className = "floating-popover" + (isWideCard ? " wide" : "");
  pop.dataset.ui = "floating-popover";
  pop.dataset.popoverKind = state.popover.kind;
  pop.addEventListener("click", (ev) => ev.stopPropagation());

  if (state.popover.kind === "triage-picker") {
    const pickerEntryId = state.popover.entryId;
    const pickerSelected = state.popover.selected;
    const triggerValEl = state.popover.triggerValEl || null;
    pop.setAttribute("role", "listbox");
    pop.className += " realm-picker-menu";
    for (const target of state.popover.targets || []) {
      const isSelected = target.path === pickerSelected;
      const optBtn = document.createElement("button");
      optBtn.type = "button";
      optBtn.setAttribute("role", "option");
      optBtn.setAttribute("aria-selected", String(isSelected));
      optBtn.className = "menu-item realm-picker-option" + (isSelected ? " active" : "");
      const ico = document.createElement("span");
      ico.className = "realm-picker-check";
      if (isSelected) ico.appendChild(ICONS.check());
      const lbl = document.createElement("span");
      lbl.textContent = target.path;
      optBtn.appendChild(ico);
      optBtn.appendChild(lbl);
      optBtn.addEventListener("click", () => {
        state.triageTargets.set(pickerEntryId, target.path);
        if (triggerValEl) triggerValEl.textContent = target.path;
        closePopover();
      });
      pop.appendChild(optBtn);
    }
    return pop;
  }

  if (state.popover.kind === "work-card" && state.popover.work) {
    const w = state.popover.work;
    const head = document.createElement("div");
    head.className = "popover-head";
    const nm = document.createElement("div");
    nm.className = "popover-name";
    nm.textContent = w.label;
    const sub = document.createElement("div");
    sub.className = "popover-sub" + (w.hasCollision ? " collision" : "");
    sub.textContent = w.hasCollision
      ? (w.key + " · " + w.workingRoots + " " + st("collisionNote"))
      : (w.key + " · " + w.participants.length + " " + (w.participants.length === 1 ? st("sessionSingle") : st("sessionsPlural")));
    head.appendChild(nm);
    head.appendChild(sub);
    pop.appendChild(head);

    const byId = new Map(w.participants.map((p) => [p.sessionId, p]));
    const bucketCounts = countSessionClientBuckets(w.participants);
    const childrenByParent = new Map();
    const roots = [];
    for (const p of w.participants) {
      if (p.parentSessionId && byId.has(p.parentSessionId)) {
        let arr = childrenByParent.get(p.parentSessionId);
        if (!arr) {
          arr = [];
          childrenByParent.set(p.parentSessionId, arr);
        }
        arr.push(p);
      } else {
        roots.push(p);
      }
    }

    const list = document.createElement("div");
    list.className = "popover-session-list";
    for (const r of roots) {
      list.appendChild(buildPopoverSessionItem(r, { showActor: true, isChild: false, bucketCounts }));
      const kids = childrenByParent.get(r.sessionId) || [];
      for (const k of kids) {
        list.appendChild(buildPopoverSessionItem(k, { showActor: true, isChild: true, bucketCounts }));
      }
    }
    pop.appendChild(list);
    return pop;
  }

  if (state.popover.kind === "rail-actions") {
    const entry = state.popover.entry;
    const obj = state.popover.object;
    const addAction = (iconEl, label, onClick, isDanger = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item" + (isDanger ? " danger" : "");
      b.appendChild(iconEl);
      const sp = document.createElement("span");
      sp.textContent = label;
      b.appendChild(sp);
      b.addEventListener("click", () => {
        closePopover();
        onClick();
      });
      pop.appendChild(b);
    };

    if (entry) {
      addAction(ICONS.copy(), st("copyId"), () => {
        void copyText(entry.id, st("copiedToast", entry.id));
      });
      addAction(ICONS.link(), st("copyLink"), () => {
        const u = new URL(window.location.href);
        const targetRealm = entry.realmPath || state.activeRealmPath || "/";
        u.pathname = targetRealm;
        u.search = "?entry=" + encodeURIComponent(entry.id);
        void copyText(u.toString(), st("copiedLinkToast"));
      });
      const moveCmd = "meru-mind entry move " + entry.id + " --to /target-realm";
      addAction(ICONS.terminal(), st("cliMoveCmd"), () => {
        state.railCliCommand = { label: st("cliMoveLabel"), cmd: moveCmd };
        render();
        void copyText(moveCmd, st("copiedCmdToast"));
      });
      const redactCmd = "meru-mind redact " + entry.id + ' --reason "compliance"';
      addAction(ICONS.terminal(), st("cliRedactCmd"), () => {
        state.railCliCommand = { label: st("cliRedactLabel"), cmd: redactCmd };
        render();
        void copyText(redactCmd, st("copiedCmdToast"));
      }, true);
    } else if (obj) {
      addAction(ICONS.copy(), st("copyRef"), () => {
        void copyText(obj.ref, st("copiedToast", obj.ref));
      });
      addAction(ICONS.link(), st("copyLink"), () => {
        const u = new URL(window.location.href);
        u.pathname = obj.realmPath || state.activeRealmPath || "/";
        u.search = "?object=" + encodeURIComponent(obj.ref);
        void copyText(u.toString(), st("copiedLinkToast"));
      });
    }
    return pop;
  }

  if (state.popover.kind === "profile") {
    const head = document.createElement("div");
    head.className = "popover-head";
    const nm = document.createElement("div");
    nm.className = "popover-name";
    nm.textContent = state.whoami.actor.displayName || state.whoami.actor.id;
    const sub = document.createElement("div");
    sub.className = "popover-sub profile-meta-row";
    const handleSpan = document.createElement("span");
    handleSpan.textContent = "@" + state.whoami.actor.id;
    const roleBadge = document.createElement("span");
    roleBadge.className = "profile-role-badge" + (state.whoami.actor.role === "admin" ? " is-admin" : "");
    roleBadge.textContent = state.whoami.actor.role === "admin" ? st("roleAdmin") : st("roleMember");
    const kindSpan = document.createElement("span");
    kindSpan.textContent = "· " + (state.whoami.actor.kind === "human" ? st("actorHuman") : st("actorAgent"));
    sub.appendChild(handleSpan);
    sub.appendChild(roleBadge);
    sub.appendChild(kindSpan);
    head.appendChild(nm);
    head.appendChild(sub);
    pop.appendChild(head);

    const editForm = document.createElement("form");
    editForm.className = "profile-edit-form";
    const editLabel = document.createElement("label");
    editLabel.className = "profile-edit-label";
    editLabel.textContent = st("displayNameLabel");
    const editRow = document.createElement("div");
    editRow.className = "profile-edit-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "profile-name-input";
    nameInput.maxLength = 64;
    nameInput.autocomplete = "off";
    nameInput.value = state.whoami.actor.displayName || "";
    nameInput.placeholder = "@" + state.whoami.actor.id;
    nameInput.setAttribute("aria-label", st("displayNameLabel"));
    nameInput.dataset.ui = "profile-display-name-input";
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "profile-save-btn";
    saveBtn.dataset.ui = "profile-save-btn";
    saveBtn.textContent = st("save");
    editRow.appendChild(nameInput);
    editRow.appendChild(saveBtn);
    const errEl = document.createElement("div");
    errEl.className = "profile-edit-error";
    editForm.appendChild(editLabel);
    editForm.appendChild(editRow);
    editForm.appendChild(errEl);
    editForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      errEl.textContent = "";
      saveBtn.disabled = true;
      saveBtn.textContent = st("saving");
      try {
        const nextRaw = nameInput.value.trim();
        const res = await client.profile.updateDisplayName(nextRaw || null);
        if (state.whoami && state.whoami.actor) {
          if (res.displayName) {
            state.whoami.actor.displayName = res.displayName;
          } else {
            delete state.whoami.actor.displayName;
          }
          if (res.role) {
            state.whoami.actor.role = res.role;
          }
        }
        const nextDisplay = state.whoami.actor.displayName || state.whoami.actor.id;
        const dockLbl = document.querySelector('[data-ui="profile-trigger"] .actor-label');
        if (dockLbl) dockLbl.textContent = nextDisplay;
        const dockAv = document.querySelector('[data-ui="profile-trigger"] .avatar-circle');
        if (dockAv) dockAv.textContent = String(nextDisplay || "U").slice(0, 1).toUpperCase();
        showToast(st("displayNameSaved"));
        renderPopoverLayer();
      } catch (err) {
        errEl.textContent = (err && err.message) ? String(err.message) : st("saveFailed");
        saveBtn.disabled = false;
        saveBtn.textContent = st("save");
        positionPopoverElement(pop, state.popover);
      }
    });
    pop.appendChild(editForm);

    const signOut = document.createElement("button");
    signOut.type = "button";
    signOut.className = "menu-item danger";
    signOut.appendChild(ICONS.logout());
    const t = document.createElement("span");
    t.textContent = st("signOut");
    signOut.appendChild(t);
    signOut.addEventListener("click", async () => {
      closePopover();
      teardownStudioReader();
      client.pump.stop();
      await client.logout();
      state.whoami = null;
      render();
    });
    pop.appendChild(signOut);
    return pop;
  }

  const group = state.popover.group || (state.popover.pulse ? {
    actorId: state.popover.pulse.actorId,
    actorKind: state.popover.pulse.actorKind,
    online: state.popover.pulse.online,
    active: state.popover.pulse.active,
    sessions: [state.popover.pulse],
  } : null);

  if (state.popover.kind === "member-card" && group) {
    const head = document.createElement("div");
    head.className = "popover-head";
    const nm = document.createElement("div");
    nm.className = "popover-name";
    nm.textContent = group.actorId;
    const sub = document.createElement("div");
    sub.className = "popover-sub";
    const countLabel = group.sessions.length + " " + (group.sessions.length === 1 ? st("sessionSingle") : st("sessionsPlural"));
    const actorKindLabel = group.actorKind === "human" ? st("actorHumanMember") : st("actorAgent");
    sub.textContent = actorKindLabel + " · " + countLabel;
    head.appendChild(nm);
    head.appendChild(sub);
    pop.appendChild(head);

    const bucketCounts = countSessionClientBuckets(group.sessions);
    const list = document.createElement("div");
    list.className = "popover-session-list";
    for (const s of group.sessions) {
      list.appendChild(buildPopoverSessionItem(s, { showActor: false, isChild: Boolean(s.parentSessionId), bucketCounts }));
    }
    pop.appendChild(list);
    return pop;
  }

  if (state.popover.kind === "member-menu" && group) {
    const seenRealms = new Set();
    for (const s of group.sessions) {
      const rp = s.realmPath || "/";
      if (seenRealms.has(rp)) continue;
      seenRealms.add(rp);
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "menu-item";
      jump.appendChild(ICONS.arrowRight());
      const jSpan = document.createElement("span");
      jSpan.textContent = st("openRealmPrefix") + " " + formatHumanRealmPath(rp);
      jump.appendChild(jSpan);
      jump.addEventListener("click", () => {
        closePopover();
        void selectRealm(rp);
      });
      pop.appendChild(jump);
    }

    const cp = document.createElement("button");
    cp.type = "button";
    cp.className = "menu-item";
    cp.appendChild(ICONS.copy());
    const cSpan = document.createElement("span");
    cSpan.textContent = st("copyActorId");
    cp.appendChild(cSpan);
    cp.addEventListener("click", () => {
      closePopover();
      void copyText(group.actorId, st("copiedToast", group.actorId));
    });

    pop.appendChild(cp);
    return pop;
  }

  return null;
}

function openSearchModal() {
  closePopover();
  state.modal = "search";
  renderModalLayer();
  const inp = document.getElementById("studio-search-input");
  if (inp) inp.focus();
}

function composerTitlePlaceholderForKind(kind) {
  if (kind === "decision") return st("composerPlaceholderDecision");
  if (kind === "proposal") return st("composerPlaceholderProposal");
  return st("composerPlaceholderFinding");
}

function parseSecretGuardError(err) {
  const msg = String(err?.message || "");
  const isSecret = /plaintext credential|secret_detected|non-secret memory|--sensitivity secret/i.test(msg);
  if (!isSecret) return null;
  const m = /\(([^()]+)\)\s+in non-secret memory/i.exec(msg);
  return st("composerSecretBlocked", m ? m[1] : "");
}

async function submitComposer() {
  if (state.writeSubmitting) return;
  if (!state.writeTitle.trim()) {
    state.writeError = { kind: "error", text: st("composerTitleRequired") };
    renderModalLayer();
    requestAnimationFrame(() => {
      const inp = document.getElementById("composer-title-input");
      if (inp) inp.focus();
    });
    return;
  }
  state.writeSubmitting = true;
  state.writeError = null;
  renderModalLayer();
  try {
    const res = await client.write({
      kind: state.writeKind,
      title: state.writeTitle.trim(),
      body: state.writeBody.trim(),
      in: state.activeRealmPath,
    });
    state.writeTitle = "";
    state.writeBody = "";
    state.writeSubmitting = false;
    state.writeError = null;
    closeModal();
    showToast(st("composerSavedToast", state.activeRealmPath));
    await refreshAll();
    if (res?.record?.id) await openEntryInCenter(res.record.id);
  } catch (err) {
    state.writeSubmitting = false;
    const secretNotice = parseSecretGuardError(err);
    if (secretNotice) {
      state.writeError = { kind: "secret", text: secretNotice };
    } else {
      state.writeError = {
        kind: "error",
        text: err?.cliCommand
          ? (err.message + " — " + err.cliCommand)
          : (err?.message || st("composerWriteFailed")),
      };
    }
    renderModalLayer();
  }
}

function renderModal() {
  if (!state.modal) return null;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) {
      closeModal();
    }
  });

  const panel = document.createElement("div");
  panel.className = "modal-panel" + (state.modal === "write" ? " composer-panel" : "");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  if (state.modal === "search") {
    const head = document.createElement("div");
    head.className = "search-header";
    head.appendChild(ICONS.search());

    const inp = document.createElement("input");
    inp.id = "studio-search-input";
    inp.className = "search-input";
    inp.type = "search";
    inp.placeholder = st("searchModalPlaceholder");
    inp.value = state.searchQuery;
    inp.addEventListener("input", () => {
      state.searchQuery = inp.value;
    });
    inp.addEventListener("keydown", async (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeModal();
      } else if (ev.key === "Enter") {
        state.searchQuery = inp.value.trim();
        if (!state.searchQuery) return;
        try {
          state.searchResults = await client.search(state.searchQuery, { limit: 15 });
          renderModalLayer(true);
          const nextInp = document.getElementById("studio-search-input");
          if (nextInp) nextInp.focus();
        } catch (err) {
          showToast(err?.message || st("searchFailed"));
        }
      }
    });
    head.appendChild(inp);
    head.appendChild(makeIconBtn(ICONS.close(), st("searchClose"), () => {
      closeModal();
    }));
    panel.appendChild(head);

    const body = document.createElement("div");
    body.className = "modal-body";
    const items = state.searchResults?.items || [];
    if (!state.searchResults) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      hint.textContent = st("searchHint");
      body.appendChild(hint);
    } else if (items.length === 0) {
      const none = document.createElement("div");
      none.className = "empty-state";
      none.textContent = st("searchNoResults", state.searchQuery);
      body.appendChild(none);
    } else {
      for (const item of items) {
        const hl = state.searchResults.highlights?.[item.id] || null;
        const km = kindMeta(item.extKind || item.kind);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "search-result-row";

        const top = document.createElement("div");
        top.className = "search-result-top";
        const leftTitle = document.createElement("span");
        leftTitle.className = "search-result-title-wrap";
        leftTitle.appendChild(km.icon(13));
        const tEl = document.createElement("span");
        tEl.className = "search-result-title";
        if (hl?.titleRanges?.length) {
          tEl.appendChild(applyHighlightRanges(item.title || st("kindEntry"), hl.titleRanges));
        } else {
          tEl.textContent = String(item.title || st("kindEntry"));
        }
        leftTitle.appendChild(tEl);

        const tag = document.createElement("span");
        tag.className = "origin-tag";
        tag.textContent = km.label + " · " + (item.realmPath || "/");
        top.appendChild(leftTitle);
        top.appendChild(tag);
        row.appendChild(top);

        if (item.snippet) {
          const sn = document.createElement("p");
          sn.className = "search-result-snippet";
          if (hl?.snippetRanges?.length) {
            sn.appendChild(applyHighlightRanges(item.snippet, hl.snippetRanges));
          } else {
            sn.textContent = item.snippet;
          }
          row.appendChild(sn);
        }

        row.addEventListener("click", () => {
          closeModal();
          void openEntryInCenter(item.id);
        });
        body.appendChild(row);
      }
    }
    panel.appendChild(body);
  } else if (state.modal === "write") {
    panel.dataset.ui = "composer-modal";

    const head = document.createElement("div");
    head.className = "composer-header";
    const ctx = document.createElement("span");
    ctx.className = "composer-context";
    ctx.textContent = st("composerTitle", state.activeRealmPath);
    head.appendChild(ctx);
    head.appendChild(makeIconBtn(ICONS.close(), st("composerClose"), () => {
      // Keep draft intact when dismissing
      closeModal();
    }));
    panel.appendChild(head);

    const body = document.createElement("div");
    body.className = "composer-body";

    const titleInp = document.createElement("input");
    titleInp.id = "composer-title-input";
    titleInp.type = "text";
    titleInp.className = "composer-title-input";
    titleInp.dataset.ui = "composer-title-input";
    titleInp.placeholder = composerTitlePlaceholderForKind(state.writeKind);
    titleInp.value = state.writeTitle;
    titleInp.autocomplete = "off";
    titleInp.addEventListener("input", () => {
      state.writeTitle = titleInp.value;
      if (state.writeError) {
        state.writeError = null;
        const alertEl = panel.querySelector(".composer-inline-alert");
        if (alertEl) alertEl.remove();
      }
    });
    body.appendChild(titleInp);

    const bodyTa = document.createElement("textarea");
    bodyTa.id = "composer-body-textarea";
    bodyTa.className = "composer-body-textarea";
    bodyTa.dataset.ui = "composer-body-textarea";
    bodyTa.placeholder = st("composerBodyPlaceholder");
    bodyTa.value = state.writeBody;
    bodyTa.addEventListener("input", () => {
      state.writeBody = bodyTa.value;
      if (state.writeError) {
        state.writeError = null;
        const alertEl = panel.querySelector(".composer-inline-alert");
        if (alertEl) alertEl.remove();
      }
    });
    body.appendChild(bodyTa);

    if (state.writeError) {
      const alertBox = document.createElement("div");
      alertBox.className = "composer-inline-alert" + (state.writeError.kind === "secret" ? " is-secret" : "");
      alertBox.setAttribute("role", "alert");
      if (state.writeError.kind === "secret") {
        alertBox.dataset.ui = "composer-secret-warning";
      }
      alertBox.textContent = state.writeError.text;
      body.appendChild(alertBox);
    }

    panel.appendChild(body);

    const foot = document.createElement("div");
    foot.className = "composer-footer";

    // Quiet 3-way certainty-family icon segmented selector (zero native OS <select>)
    const kindSwitcher = document.createElement("div");
    kindSwitcher.className = "kind-switcher";
    kindSwitcher.dataset.ui = "composer-kind-switcher";
    kindSwitcher.setAttribute("role", "radiogroup");
    kindSwitcher.setAttribute("aria-label", st("composerKindLabel"));

    const kindOptions = ["finding", "decision", "proposal"];
    const kindBtns = [];
    const applyKindSelection = (nextKind) => {
      state.writeKind = nextKind;
      titleInp.placeholder = composerTitlePlaceholderForKind(nextKind);
      for (const kb of kindBtns) {
        const active = kb.dataset.kind === nextKind;
        kb.classList.toggle("active", active);
        kb.setAttribute("aria-checked", String(active));
        kb.setAttribute("aria-pressed", String(active));
      }
    };

    kindOptions.forEach((k, idx) => {
      const km = kindMeta(k);
      const kb = document.createElement("button");
      kb.type = "button";
      const isAct = state.writeKind === k;
      kb.className = "kind-switcher-btn" + (isAct ? " active" : "");
      kb.dataset.kind = k;
      kb.setAttribute("role", "radio");
      kb.setAttribute("aria-checked", String(isAct));
      kb.setAttribute("aria-pressed", String(isAct));
      kb.appendChild(km.icon(14));
      const lbl = document.createElement("span");
      lbl.textContent = km.label;
      kb.appendChild(lbl);
      kb.addEventListener("click", () => applyKindSelection(k));
      kb.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
          ev.preventDefault();
          const nextIdx = (idx + 1) % kindOptions.length;
          applyKindSelection(kindOptions[nextIdx]);
          kindBtns[nextIdx].focus();
        } else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
          ev.preventDefault();
          const prevIdx = (idx - 1 + kindOptions.length) % kindOptions.length;
          applyKindSelection(kindOptions[prevIdx]);
          kindBtns[prevIdx].focus();
        }
      });
      kindBtns.push(kb);
      kindSwitcher.appendChild(kb);
    });
    foot.appendChild(kindSwitcher);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "meru-btn primary composer-submit-btn";
    saveBtn.dataset.ui = "composer-submit";
    saveBtn.disabled = state.writeSubmitting;
    const saveText = document.createElement("span");
    saveText.textContent = state.writeSubmitting ? st("composerSaving") : st("composerSave");
    saveBtn.appendChild(saveText);
    if (!state.writeSubmitting) {
      const kbd = document.createElement("span");
      kbd.className = "composer-kbd";
      kbd.textContent = "⌘↵";
      saveBtn.appendChild(kbd);
    }
    saveBtn.addEventListener("click", () => { void submitComposer(); });
    foot.appendChild(saveBtn);

    panel.appendChild(foot);

    panel.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        void submitComposer();
      }
    });
  } else if (state.modal === "settings") {
    const head = document.createElement("div");
    head.className = "inspector-head";
    const h = document.createElement("span");
    h.className = "inspector-heading";
    h.textContent = st("settings");
    head.appendChild(h);
    head.appendChild(makeIconBtn(ICONS.close(), st("closeSettings"), () => {
      closeModal();
    }));
    panel.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "settings-grid";

    const nav = document.createElement("div");
    nav.className = "settings-nav";
    for (const item of [
      { id: "appearance", label: st("appearance") },
      { id: "realtime", label: st("realtimeAuth") },
      { id: "shortcuts", label: st("shortcuts") },
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-nav-btn" + (state.settingsTab === item.id ? " active" : "");
      b.textContent = item.label;
      b.addEventListener("click", () => {
        state.settingsTab = item.id;
        renderModalLayer();
      });
      nav.appendChild(b);
    }
    grid.appendChild(nav);

    const pane = document.createElement("div");
    pane.className = "settings-pane";

    const addSettingRow = (titleText, descText, controlEl) => {
      const r = document.createElement("div");
      r.className = "setting-row";
      const info = document.createElement("div");
      const t = document.createElement("div");
      t.className = "setting-title";
      t.textContent = titleText;
      const d = document.createElement("div");
      d.className = "setting-desc";
      d.textContent = descText;
      info.appendChild(t);
      info.appendChild(d);
      r.appendChild(info);
      r.appendChild(controlEl);
      pane.appendChild(r);
    };

    if (state.settingsTab === "appearance") {
      const currentTheme = document.documentElement.dataset.theme || "light";
      const themeControl = createChoiceGroup({
        uiId: "settings-theme-choice",
        ariaLabel: st("themeTitle"),
        activeKey: currentTheme,
        options: [
          { key: "light", label: st("themeLight") },
          { key: "dark", label: st("themeDark") },
        ],
        onChange: (val) => {
          applyTheme(val);
        },
      });
      addSettingRow(st("themeTitle"), st("themeDesc"), themeControl);

      const langControl = createChoiceGroup({
        uiId: "settings-lang-choice",
        ariaLabel: st("language"),
        activeKey: state.lang,
        options: [
          { key: "zh-CN", label: "简体中文" },
          { key: "en", label: "English" },
        ],
        onChange: (val) => {
          state.lang = val;
          document.documentElement.lang = state.lang;
          localStorage.setItem("meru-studio-lang", state.lang);
          render();
        },
      });
      addSettingRow(st("language"), st("languageDesc"), langControl);
    } else if (state.settingsTab === "realtime") {
      const statusBadge = document.createElement("span");
      statusBadge.className = "meta-val";
      statusBadge.textContent = realtimeStatusLabel(state.pumpStatus) + " · #" + state.pumpCursorSeq;
      addSettingRow(st("transportTitle"), st("transportDesc"), statusBadge);

      const authBadge = document.createElement("span");
      authBadge.className = "meta-val";
      authBadge.textContent = st("sessionScopeVal");
      addSettingRow(st("sessionScopeTitle"), st("sessionScopeDesc"), authBadge);
    } else {
      for (const [k, desc] of [
        ["⌘K", st("scSearch")],
        ["C / N", st("scCompose")],
        ["J / K", st("scStep")],
        ["Enter", st("scOpen")],
        ["Esc", st("scEsc")],
        ["R", st("scRefresh")],
        ["[", st("scInspector")],
        ["⌘,", st("scSettings")],
      ]) {
        const keycap = document.createElement("span");
        keycap.className = "kbd-hint";
        keycap.textContent = k;
        addSettingRow(desc, st("shortcutHint"), keycap);
      }
    }

    grid.appendChild(pane);
    panel.appendChild(grid);
  }

  backdrop.appendChild(panel);
  return backdrop;
}

/* ==================== Root Render ==================== */

function render() {
  if (!state.whoami) {
    closePopover();
    closeModal();
    renderAuthScreen();
    return;
  }

  const scrollSelectors = [
    ".workspace-scroll",
    ".reader-scroll",
    ".sidebar-scroll",
    ".presence-scroll",
    ".inspector-scroll",
  ];
  const scrollSnapshot = {};
  for (const sel of scrollSelectors) {
    const el = app.querySelector(sel);
    if (el) scrollSnapshot[sel] = el.scrollTop;
  }
  const prevViewKey = state.lastWorkspaceViewKey;
  const nextViewKey =
    (state.activeRealmPath || "/") + "|" + (state.activeTab || "entries") + "|" + (state.openEntry?.id || "") + "|" + (state.selectedObject?.ref || "");
  const viewKeyChanged = prevViewKey !== nextViewKey;
  state.lastWorkspaceViewKey = nextViewKey;

  clearEl(app);

  const shell = document.createElement("div");
  shell.className = "studio-shell" + (state.mobileNavOpen ? " mobile-nav-open" : "");

  const scrim = document.createElement("div");
  scrim.className = "sidebar-scrim";
  scrim.addEventListener("click", () => {
    state.mobileNavOpen = false;
    render();
  });

  const sheet = document.createElement("div");
  sheet.className = "studio-sheet" + (state.inspectorOpen ? "" : " inspector-hidden");
  sheet.appendChild(buildWorkspace());
  if (state.inspectorOpen) {
    sheet.appendChild(buildInspector());
  }

  shell.appendChild(buildSidebar());
  shell.appendChild(scrim);
  shell.appendChild(buildTopbar());
  shell.appendChild(sheet);
  app.appendChild(shell);

  for (const sel of scrollSelectors) {
    const el = shell.querySelector(sel);
    if (!el) continue;
    if (sel === ".workspace-scroll") {
      if (state.restoreListScrollPending) {
        state.restoreListScrollPending = false;
        el.scrollTop = state.savedListScrollTop;
      } else if (!viewKeyChanged && typeof scrollSnapshot[sel] === "number") {
        el.scrollTop = scrollSnapshot[sel];
      } else {
        el.scrollTop = 0;
      }
    } else if (sel === ".reader-scroll") {
      el.scrollTop = !viewKeyChanged && typeof scrollSnapshot[sel] === "number" ? scrollSnapshot[sel] : 0;
    } else if (typeof scrollSnapshot[sel] === "number") {
      el.scrollTop = scrollSnapshot[sel];
    }
  }

  renderPopoverLayer(false);
  renderModalLayer(false);
}

/* ==================== Keyboard Shortcuts & Pump ==================== */

document.addEventListener("click", () => {
  if (state.popover) closePopover();
});

window.addEventListener("resize", () => {
  if (state.popover) closePopover();
});

document.addEventListener(
  "scroll",
  (ev) => {
    if (!state.popover) return;
    const layer = document.getElementById("meru-popover-layer");
    if (layer && ev.target instanceof Node && layer.contains(ev.target)) return;
    closePopover();
  },
  true,
);

window.addEventListener("keydown", (ev) => {
  const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : "";
  const inInput = tag === "input" || tag === "textarea" || Boolean(ev.target && ev.target.isContentEditable);

  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    if (state.modal === "search") {
      closeModal();
    } else {
      openSearchModal();
    }
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === ",") {
    ev.preventDefault();
    closePopover();
    state.modal = state.modal === "settings" ? null : "settings";
    renderModalLayer();
    return;
  }
  if (ev.key === "Escape") {
    if (state.modal) {
      // Closing composer via Esc preserves state.writeTitle / state.writeBody draft
      closeModal();
      closePopover();
    } else if (state.popover) {
      closePopover();
    } else if (state.openEntry) {
      closeReaderToList();
    } else if (state.focusedEntryId || state.focusedObjectRef) {
      state.focusedEntryId = null;
      state.focusedEntry = null;
      state.focusedObjectRef = null;
      state.selectedObject = null;
      state.selectedChain = null;
      if (!state.inspectorPinned) {
        state.inspectorOpen = false;
      }
      syncUrlFromState(true);
      render();
    }
    return;
  }
  if (inInput || state.modal) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

  const lowKey = ev.key.toLowerCase();
  if (lowKey === "j" || lowKey === "k") {
    const list = getVisibleListEntries();
    if (list.length === 0) return;
    ev.preventDefault();
    const curId = state.openEntry?.id || state.focusedEntryId;
    const idx = curId ? list.findIndex((x) => x.id === curId) : -1;
    let nextIdx;
    if (lowKey === "j") {
      nextIdx = idx < 0 ? 0 : Math.min(list.length - 1, idx + 1);
    } else {
      nextIdx = idx < 0 ? list.length - 1 : Math.max(0, idx - 1);
    }
    const target = list[nextIdx];
    if (!target || target.id === curId) return;
    if (state.openEntry) {
      void openEntryInCenter(target.id);
    } else {
      void focusEntryInList(target.id, target);
    }
  } else if (ev.key === "Enter" && !state.openEntry && state.focusedEntryId) {
    if (tag !== "button" && tag !== "a") {
      ev.preventDefault();
      void openEntryInCenter(state.focusedEntryId);
    }
  } else if (lowKey === "r") {
    void refreshAll();
  } else if (lowKey === "c" || lowKey === "n") {
    ev.preventDefault();
    openWriteModal();
  } else if (ev.key === "[") {
    state.inspectorOpen = !state.inspectorOpen;
    state.inspectorPinned = state.inspectorOpen;
    render();
  }
});

window.addEventListener("popstate", () => {
  if (!state.whoami) return;
  void applyUrlStateFromLocation();
});

async function applyUrlStateFromLocation() {
  const parsed = parseUrlState();
  const targetRealm = state.realms.some((r) => r.path === parsed.realmPath)
    ? parsed.realmPath
    : (state.realms[0]?.path || "/");
  if (targetRealm !== state.activeRealmPath || (!parsed.objectRef && parsed.tab && parsed.tab !== state.activeTab)) {
    await selectRealm(targetRealm, parsed.tab || undefined, {
      keepReader: Boolean(parsed.entryId),
      keepObject: Boolean(parsed.objectRef),
      skipUrlSync: true,
    });
  }
  if (parsed.entryId) {
    if (parsed.objectRef && state.previousObject?.ref !== parsed.objectRef && state.selectedObject?.ref !== parsed.objectRef) {
      await selectObjectByRef(parsed.objectRef, false, {
        skipUrlSync: true,
        skipRender: true,
        silent: true,
      });
    }
    if (state.openEntry?.id !== parsed.entryId || (parsed.view && parsed.view !== state.readerView)) {
      await openEntryInCenter(parsed.entryId, {
        fromObject: Boolean(parsed.objectRef),
        requestedView: parsed.view,
        skipUrlSync: true,
      });
    }
  } else if (parsed.objectRef) {
    if (state.openEntry && state.previousObject?.ref === parsed.objectRef) {
      closeReaderToList({ skipUrlSync: true });
    } else if (state.selectedObject?.ref === parsed.objectRef && !state.openEntry) {
      if (!state.inspectorPinned) state.inspectorOpen = false;
      render();
    } else {
      await selectObjectByRef(parsed.objectRef, false, { skipUrlSync: true });
    }
  } else if (state.openEntry) {
    closeReaderToList({ skipUrlSync: true, ignorePreviousObject: true });
  } else if (state.selectedObject || state.previousObject) {
    teardownObjectNarrativeMarkdown();
    state.selectedObject = null;
    state.selectedObjectActivePeers = [];
    state.previousObject = null;
    state.focusedObjectRef = null;
    if (!state.inspectorPinned) state.inspectorOpen = false;
    render();
  }
}

client.pump.subscribe((snap) => {
  const prevStatus = state.pumpStatus;
  state.pumpStatus = snap.status;
  state.pumpGeneration = snap.generation ?? state.pumpGeneration;
  state.pumpCursorSeq = snap.cursorSeq ?? state.pumpCursorSeq;
  if (snap.status === "auth-required") {
    state.whoami = null;
    render();
    return;
  }
  const lamp = document.querySelector('[data-ui="ws-connection-status"]');
  if (lamp) {
    lamp.dataset.status = snap.status;
    lamp.title = st("realtimeStatusPrefix") + ": " + realtimeStatusLabel(snap.status);
  } else if (prevStatus !== snap.status) {
    render();
  }
  if (snap.lastFrames && snap.lastFrames.length > 0) {
    void refreshAll({ keepReader: Boolean(state.openEntry), skipUrlSync: true, background: true });
  }
});

async function studioPulseKeepaliveTick() {
  if (!state.whoami || document.visibilityState !== "visible") return;
  try {
    const focusTarget = state.selectedObject?.ref || state.activeRealmPath;
    const pulseRealm = getWritablePulseRealm(state.activeRealmPath);
    const selfPulse = await client.pulse.setFocus([focusTarget], null, pulseRealm, "browser").catch(() => null);
    if (selfPulse?.sessionId) state.selfPulseSessionId = selfPulse.sessionId;
    const pulseRes = await client.pulse.list().catch(() => null);
    if (pulseRes?.pulses) {
      applyPulsePayload(pulseRes, true);
      if (!state.presenceHovered) {
        updatePresencePanel();
      }
    }
  } catch {
    // quiet failure on background pulse tick
  }
}

setInterval(() => {
  void studioPulseKeepaliveTick();
}, 40000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void studioPulseKeepaliveTick();
  }
});

async function boot() {
  try {
    const sessRes = await fetch("/_meru/session", { credentials: "same-origin" });
    const sess = sessRes.ok ? await sessRes.json() : { authenticated: false };
    state.oidcEnabled = Boolean(sess.oidcEnabled);
    state.oidcLoginUrl = typeof sess.oidcLoginUrl === "string" ? sess.oidcLoginUrl : null;
    if (!sess.authenticated) {
      state.whoami = null;
      render();
      return;
    }
    state.whoami = await client.whoami();
    const initialUrl = parseUrlState();
    await refreshAll({
      realmPath: initialUrl.realmPath,
      tab: initialUrl.tab || undefined,
      keepReader: Boolean(initialUrl.entryId),
      skipUrlSync: true,
    });
    if (initialUrl.entryId) {
      if (initialUrl.objectRef) {
        await selectObjectByRef(initialUrl.objectRef, false, {
          skipUrlSync: true,
          skipRender: true,
          silent: true,
        });
      }
      await openEntryInCenter(initialUrl.entryId, {
        fromObject: Boolean(initialUrl.objectRef),
        requestedView: initialUrl.view,
        replaceUrl: true,
      });
    } else if (initialUrl.objectRef) {
      await selectObjectByRef(initialUrl.objectRef, false, { replaceUrl: true });
    } else {
      syncUrlFromState(true);
    }
    client.pump.start(state.whoami.latestSeq || 0);
  } catch {
    state.whoami = null;
    render();
  }
}

void boot();
