# Browser and Gmail context capture

Memo captures context at dictation delivery, immediately before paste, rather than at recording start. Existing saved entries are not backfilled.

## Website identity

`checkedPaste.ts` asks macOS System Events for the frontmost process, focused window title and `AXDocument` URL. Safari often supplies no `AXDocument`; Memo then reads the Smart Search field inside that same window's toolbar. Chrome supplies `AXDocument` on its ordinary browser windows. Only the hostname is retained for ordinary websites.

The icon service requests the site's public `/favicon.ico`, following at most three HTTPS redirects. It sends no browser cookies or page URL. Successful icons and failures are cached for the app session. Missing or undecodable icons fall back to the installed browser icon.

## Gmail reply metadata

A small Swift helper (`sidecars/browser-context/main.swift`) reads Accessibility directly through ApplicationServices. It does not use browser JavaScript, a browser extension, screenshots/OCR or Gmail API credentials.

1. Identify the foreground browser and its focused window. Read the window document URL or its native address-bar field.
2. Require Gmail and a focused `Message Body` text area. Follow its ancestors to the enclosing reply region. Chrome has more wrapper groups than Safari.
3. Find `Type of response` within that region. Read visible recipient labels only from the associated header container. Never substitute the original message sender or scan the message body for email addresses.
4. Read the single level-two subject heading from the containing conversation, skipping the message list and editor subtrees.
5. Normalize the observed Gmail conversation route to `https://mail.google.com/mail/u/N/#all/THREAD`. Strip query parameters and folder/search terms. The route token is not treated as a Gmail API thread ID.
6. After the paste target is captured, retain reply metadata only when browser, window title and conversation route still match the snapshot.

The helper traverses at most 250 nodes with a 220 ms time budget and a short per-request AX timeout. The main process allows at most 600 ms for the subprocess; errors or missing attributes leave normal dictation delivery intact. Typical read-only diagnostic captures in this session took about 35–45 ms.

History and JSON export retain `appContext.emailReply` with `source: accessibility`, optional `subject`, optional `replyTo` labels, and `threadUrl`. Gmail reply entries display only the subject in the title. Expanded entries display recipients. The thread URL remains saved, but the UI currently hides the thread-link button.

## Verification and limits

On October 16, 2026, the native helper captured the same subject, recipient label and conversation route from an existing Gmail reply in both Safari and Chrome. A read-only check of the delivery-context merge also passed for Safari. Chrome's System Events window was unavailable during the background merge check, so that check discarded metadata as designed; a fresh foreground dictation remains the final end-to-end Chrome check. No message was sent or dictation text inserted by these probes.

Automated tests cover route normalization, inbox/compose/foreign-link rejection, destination mismatch, recipient filtering, both browser identities, paste-result propagation and favicon fallback. Type checks, the full test suite and main/preload/renderer builds pass.

Only the visible recipient labels have been verified. Reply-all, edited/expanded recipient chips, pop-out compose windows, non-English Gmail, other mail providers and every Chrome/Safari version are not validated. Unavailable fields remain absent. Gmail account numbers in links refer to the browser's signed-in account ordering. Metadata does not follow later thread changes.

Build the helper with `npm run build:browser-context`; main builds do this automatically, and packaged apps include it as an extra resource. Restart the dev Electron app to load main-process/preload changes; the Vite renderer alone cannot hot-reload those.
