import type { AppContext, EmailReplyContext } from './electron-api';
import { BROWSER_BUNDLE_IDS } from './websiteContext';

/** Keep an actual Gmail conversation route, never inbox/search/compose parameters. */
export function gmailThreadUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://mail.google.com' || !/^\/mail\/u\/\d+\/$/.test(url.pathname)) return undefined;
    const route = url.hash.slice(1).split('/');
    if (!['inbox', 'all', 'sent', 'drafts', 'starred', 'snoozed', 'imp', 'trash', 'spam', 'search', 'label', 'category'].includes(route[0] || '')) return undefined;
    const id = route.at(-1);
    if (route.length < 2 || !id || !/^(?:[a-f0-9]{16,32}|[A-Za-z]{20,100})$/.test(id)) return undefined;
    // A Gmail URL identifies a thread, but is not a Gmail API thread ID.
    return `${url.origin}${url.pathname}#all/${id}`;
  } catch { return undefined; }
}

export interface ReplySnapshot {
  bundleId: string;
  windowTitle: string;
  documentURL: string;
  focusedReply?: boolean;
  subject?: string;
  recipientLabels?: string[];
}

export function matchEmailReply(snapshot: ReplySnapshot | undefined, context: AppContext, documentURL: string): EmailReplyContext | undefined {
  if (!snapshot?.focusedReply || !context.bundleId || !BROWSER_BUNDLE_IDS.has(context.bundleId) || snapshot.bundleId !== context.bundleId || snapshot.windowTitle !== context.windowTitle) return undefined;
  const threadUrl = gmailThreadUrl(documentURL);
  if (!threadUrl || threadUrl !== gmailThreadUrl(snapshot.documentURL)) return undefined;
  const subject = typeof snapshot.subject === 'string' ? snapshot.subject.trim().slice(0, 1000) : '';
  const replyTo = Array.isArray(snapshot.recipientLabels) ? [...new Set(snapshot.recipientLabels
    .filter((v): v is string => typeof v === 'string' && v.length <= 500 && /[^\s<>@()]+@[^\s<>@()]+\.[^\s<>@()]+/.test(v))
    .slice(0, 30).map(v => v.trim()))] : [];
  return { source: 'accessibility', threadUrl, ...(subject ? { subject } : {}), ...(replyTo.length ? { replyTo } : {}) };
}
