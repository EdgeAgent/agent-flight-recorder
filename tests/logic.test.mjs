import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  makeSnapshot,
  planRestore,
  summarizeEvents,
  summarizeSession,
  pruneSessions,
  buildReceipt,
  renderReceiptHtml,
  describeEvent,
  escapeHtml,
  hostOf,
  formatDuration,
} from '../src/lib/logic.js';

const tab = (id, url, extra = {}) => ({ id, url, title: `T${id}`, pinned: false, index: id, windowId: 1, groupId: -1, ...extra });

// --- snapshots ---------------------------------------------------------------

test('makeSnapshot normalizes tabs and stamps time', () => {
  const snap = makeSnapshot([tab(1, 'https://a.com/'), tab(2, 'https://b.com/', { pinned: true })], 1234);
  assert.equal(snap.takenAt, 1234);
  assert.equal(snap.tabs.length, 2);
  assert.equal(snap.tabs[1].pinned, true);
});

// --- restore planning ----------------------------------------------------------

test('planRestore: nothing changed → empty plan', () => {
  const snap = makeSnapshot([tab(1, 'https://a.com/'), tab(2, 'https://b.com/')]);
  const plan = planRestore(snap, [tab(1, 'https://a.com/'), tab(2, 'https://b.com/')]);
  assert.deepEqual(plan.closeIds, []);
  assert.deepEqual(plan.reopen, []);
  assert.equal(plan.keepCount, 2);
});

test('planRestore: tab opened after snapshot is closed', () => {
  const snap = makeSnapshot([tab(1, 'https://a.com/')]);
  const plan = planRestore(snap, [tab(1, 'https://a.com/'), tab(9, 'https://spam.example/')]);
  assert.deepEqual(plan.closeIds, [9]);
  assert.deepEqual(plan.reopen, []);
});

test('planRestore: snapshot tab closed during session is reopened, pinned preserved', () => {
  const snap = makeSnapshot([tab(1, 'https://a.com/'), tab(2, 'https://mail.example/', { pinned: true })]);
  const plan = planRestore(snap, [tab(1, 'https://a.com/')]);
  assert.deepEqual(plan.closeIds, []);
  assert.equal(plan.reopen.length, 1);
  assert.equal(plan.reopen[0].url, 'https://mail.example/');
  assert.equal(plan.reopen[0].pinned, true);
});

test('planRestore: browser restart (ids changed) matches by URL, no false close/reopen', () => {
  const snap = makeSnapshot([tab(1, 'https://a.com/'), tab(2, 'https://b.com/')]);
  const plan = planRestore(snap, [tab(51, 'https://a.com/'), tab(52, 'https://b.com/'), tab(53, 'https://new.example/')]);
  assert.deepEqual(plan.closeIds, [53]);
  assert.deepEqual(plan.reopen, []);
  assert.equal(plan.keepCount, 2);
});

test('planRestore: duplicate URLs are matched as a multiset', () => {
  const snap = makeSnapshot([tab(1, 'https://dup.example/'), tab(2, 'https://dup.example/')]);
  const plan = planRestore(snap, [tab(77, 'https://dup.example/')]); // ids changed, one of two still open
  assert.equal(plan.reopen.length, 1);
  assert.deepEqual(plan.closeIds, []);
});

test('planRestore: chrome:// pages are skipped, not reopened', () => {
  const snap = makeSnapshot([tab(1, 'chrome://extensions/'), tab(2, 'https://a.com/')]);
  const plan = planRestore(snap, []);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.reopen.length, 1);
  assert.equal(plan.reopen[0].url, 'https://a.com/');
});

// --- summarization -------------------------------------------------------------

const ev = (type, extra = {}) => ({ t: 1000, type, ...extra });

test('summarizeEvents counts every event type', () => {
  const s = summarizeEvents([
    ev('session_start'),
    ev('tab_created'), ev('tab_created'),
    ev('tab_closed'),
    ev('navigation', { phase: 'committed' }), ev('navigation', { phase: 'committed' }),
    ev('navigation', { phase: 'completed' }),
    ev('form_submit'),
    ev('download'), ev('download'),
    ev('protected_warning'),
  ]);
  assert.equal(s.tabsOpened, 2);
  assert.equal(s.tabsClosed, 1);
  assert.equal(s.navigations, 2);
  assert.equal(s.pageLoads, 1);
  assert.equal(s.formsSubmitted, 1);
  assert.equal(s.downloads, 2);
  assert.equal(s.flagged, 1);
  assert.equal(s.totalEvents, 11);
});

test('summarizeEvents: fieldsTouched aggregates per-form maximums', () => {
  const s = summarizeEvents([
    ev('form_fill', { formKey: 'tab1:form0', fields: 2 }),
    ev('form_fill', { formKey: 'tab1:form0', fields: 5 }),
    ev('form_fill', { formKey: 'tab1:form0', fields: 3 }),
    ev('form_fill', { formKey: 'tab2:form0', fields: 4 }),
  ]);
  assert.equal(s.formsFilled, 4);
  assert.equal(s.fieldsTouched, 9); // max(2,5,3) + 4
});

test('summarizeSession computes duration from start/end', () => {
  const session = { startedAt: 10_000, endedAt: 70_000, events: [ev('tab_created')] };
  const s = summarizeSession(session);
  assert.equal(s.durationMs, 60_000);
  assert.equal(s.tabsOpened, 1);
});

// --- retention -----------------------------------------------------------------

test('pruneSessions keeps the newest N by startedAt', () => {
  const sessions = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, startedAt: n * 1000, events: [] }));
  const kept = pruneSessions(sessions, 2);
  assert.deepEqual(kept.map((s) => s.id), ['s5', 's4']);
});

test('pruneSessions falls back to default retention on bad input', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, startedAt: i, events: [] }));
  assert.equal(pruneSessions(sessions, 0).length, DEFAULT_SETTINGS.retention);
  assert.equal(pruneSessions(sessions, NaN).length, DEFAULT_SETTINGS.retention);
});

// --- receipts ------------------------------------------------------------------

const sampleSession = {
  id: 'sess-1',
  startedAt: Date.parse('2026-11-08T10:00:00Z'),
  endedAt: Date.parse('2026-11-08T10:05:30Z'),
  snapshot: makeSnapshot([tab(1, 'https://a.com/')]),
  events: [
    ev('session_start'),
    ev('tab_created', { url: 'https://evil.example/', title: '<script>alert(1)</script>' }),
    ev('form_submit', { host: 'shop.example' }),
    ev('protected_warning', { action: 'closed', url: 'https://bank.example/' }),
    ev('session_end'),
  ],
};

test('buildReceipt carries summary, privacy note and ISO timestamps', () => {
  const r = buildReceipt(sampleSession, Date.parse('2026-11-08T11:00:00Z'));
  assert.equal(r.tool, 'Agent Flight Recorder');
  assert.equal(r.session.id, 'sess-1');
  assert.equal(r.session.startedAt, '2026-11-08T10:00:00.000Z');
  assert.match(r.privacyNote, /never recorded/);
  assert.equal(r.summary.tabsOpened, 1);
  assert.equal(r.summary.flagged, 1);
  assert.equal(r.summary.durationMs, 330_000);
  assert.equal(r.events.length, 5);
});

test('renderReceiptHtml is standalone, escaped and printable', () => {
  const html = renderReceiptHtml(sampleSession);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped payload should be visible as text');
  assert.ok(!/<script\s+src=/.test(html) && !/<link\s/.test(html), 'no external resources');
  assert.ok(html.includes('@media print'));
  assert.ok(html.includes('class="flag"'), 'protected warning row is flagged');
  assert.ok(html.includes('Forms submitted'));
});

// --- descriptions & helpers -----------------------------------------------------

test('describeEvent: form fill states values are never recorded', () => {
  const d = describeEvent({ type: 'form_fill', host: 'x.example', fields: 3 });
  assert.match(d, /values never recorded/);
});

test('escapeHtml escapes all five characters', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('hostOf parses hosts and tolerates junk', () => {
  assert.equal(hostOf('https://sub.example.com/path?q=1'), 'sub.example.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('formatDuration renders compact durations', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(125_000), '2m 05s');
  assert.equal(formatDuration(3_660_000), '1h 01m');
});
