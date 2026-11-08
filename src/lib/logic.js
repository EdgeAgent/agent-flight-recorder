// Agent Flight Recorder — pure logic.
// No chrome.* APIs in this file: everything here is unit-testable in Node.

export const DEFAULT_SETTINGS = Object.freeze({
  journalOn: false,      // always-on lightweight tab journal (tabs only)
  ttlEnabled: false,     // auto-close agent-session tabs after the session ends
  ttlMinutes: 30,        // TTL delay when enabled
  retention: 20,         // keep last N completed sessions
});

export const AGENT_GROUP_TITLE = 'Agent Session';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function hostOf(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    return new URL(url).host || '';
  } catch {
    return '';
  }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Snapshots and restore planning
// ---------------------------------------------------------------------------

// Normalize a chrome.tabs.Tab-like object into a snapshot entry.
export function normalizeTab(tab) {
  return {
    id: tab.id,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    pinned: Boolean(tab.pinned),
    index: tab.index ?? 0,
    windowId: tab.windowId ?? null,
    groupId: tab.groupId ?? -1,
  };
}

export function makeSnapshot(tabs, takenAt = Date.now()) {
  return { takenAt, tabs: (tabs || []).map(normalizeTab) };
}

const REOPENABLE = /^(https?:\/\/|about:blank$)/;

/**
 * Plan a restore: given the pre-session snapshot and the tabs open right now,
 * decide which current tabs to close (opened after the snapshot) and which
 * snapshot tabs to reopen (closed since the snapshot).
 *
 * Matching strategy: exact tab id first (same browser session), then URL
 * multiset matching for unmatched snapshot tabs (browser restarted, ids
 * changed) so we never reopen a duplicate of a tab that is still open.
 */
export function planRestore(snapshot, currentTabs) {
  const snapTabs = (snapshot && snapshot.tabs) || [];
  const current = (currentTabs || []).map(normalizeTab);

  const currentById = new Map(current.map((t) => [t.id, t]));
  const matchedCurrentIds = new Set();
  const unmatchedSnap = [];

  for (const snap of snapTabs) {
    if (snap.id != null && currentById.has(snap.id)) {
      matchedCurrentIds.add(snap.id);
    } else {
      unmatchedSnap.push(snap);
    }
  }

  // URL-multiset fallback for snapshot tabs whose id no longer exists.
  const unmatchedCurrent = current.filter((t) => !matchedCurrentIds.has(t.id));
  const reopen = [];
  let skipped = 0;
  for (const snap of unmatchedSnap) {
    const idx = unmatchedCurrent.findIndex((t) => t.url === snap.url);
    if (idx >= 0) {
      matchedCurrentIds.add(unmatchedCurrent[idx].id);
      unmatchedCurrent.splice(idx, 1);
    } else if (REOPENABLE.test(snap.url || '')) {
      reopen.push({ url: snap.url, title: snap.title, pinned: snap.pinned });
    } else {
      skipped += 1; // e.g. chrome:// pages cannot be reopened programmatically
    }
  }

  const closeIds = current
    .filter((t) => !matchedCurrentIds.has(t.id))
    .map((t) => t.id);

  return {
    closeIds,
    reopen,
    skipped,
    keepCount: matchedCurrentIds.size,
  };
}

// ---------------------------------------------------------------------------
// Event summarization
// ---------------------------------------------------------------------------

export function emptySummary() {
  return {
    durationMs: 0,
    tabsOpened: 0,
    tabsClosed: 0,
    navigations: 0,
    pageLoads: 0,
    formsFilled: 0,
    fieldsTouched: 0,
    formsSubmitted: 0,
    downloads: 0,
    flagged: 0,
    totalEvents: 0,
  };
}

export function summarizeEvents(events) {
  const s = emptySummary();
  for (const ev of events || []) {
    s.totalEvents += 1;
    switch (ev.type) {
      case 'tab_created': s.tabsOpened += 1; break;
      case 'tab_closed': s.tabsClosed += 1; break;
      case 'navigation':
        if (ev.phase === 'completed') s.pageLoads += 1;
        else s.navigations += 1;
        break;
      case 'form_fill': s.formsFilled += 1; break;
      case 'form_submit': s.formsSubmitted += 1; break;
      case 'download': s.downloads += 1; break;
      case 'protected_warning': s.flagged += 1; break;
      default: break;
    }
  }
  // fieldsTouched = sum over distinct forms of their max reported field count.
  const perFormMax = new Map();
  for (const ev of events || []) {
    if (ev.type === 'form_fill' && ev.formKey) {
      perFormMax.set(ev.formKey, Math.max(perFormMax.get(ev.formKey) || 0, ev.fields || 0));
    }
  }
  s.fieldsTouched = [...perFormMax.values()].reduce((a, b) => a + b, 0);
  return s;
}

export function summarizeSession(session) {
  if (!session) return emptySummary();
  const s = summarizeEvents(session.events);
  const end = session.endedAt || Date.now();
  s.durationMs = Math.max(0, end - (session.startedAt || end));
  return s;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// Keep the newest `keep` sessions (by startedAt). Input order is not trusted.
export function pruneSessions(sessions, keep) {
  const n = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_SETTINGS.retention;
  return [...(sessions || [])]
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Event descriptions (timeline + report)
// ---------------------------------------------------------------------------

export function describeEvent(ev) {
  const where = ev.host || hostOf(ev.url);
  switch (ev.type) {
    case 'session_start': return 'Watch session started — snapshot taken';
    case 'session_end': return 'Watch session ended';
    case 'tab_created': return `Tab opened${where ? ` — ${where}` : ''}${ev.title ? ` · ${ev.title}` : ''}`;
    case 'tab_closed': return `Tab closed${where ? ` — ${where}` : ''}${ev.title ? ` · ${ev.title}` : ''}`;
    case 'tab_activated': return `Tab focused${where ? ` — ${where}` : ''}`;
    case 'navigation': return ev.phase === 'completed'
      ? `Page loaded — ${where || ev.url || ''}`
      : `Navigated — ${where || ev.url || ''}`;
    case 'download': return `Download started — ${ev.filename || where || 'file'}`;
    case 'form_fill': return `Form being filled on ${where || 'a page'} — ${ev.fields || 0} field${(ev.fields || 0) === 1 ? '' : 's'} touched (values never recorded)`;
    case 'form_submit': return `Form submitted on ${where || 'a page'}`;
    case 'protected_warning': return `⚠ Protected tab ${ev.action === 'closed' ? 'closed' : 'navigated away'} — ${ev.url || ''}`;
    case 'restore': return `Restore executed — closed ${ev.closedCount || 0} tab(s), reopened ${ev.reopenedCount || 0} tab(s)`;
    default: return ev.type || 'event';
  }
}

// ---------------------------------------------------------------------------
// Receipt generation
// ---------------------------------------------------------------------------

export function buildReceipt(session, exportedAt = Date.now()) {
  return {
    tool: 'Agent Flight Recorder',
    receiptVersion: 1,
    exportedAt: new Date(exportedAt).toISOString(),
    privacyNote: 'Form values are never recorded. This receipt contains only tab, navigation, download and form-activity metadata generated locally in your browser.',
    session: {
      id: session.id,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      snapshotTabCount: session.snapshot ? session.snapshot.tabs.length : 0,
    },
    summary: summarizeSession(session),
    events: (session.events || []).map((ev) => ({ ...ev })),
  };
}

export function renderReceiptHtml(session, exportedAt = Date.now()) {
  const summary = summarizeSession(session);
  const start = session.startedAt ? new Date(session.startedAt) : null;
  const rows = (session.events || []).map((ev) => {
    const flag = ev.type === 'protected_warning' ? ' class="flag"' : '';
    return `<tr${flag}><td class="t">${escapeHtml(formatClock(ev.t))}</td><td class="k">${escapeHtml(ev.type)}</td><td>${escapeHtml(describeEvent(ev))}</td></tr>`;
  }).join('\n');
  const card = (label, value) => `<div class="card"><div class="v">${escapeHtml(value)}</div><div class="l">${escapeHtml(label)}</div></div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent Flight Recorder — Session Receipt</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:#0c0e12; color:#e8eaf0; margin:0; padding:32px; }
  .wrap { max-width: 880px; margin: 0 auto; }
  header { border-bottom: 3px solid #ff7a1a; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .4px; }
  .sub { color:#9aa3b2; font-size: 13px; }
  .cards { display:flex; flex-wrap:wrap; gap:10px; margin: 18px 0 24px; }
  .card { background:#151922; border:1px solid #262d3d; border-radius:10px; padding:12px 16px; min-width:104px; }
  .card .v { font-size:20px; font-weight:700; color:#ffb066; }
  .card .l { font-size:11px; text-transform:uppercase; letter-spacing:.8px; color:#9aa3b2; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:#9aa3b2; font-weight:600; padding:6px 8px; border-bottom:1px solid #262d3d; }
  td { padding:6px 8px; border-bottom:1px solid #1a1f2b; vertical-align:top; }
  td.t { font-variant-numeric: tabular-nums; color:#9aa3b2; white-space:nowrap; }
  td.k { color:#ffb066; white-space:nowrap; }
  tr.flag td { background: rgba(255, 90, 60, .12); }
  footer { margin-top: 24px; color:#9aa3b2; font-size:12px; border-top:1px solid #262d3d; padding-top:12px; }
  @media print { body { background:#fff; color:#111; } .card { background:#f4f4f4; border-color:#ddd; } .card .v { color:#c2540a; } td.k { color:#c2540a; } }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>✈ Agent Flight Recorder — Session Receipt</h1>
  <div class="sub">Session ${escapeHtml(session.id || '')} · Started ${start ? escapeHtml(start.toLocaleString()) : '—'} · Exported ${escapeHtml(new Date(exportedAt).toLocaleString())}</div>
</header>
<div class="cards">
  ${card('Duration', formatDuration(summary.durationMs))}
  ${card('Tabs opened', String(summary.tabsOpened))}
  ${card('Tabs closed', String(summary.tabsClosed))}
  ${card('Navigations', String(summary.navigations))}
  ${card('Forms submitted', String(summary.formsSubmitted))}
  ${card('Downloads', String(summary.downloads))}
  ${card('Flagged', String(summary.flagged))}
</div>
<table>
  <thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<footer>Generated locally by Agent Flight Recorder. Form field <em>values</em> are never recorded — only that fields were touched and forms were submitted. No data leaves your browser.</footer>
</div>
</body>
</html>`;
}
