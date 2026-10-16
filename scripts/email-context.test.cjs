const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { buildSync } = require('esbuild');
const entry = path.resolve('electron/shared/emailContext.ts');
const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(entry, module); loaded._compile(js, entry);
const { gmailThreadUrl, matchEmailReply } = loaded.exports;
const id = 'FMfcgzQhWxTCFBVfgNGGwQcJWTvPRrxL';
const url = `https://mail.google.com/mail/u/0/#drafts/${id}`;
const context = { appName: 'Safari', bundleId: 'com.apple.Safari', windowTitle: 'Actual subject - user - Gmail' };
const snapshot = { ...context, documentURL: url, focusedReply: true, subject: 'Actual subject', recipientLabels: ['Someone Else (reply@example.org)'] };

test('thread links strip query and normalize folder without retaining search terms', () => {
  assert.equal(gmailThreadUrl(url.replace('#', '?compose=secret#')), `https://mail.google.com/mail/u/0/#all/${id}`);
  assert.equal(gmailThreadUrl(`https://mail.google.com/mail/u/2/#search/private+query/${id}`), `https://mail.google.com/mail/u/2/#all/${id}`);
});

test('inbox, search, compose, foreign hosts and malformed routes are not thread links', () => {
  for (const candidate of ['https://mail.google.com/mail/u/0/#inbox', 'https://mail.google.com/mail/u/0/#search/someone@example.org', 'https://mail.google.com/mail/u/0/#compose', `https://evil.example/mail/u/0/#all/${id}`, `https://mail.google.com/mail/u/0/#compose/${id}`, 'javascript:alert(1)', 'http://mail.google.com/mail/u/0/#inbox', null]) assert.equal(gmailThreadUrl(candidate), undefined);
});

test('only focused reply metadata matching the paste destination is saved', () => {
  assert.deepEqual(matchEmailReply(snapshot, context, url), { source: 'accessibility', subject: 'Actual subject', replyTo: ['Someone Else (reply@example.org)'], threadUrl: `https://mail.google.com/mail/u/0/#all/${id}` });
  for (const change of [{ focusedReply: false }, { bundleId: 'com.google.Chrome' }, { windowTitle: 'Other thread' }, { documentURL: 'https://mail.google.com/mail/u/0/#inbox' }, { documentURL: url.replace(id, 'FMfcgzQhWxTCFBVfgNGGwQcJWTvPRrxM') }]) assert.equal(matchEmailReply({ ...snapshot, ...change }, context, url), undefined);
});

test('unknown recipients stay unknown; malformed and repeated labels are filtered', () => {
  assert.equal(matchEmailReply({ ...snapshot, recipientLabels: [] }, context, url).replyTo, undefined);
  assert.deepEqual(matchEmailReply({ ...snapshot, recipientLabels: ['recipient@example.org', 'recipient@example.org', 42, 'not a recipient'] }, context, url).replyTo, ['recipient@example.org']);
});

test('Chrome matches the same reply contract as Safari', () => {
  const chrome = { ...context, appName: 'Google Chrome', bundleId: 'com.google.Chrome' };
  assert.equal(matchEmailReply({ ...snapshot, ...chrome }, chrome, url).subject, 'Actual subject');
});
