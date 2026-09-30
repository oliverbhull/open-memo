import { execFile } from 'node:child_process';

export interface EmailTarget {
  bundleId?: string;
  url?: string;
}

/** Keep the spoken salutation when the model substitutes another greeting. */
export function preserveEmailOpening(text: string, transcript: string): string {
  const spoken = /^(hi|hey|hello|dear|thanks|thank you)[\s,]+/iu.exec(transcript.trim());
  const generated = /^(?:hi|hey|hello|dear|thanks|thank you)\s+([^,\n.!?]{1,100}),\s*/iu.exec(text.trim());
  if (!spoken?.[1] || !generated?.[1]) return text;
  const recipient = generated[1].trim();
  const remainder = transcript.trim().slice(spoken[0].length);
  const escaped = recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^${escaped}(?=[\\s,.!?]|$)`, 'iu').test(remainder)) return text;
  const opening = spoken[1][0]!.toUpperCase() + spoken[1].slice(1).toLowerCase();
  return `${opening} ${recipient},\n\n${text.trim().slice(generated[0].length)}`;
}

/** Enforce email boundaries without asking the model to rewrite the body again. */
export function formatEmailLineBreaks(text: string, senderName?: string): string {
  const sender = senderName?.trim().replace(/\s+/gu, ' ').slice(0, 100);
  let signed = false;
  let formatted = text.trim();
  // Only recognize a short, comma-terminated opening, never a later "hi".
  formatted = formatted.replace(
    /^((?:Hi|Hello|Hey|Dear)(?:[ \t]+(?:__MEMO_VOCAB_[A-F0-9]+_[0-9]+__|[\p{L}\p{M}'’.-]+)){0,4},)[ \t\r\n]+/iu,
    '$1\n\n',
  );

  // A closing must be at the end, with a short name rather than another sentence.
  const closing = /\b(Thanks|Thank you|Many thanks|Thanks again|Best|Best regards|Kind regards|Regards|Cheers|Sincerely),[ \t\r\n]+((?:__MEMO_VOCAB_[A-F0-9]+_[0-9]+__|[\p{Lu}][\p{L}\p{M}'’.-]*)(?:[ \t]+(?:__MEMO_VOCAB_[A-F0-9]+_[0-9]+__|[\p{Lu}][\p{L}\p{M}'’.-]*)){0,3}\.?)[ \t\r\n]*$/u.exec(formatted);
  if (closing?.[1] && closing[2]) {
    const before = formatted.slice(0, closing.index);
    if (!before || /[.!?,][ \t\r\n]+$|\n[ \t\r\n]*$/u.test(before)) {
      const name = sender || closing[2].replace(/([\p{L}\p{M}]{2,}|__)\.$/u, '$1');
      formatted = `${before.trimEnd()}${before.trim() ? '\n\n' : ''}${closing[1]},\n${name}`;
      signed = true;
    }
  }
  if (sender && !signed && formatted) {
    const bareClosing = /\b(Thanks|Thank you|Many thanks|Thanks again|Best|Best regards|Kind regards|Regards|Cheers|Sincerely)[,.!]*$/u.exec(formatted);
    const before = bareClosing ? formatted.slice(0, bareClosing.index) : '';
    if (bareClosing && (!before || /[.!?][ \t\r\n]+$|\n[ \t\r\n]*$/u.test(before))) {
      formatted = `${before.trimEnd()}${before.trim() ? '\n\n' : ''}${bareClosing[1]},\n${sender}`;
    } else if (formatted.split(/\r?\n/u).at(-1)?.trim() !== sender) {
      formatted += `\n\n${sender}`;
    }
  }
  return formatted;
}

const BROWSERS = new Set([
  'com.apple.Safari', 'com.google.Chrome', 'com.google.Chrome.canary',
  'com.microsoft.edgemac', 'com.brave.Browser', 'company.thebrowser.Browser',
  'org.mozilla.firefox',
]);

export function isEmailTarget(target: EmailTarget): boolean {
  if (target.bundleId === 'com.apple.Safari') return true;
  if (!target.bundleId || !BROWSERS.has(target.bundleId) || !target.url) return false;
  try {
    const url = new URL(target.url);
    return url.protocol === 'https:' && url.hostname === 'mail.google.com';
  } catch {
    return false;
  }
}

// Read only app identity and the active document URL, never page text or titles.
// Accessibility failures are ordinary-cleanup fallbacks, not dictation failures.
export const EMAIL_TARGET_SCRIPT = `tell application "System Events"
  set targetProcess to first application process whose frontmost is true
  set bundleIdValue to bundle identifier of targetProcess
  set documentURL to ""
  if bundleIdValue is not "com.apple.Safari" then
    try
      set focusedWindow to value of attribute "AXFocusedWindow" of targetProcess
      set documentURL to value of attribute "AXDocument" of focusedWindow
    end try
  end if
  return bundleIdValue & (ASCII character 30) & documentURL
end tell`;

export function detectEmailTarget(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise(resolve => {
    execFile('osascript', ['-e', EMAIL_TARGET_SCRIPT], {
      encoding: 'utf8', timeout: 750, maxBuffer: 8192,
    }, (error, stdout) => {
      if (error) return resolve(false);
      const [bundleId, url] = stdout.trim().split('\x1e');
      resolve(isEmailTarget({ bundleId, url }));
    });
  });
}
