// Agent Flight Recorder — side panel controller.
import {
  summarizeSession,
  buildReceipt,
  renderReceiptHtml,
  describeEvent,
  formatClock,
  formatDuration,
} from '../lib/logic.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const GLYPHS = {
  session_start: '⏺', session_end: '⏹', tab_created: '✚', tab_closed: '✕',
  tab_activated: '◎', navigation: '➜', download: '⬇', form_fill: '✎',
  form_submit: '➤', protected_warning: '⚠', restore: '↩',
};

let state = null;
let selectedSessionId = null; // 'active' or a session id
let pendingPlanSessionId = null;

function currentSession() {
  if (!state) return null;
  if (selectedSessionId === 'active') return state.active;
  if (selectedSessionId) {
    const found = state.sessions.find((s) => s.id === selectedSessionId);
    if (found) return found;
  }
  return state.active || state.sessions[0] || null;
}

function sessionLabel(s) {
  const d = new Date(s.startedAt);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${formatDuration((s.endedAt || Date.now()) - s.startedAt)}`;
}

// --- rendering -----------------------------------------------------------------

function renderStatus() {
  const armed = Boolean(state && state.active);
  $('statusDot').className = `dot ${armed ? 'rec' : 'idle'}`;
  $('statusText').textContent = armed ? 'Recording — watch session armed' : 'Not recording';
  $('idleControls').hidden = armed;
  $('armedControls').hidden = !armed;
}

function renderSummary() {
  const session = currentSession();
  const chipsEl = $('summaryChips');
  chipsEl.replaceChildren();
  if (!session) {
    $('sessionMeta').textContent = 'no sessions yet';
    return;
  }
  const sum = summarizeSession(session);
  $('sessionMeta').textContent = session.endedAt ? sessionLabel(session) : `live · started ${new Date(session.startedAt).toLocaleTimeString()}`;
  const chips = [
    ['Duration', formatDuration(sum.durationMs)],
    ['Tabs opened', sum.tabsOpened],
    ['Tabs closed', sum.tabsClosed],
    ['Navigations', sum.navigations],
    ['Fields touched', sum.fieldsTouched],
    ['Forms sent', sum.formsSubmitted],
    ['Downloads', sum.downloads],
    ['Flagged', sum.flagged, sum.flagged > 0],
  ];
  for (const [label, value, alert] of chips) {
    const div = document.createElement('div');
    div.className = `chip${alert ? ' alert' : ''}`;
    const v = document.createElement('div'); v.className = 'v'; v.textContent = String(value);
    const l = document.createElement('div'); l.className = 'l'; l.textContent = label;
    div.append(v, l);
    chipsEl.append(div);
  }
}

function renderTimeline() {
  const session = currentSession();
  const list = $('timelineList');
  list.replaceChildren();
  const events = session ? [...session.events].reverse() : [];
  $('timelineEmpty').hidden = events.length > 0;
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = `ev${ev.type === 'protected_warning' ? ' flag' : ''}`;
    const time = document.createElement('span'); time.className = 'time'; time.textContent = formatClock(ev.t);
    const glyph = document.createElement('span'); glyph.className = 'glyph'; glyph.textContent = GLYPHS[ev.type] || '•';
    const desc = document.createElement('span'); desc.className = 'desc'; desc.textContent = describeEvent(ev);
    row.append(time, glyph, desc);
    list.append(row);
  }
  $('btnForget').hidden = !(session && session.endedAt);
}

function renderSessionSelect() {
  const sel = $('sessionSelect');
  sel.replaceChildren();
  if (state.active) {
    const o = document.createElement('option');
    o.value = 'active'; o.textContent = '● Live session';
    sel.append(o);
  }
  for (const s of state.sessions) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = sessionLabel(s);
    sel.append(o);
  }
  if (selectedSessionId === 'active' && !state.active) {
    selectedSessionId = state.sessions[0] ? state.sessions[0].id : null;
  }
  if (!selectedSessionId) selectedSessionId = state.active ? 'active' : (state.sessions[0] ? state.sessions[0].id : null);
  sel.value = selectedSessionId || '';
  sel.disabled = sel.options.length === 0;
}

function renderProtected() {
  const wrap = $('protectedList');
  wrap.replaceChildren();
  if (!state.protected.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'No protected tabs yet.';
    wrap.append(p);
    return;
  }
  for (const item of state.protected) {
    const row = document.createElement('div');
    row.className = 'protected-item';
    const shield = document.createElement('span'); shield.textContent = '🛡';
    const url = document.createElement('span'); url.className = 'p-url'; url.textContent = item.url; url.title = item.title || item.url;
    const btn = document.createElement('button'); btn.className = 'btn ghost small-btn'; btn.textContent = 'Remove';
    btn.addEventListener('click', async () => { await send({ type: 'AFR_UNPROTECT', url: item.url }); refresh(); });
    row.append(shield, url, btn);
    wrap.append(row);
  }
}

function renderJournal() {
  const on = state.settings.journalOn;
  $('journalCard').hidden = !on;
  if (!on) return;
  const list = $('journalList');
  list.replaceChildren();
  const events = [...state.journal].reverse().slice(0, 40);
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'ev';
    const time = document.createElement('span'); time.className = 'time'; time.textContent = formatClock(ev.t);
    const glyph = document.createElement('span'); glyph.className = 'glyph'; glyph.textContent = GLYPHS[ev.type] || '•';
    const desc = document.createElement('span'); desc.className = 'desc'; desc.textContent = describeEvent(ev);
    row.append(time, glyph, desc);
    list.append(row);
  }
  if (!events.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'Journal is on. Tab activity outside watch sessions will appear here.';
    list.append(p);
  }
}

function renderSettings() {
  $('setJournal').checked = Boolean(state.settings.journalOn);
  $('setTtl').checked = Boolean(state.settings.ttlEnabled);
  $('setTtlMinutes').value = state.settings.ttlMinutes ?? 30;
  $('setRetention').value = state.settings.retention ?? 20;
  $('permStatus').textContent = state.hasHostPermission
    ? '✅ All-sites access is GRANTED — form watching can be enabled when arming a session.'
    : 'Not granted — the recorder runs in tabs/pages/downloads mode until you grant it.';
  $('formsExplainer').innerHTML = state.hasHostPermission
    ? 'All-sites access is already granted, so ticking this turns form watching on for the session. Counts only — <strong>never</strong> the values typed.'
    : 'Counts fields touched and form submits — <strong>never</strong> the values typed. Needs the all-sites permission, requested only if you tick this.';
}

function render() {
  if (!state) return;
  renderStatus();
  renderSessionSelect();
  renderSummary();
  renderTimeline();
  renderProtected();
  renderJournal();
  renderSettings();
  updateElapsed();
}

function updateElapsed() {
  if (state && state.active) {
    $('elapsed').textContent = formatDuration(Date.now() - state.active.startedAt);
  }
}

async function refresh() {
  state = await send({ type: 'AFR_GET_STATE' });
  render();
}

// --- actions ----------------------------------------------------------------------

$('btnArm').addEventListener('click', async () => {
  if ($('chkForms').checked && !(state && state.hasHostPermission)) {
    try { await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch { /* user choice respected either way */ }
  }
  await send({ type: 'AFR_ARM' });
  selectedSessionId = 'active';
  refresh();
});

$('btnDisarm').addEventListener('click', async () => {
  const res = await send({ type: 'AFR_DISARM' });
  if (res && res.session) selectedSessionId = res.session.id;
  refresh();
});

$('sessionSelect').addEventListener('change', () => {
  selectedSessionId = $('sessionSelect').value;
  $('restoreConfirm').hidden = true;
  $('restoreResult').hidden = true;
  renderSummary();
  renderTimeline();
});

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('btnExportJson').addEventListener('click', () => {
  const session = currentSession();
  if (!session) return;
  download(`flight-recorder-${session.id}.json`, JSON.stringify(buildReceipt(session), null, 2), 'application/json');
});

$('btnExportHtml').addEventListener('click', () => {
  const session = currentSession();
  if (!session) return;
  download(`flight-recorder-${session.id}.html`, renderReceiptHtml(session), 'text/html');
});

$('btnForget').addEventListener('click', async () => {
  const session = currentSession();
  if (!session || !session.endedAt) return;
  await send({ type: 'AFR_FORGET_SESSION', sessionId: session.id });
  selectedSessionId = null;
  refresh();
});

$('btnRestore').addEventListener('click', async () => {
  const session = currentSession();
  if (!session) return;
  const sid = session.endedAt ? session.id : 'active';
  const res = await send({ type: 'AFR_RESTORE_PLAN', sessionId: sid });
  if (!res || !res.ok) return;
  pendingPlanSessionId = sid;
  const { closeIds, reopen, skipped } = res.plan;
  $('restorePlanText').textContent =
    `Close ${closeIds.length} tab(s) opened since the snapshot, and reopen ${reopen.length} tab(s) that were closed.` +
    (skipped ? ` ${skipped} internal browser page(s) cannot be reopened and will be skipped.` : '') +
    (closeIds.length === 0 && reopen.length === 0 ? ' Nothing to change — your tabs already match the snapshot.' : '');
  $('restoreConfirm').hidden = false;
  $('restoreResult').hidden = true;
});

$('btnRestoreCancel').addEventListener('click', () => { $('restoreConfirm').hidden = true; });

$('btnRestoreConfirm').addEventListener('click', async () => {
  if (!pendingPlanSessionId) return;
  const res = await send({ type: 'AFR_RESTORE_EXECUTE', sessionId: pendingPlanSessionId });
  $('restoreConfirm').hidden = true;
  const line = $('restoreResult');
  line.hidden = false;
  line.textContent = res && res.ok
    ? `✔ Restored — closed ${res.closedCount} tab(s), reopened ${res.reopenedCount} tab(s).`
    : 'Restore failed — the session snapshot could not be found.';
  refresh();
});

$('btnProtectCurrent').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) { await send({ type: 'AFR_PROTECT_TAB', tabId: tab.id }); refresh(); }
});

// --- settings view -------------------------------------------------------------------

$('btnSettings').addEventListener('click', () => {
  $('viewMain').hidden = true;
  $('viewSettings').hidden = false;
});
$('btnBack').addEventListener('click', () => {
  $('viewSettings').hidden = true;
  $('viewMain').hidden = false;
});

async function pushSettings(partial) {
  await send({ type: 'AFR_UPDATE_SETTINGS', settings: partial });
  refresh();
}
$('setJournal').addEventListener('change', (e) => pushSettings({ journalOn: e.target.checked }));
$('setTtl').addEventListener('change', (e) => pushSettings({ ttlEnabled: e.target.checked }));
$('setTtlMinutes').addEventListener('change', (e) => pushSettings({ ttlMinutes: Math.max(1, Number(e.target.value) || 30) }));
$('setRetention').addEventListener('change', (e) => pushSettings({ retention: Math.max(1, Number(e.target.value) || 20) }));

$('btnGrantPerm').addEventListener('click', async () => {
  try { await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch { /* ignore */ }
  refresh();
});
$('btnRevokePerm').addEventListener('click', async () => {
  try { await chrome.permissions.remove({ origins: ['<all_urls>'] }); } catch { /* ignore */ }
  refresh();
});

let clearArmed = false;
$('btnClearAll').addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    $('btnClearAll').textContent = 'Click again to confirm — this erases everything';
    setTimeout(() => { clearArmed = false; $('btnClearAll').textContent = 'Erase all recorder data'; }, 4000);
    return;
  }
  await send({ type: 'AFR_CLEAR_ALL' });
  selectedSessionId = null;
  clearArmed = false;
  $('btnClearAll').textContent = 'Erase all recorder data';
  const line = $('clearResult');
  line.hidden = false;
  line.textContent = '✔ All sessions, journal entries and settings were erased.';
  refresh();
});

// --- live updates -----------------------------------------------------------------------

let refreshQueued = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => k.startsWith('afr:'))) return;
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refresh(); }, 300);
});
setInterval(updateElapsed, 1000);

refresh();
