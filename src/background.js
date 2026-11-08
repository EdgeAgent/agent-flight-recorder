// Agent Flight Recorder — background service worker.
// Records browser activity during armed "watch sessions" into
// chrome.storage.local. Makes NO network calls. Form values are never
// touched — the content script only reports field COUNTS.

import {
  DEFAULT_SETTINGS,
  AGENT_GROUP_TITLE,
  makeSnapshot,
  planRestore,
  pruneSessions,
  hostOf,
} from './lib/logic.js';

const K = {
  settings: 'afr:settings',
  active: 'afr:active',
  sessions: 'afr:sessions',
  journal: 'afr:journal',
  protected: 'afr:protected',
  ttl: 'afr:ttlPending',
};
const JOURNAL_TYPES = new Set(['tab_created', 'tab_closed', 'tab_activated', 'navigation']);
const JOURNAL_CAP = 300;

// --- storage helpers (writes serialized through a promise chain) ------------
let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn, fn);
  return chain;
}
async function getOne(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] ?? fallback;
}
async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await getOne(K.settings, {})) };
}

// --- tab cache (for close/protected checks) ----------------------------------
const tabCache = new Map(); // tabId -> {url, title}
async function refreshTabCache() {
  try {
    const tabs = await chrome.tabs.query({});
    tabCache.clear();
    for (const t of tabs) tabCache.set(t.id, { url: t.url || '', title: t.title || '' });
  } catch { /* ignore */ }
}
refreshTabCache();

// --- event recording -----------------------------------------------------------
const lastFillReport = new Map(); // formKey -> {fields, t}

async function recordEvent(ev) {
  const active = await getOne(K.active, null);
  if (active) {
    active.events.push(ev);
    await chrome.storage.local.set({ [K.active]: active });
    return;
  }
  const settings = await getSettings();
  if (settings.journalOn && JOURNAL_TYPES.has(ev.type)) {
    const journal = await getOne(K.journal, []);
    journal.push(ev);
    while (journal.length > JOURNAL_CAP) journal.shift();
    await chrome.storage.local.set({ [K.journal]: journal });
  }
}
const record = (ev) => enqueue(() => recordEvent(ev));

async function isProtected(url) {
  if (!url) return false;
  const list = await getOne(K.protected, []);
  return list.some((p) => p.url === url);
}

// --- badge ---------------------------------------------------------------------
async function refreshBadge() {
  const active = await getOne(K.active, null);
  try {
    await chrome.action.setBadgeText({ text: active ? 'REC' : '' });
    if (active) await chrome.action.setBadgeBackgroundColor({ color: '#d43a1a' });
  } catch { /* ignore */ }
}

// --- session lifecycle -----------------------------------------------------------
async function armSession() {
  const tabs = await chrome.tabs.query({});
  const session = {
    id: `sess-${Date.now().toString(36)}`,
    startedAt: Date.now(),
    endedAt: null,
    snapshot: makeSnapshot(tabs),
    events: [{ t: Date.now(), type: 'session_start' }],
    groupByWindow: {},
  };
  lastFillReport.clear();
  await chrome.storage.local.set({ [K.active]: session });
  await refreshBadge();
  return session;
}

async function disarmSession() {
  const active = await getOne(K.active, null);
  if (!active) return null;
  active.endedAt = Date.now();
  active.events.push({ t: Date.now(), type: 'session_end' });
  const settings = await getSettings();
  const sessions = await getOne(K.sessions, []);
  sessions.push(active);
  await chrome.storage.local.set({
    [K.sessions]: pruneSessions(sessions, settings.retention),
    [K.active]: null,
  });
  if (settings.ttlEnabled) {
    const closed = new Set(active.events.filter((e) => e.type === 'tab_closed').map((e) => e.tabId));
    const openedIds = active.events
      .filter((e) => e.type === 'tab_created' && e.tabId != null && !closed.has(e.tabId))
      .map((e) => e.tabId);
    if (openedIds.length) {
      await chrome.storage.local.set({ [K.ttl]: { tabIds: openedIds } });
      await chrome.alarms.create('afr:ttl', { delayInMinutes: Math.max(1, Number(settings.ttlMinutes) || 30) });
    }
  }
  await refreshBadge();
  return active;
}

async function findSession(sessionId) {
  const active = await getOne(K.active, null);
  if (sessionId === 'active' || (active && active.id === sessionId)) return { session: active, isActive: true };
  const sessions = await getOne(K.sessions, []);
  const found = sessions.find((s) => s.id === sessionId);
  return { session: found || null, isActive: false };
}

async function executeRestore(sessionId) {
  const { session, isActive } = await findSession(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };
  const currentTabs = await chrome.tabs.query({});
  const plan = planRestore(session.snapshot, currentTabs);
  if (plan.closeIds.length) {
    try { await chrome.tabs.remove(plan.closeIds); } catch { /* some may already be gone */ }
  }
  let reopened = 0;
  for (const item of plan.reopen) {
    try {
      await chrome.tabs.create({ url: item.url, pinned: item.pinned, active: false });
      reopened += 1;
    } catch { /* restricted URL — counted in plan.skipped at read time, ignore */ }
  }
  const ev = { t: Date.now(), type: 'restore', closedCount: plan.closeIds.length, reopenedCount: reopened };
  if (isActive) {
    session.events.push(ev);
    await chrome.storage.local.set({ [K.active]: session });
  } else {
    const sessions = await getOne(K.sessions, []);
    const stored = sessions.find((s) => s.id === session.id);
    if (stored) {
      stored.events.push(ev);
      await chrome.storage.local.set({ [K.sessions]: sessions });
    }
  }
  return { ok: true, closedCount: plan.closeIds.length, reopenedCount: reopened, skipped: plan.skipped };
}

// --- browser event listeners -------------------------------------------------------
chrome.tabs.onCreated.addListener((tab) => {
  tabCache.set(tab.id, { url: tab.url || tab.pendingUrl || '', title: tab.title || '' });
  record({ t: Date.now(), type: 'tab_created', tabId: tab.id, url: tab.url || tab.pendingUrl || '', title: tab.title || '' });
  // Tab Warden: pull session tabs into the "Agent Session" group.
  enqueue(async () => {
    const active = await getOne(K.active, null);
    if (!active) return;
    try {
      const winId = tab.windowId;
      let gid = active.groupByWindow[winId];
      if (gid == null) {
        gid = await chrome.tabs.group({ tabIds: tab.id });
        await chrome.tabGroups.update(gid, { title: AGENT_GROUP_TITLE, color: 'orange' });
        active.groupByWindow[winId] = gid;
        await chrome.storage.local.set({ [K.active]: active });
      } else {
        await chrome.tabs.group({ groupId: gid, tabIds: tab.id });
      }
    } catch { /* tab closed instantly or grouping unavailable — recording continues */ }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const cached = tabCache.get(tabId) || { url: '', title: '' };
  tabCache.delete(tabId);
  record({ t: Date.now(), type: 'tab_closed', tabId, url: cached.url, title: cached.title });
  enqueue(async () => {
    const active = await getOne(K.active, null);
    if (active && cached.url && (await isProtected(cached.url))) {
      active.events.push({ t: Date.now(), type: 'protected_warning', action: 'closed', url: cached.url });
      await chrome.storage.local.set({ [K.active]: active });
    }
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const cached = tabCache.get(tabId) || { url: '', title: '' };
  record({ t: Date.now(), type: 'tab_activated', tabId, url: cached.url, title: cached.title });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title) {
    tabCache.set(tabId, { url: tab.url || '', title: tab.title || '' });
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const prev = tabCache.get(details.tabId);
  const prevUrl = prev ? prev.url : '';
  tabCache.set(details.tabId, { url: details.url, title: prev ? prev.title : '' });
  record({ t: Date.now(), type: 'navigation', phase: 'committed', tabId: details.tabId, url: details.url, host: hostOf(details.url) });
  if (prevUrl && prevUrl !== details.url) {
    enqueue(async () => {
      const active = await getOne(K.active, null);
      if (active && (await isProtected(prevUrl))) {
        active.events.push({ t: Date.now(), type: 'protected_warning', action: 'navigated', url: prevUrl });
        await chrome.storage.local.set({ [K.active]: active });
      }
    });
  }
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  record({ t: Date.now(), type: 'navigation', phase: 'completed', tabId: details.tabId, url: details.url, host: hostOf(details.url) });
});

chrome.downloads.onCreated.addListener((item) => {
  const filename = item.filename ? item.filename.split(/[\\/]/).pop() : '';
  record({ t: Date.now(), type: 'download', url: item.url, host: hostOf(item.url), filename });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'afr:ttl') return;
  enqueue(async () => {
    const pending = await getOne(K.ttl, null);
    if (!pending) return;
    await chrome.storage.local.remove(K.ttl);
    try {
      const existing = new Set((await chrome.tabs.query({})).map((t) => t.id));
      const toClose = pending.tabIds.filter((id) => existing.has(id));
      if (toClose.length) await chrome.tabs.remove(toClose);
    } catch { /* ignore */ }
  });
});

// --- form-observer registration ------------------------------------------------
// The form observer is NOT declared in the manifest: declaring it there
// would hand the extension host access at install time. Instead it is
// registered dynamically, only while the user-granted optional all-sites
// permission is present, and unregistered the moment it is revoked. The
// "scripting" permission by itself grants access to nothing — it can only
// inject where host permission already exists.
const FORM_SCRIPT_ID = 'afr-form-observer';
async function syncFormScript() {
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { /* ignore */ }
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FORM_SCRIPT_ID] });
    if (granted && existing.length === 0) {
      await chrome.scripting.registerContentScripts([{
        id: FORM_SCRIPT_ID,
        js: ['src/content.js'],
        matches: ['http://*/*', 'https://*/*'],
        runAt: 'document_idle',
      }]);
    } else if (!granted && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [FORM_SCRIPT_ID] });
    }
  } catch { /* scripting unavailable — form watching stays off, everything else works */ }
}
if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(() => { syncFormScript(); });
if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(() => { syncFormScript(); });
syncFormScript();

// --- install / startup ----------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(K.settings);
  if (!existing[K.settings]) {
    await chrome.storage.local.set({ [K.settings]: { ...DEFAULT_SETTINGS } });
  }
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch { /* ignore */ }
  await refreshBadge();
});
chrome.runtime.onStartup.addListener(() => { refreshBadge(); refreshTabCache(); });

// --- messages ----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content-script form reports.
  if (message && (message.kind === 'AFR_FORM_FILL' || message.kind === 'AFR_FORM_SUBMIT')) {
    if (!sender.tab) return false;
    enqueue(async () => {
      // Gate: form reports are only recorded when the user has granted the
      // optional all-sites permission. Without the grant, reports are dropped
      // here even if a content script managed to run.
      let granted = false;
      try { granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { /* treat as not granted */ }
      if (!granted) return;
      const active = await getOne(K.active, null);
      if (!active) return;
      const formKey = `${sender.tab.id}:form${message.formIndex ?? 0}`;
      if (message.kind === 'AFR_FORM_SUBMIT') {
        active.events.push({ t: Date.now(), type: 'form_submit', tabId: sender.tab.id, host: message.host || '', formKey });
        await chrome.storage.local.set({ [K.active]: active });
        return;
      }
      const fields = Number(message.fields) || 0;
      const last = lastFillReport.get(formKey);
      const now = Date.now();
      if (fields > 0 && (!last || fields > last.fields) && (!last || now - last.t > 1200)) {
        lastFillReport.set(formKey, { fields, t: now });
        active.events.push({ t: now, type: 'form_fill', tabId: sender.tab.id, host: message.host || '', formKey, fields });
        await chrome.storage.local.set({ [K.active]: active });
      }
    });
    return false;
  }

  if (!message || typeof message.type !== 'string' || !message.type.startsWith('AFR_')) return false;

  (async () => {
    switch (message.type) {
      case 'AFR_GET_STATE': {
        const [settings, active, sessions, journal, protectedList] = await Promise.all([
          getSettings(),
          getOne(K.active, null),
          getOne(K.sessions, []),
          getOne(K.journal, []),
          getOne(K.protected, []),
        ]);
        let hasHostPermission = false;
        try { hasHostPermission = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { /* ignore */ }
        sendResponse({ settings, active, sessions, journal, protected: protectedList, hasHostPermission });
        break;
      }
      case 'AFR_ARM':
        sendResponse({ ok: true, session: await enqueue(() => armSession()) });
        break;
      case 'AFR_DISARM':
        sendResponse({ ok: true, session: await enqueue(() => disarmSession()) });
        break;
      case 'AFR_RESTORE_PLAN': {
        const { session } = await findSession(message.sessionId);
        if (!session) { sendResponse({ ok: false, error: 'Session not found' }); break; }
        const currentTabs = await chrome.tabs.query({});
        sendResponse({ ok: true, plan: planRestore(session.snapshot, currentTabs) });
        break;
      }
      case 'AFR_RESTORE_EXECUTE':
        sendResponse(await enqueue(() => executeRestore(message.sessionId)));
        break;
      case 'AFR_UPDATE_SETTINGS': {
        const merged = { ...(await getSettings()), ...(message.settings || {}) };
        await chrome.storage.local.set({ [K.settings]: merged });
        sendResponse({ ok: true, settings: merged });
        break;
      }
      case 'AFR_PROTECT_TAB': {
        try {
          const tab = await chrome.tabs.get(message.tabId);
          const list = await getOne(K.protected, []);
          if (tab.url && !list.some((p) => p.url === tab.url)) {
            list.push({ url: tab.url, title: tab.title || '', addedAt: Date.now() });
            await chrome.storage.local.set({ [K.protected]: list });
          }
          sendResponse({ ok: true, protected: list });
        } catch { sendResponse({ ok: false, error: 'Tab not found' }); }
        break;
      }
      case 'AFR_UNPROTECT': {
        const list = (await getOne(K.protected, [])).filter((p) => p.url !== message.url);
        await chrome.storage.local.set({ [K.protected]: list });
        sendResponse({ ok: true, protected: list });
        break;
      }
      case 'AFR_FORGET_SESSION': {
        const sessions = (await getOne(K.sessions, [])).filter((s) => s.id !== message.sessionId);
        await chrome.storage.local.set({ [K.sessions]: sessions });
        sendResponse({ ok: true });
        break;
      }
      case 'AFR_CLEAR_ALL': {
        await chrome.storage.local.remove([K.active, K.sessions, K.journal, K.protected, K.ttl]);
        await chrome.storage.local.set({ [K.settings]: { ...DEFAULT_SETTINGS } });
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  })();
  return true; // async response
});
