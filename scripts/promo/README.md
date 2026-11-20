# Promotional asset studio

These draft graphics use the current React Settings and Feed components with a
separate, deterministic fixture. They never connect to the real Memo entry store,
request microphone access, or open the installed Memo app. All dictations,
activity totals, vocabulary, names, links, and snippets are fictional.

From the repository root, with dependencies installed:

```sh
node_modules/.bin/electron --disable-gpu scripts/promo/render.cjs
```

The renderer starts a temporary Vite server bound to `127.0.0.1:5198`, captures
nine PNGs, then closes its window and server. Local app artwork is used when
available; missing icons use the real component's initials fallback. Temporary
icon data is deleted after rendering. No new package dependencies are required.

Edit `preview.tsx` for copy and sample data, `studio.css` for the surrounding
layout. Settings, Activity, and Feed styling comes directly from the app. The
macOS-style window chrome is a presentation frame, rather than a capture of the
native OS title bar. These are component renders, not end-to-end product tests.

## Outputs

All outputs live in `assets/readme/promo/`:

| File | Size | Suggested use |
| --- | --- | --- |
| `hero.png` | 3200 × 1800 | README banner, presentation, website |
| `activity.png` | 3200 × 2000 | Activity feature promotion |
| `history.png` | 3200 × 2000 | Dictation history feature promotion |
| `writing.png` | 3200 × 2000 | Vocabulary feature promotion |
| `snippets.png` | 3200 × 2000 | Spoken shortcuts feature promotion |
| `writing-screenshot.png` | 1720 × 1480 | Complete Writing settings |
| Other `*-screenshot.png` | 1720 × 1240 | Plain screenshots for README and documentation |

All graphics show the Mac interface. The hero describes both supported platforms;
it does not depict Windows. The Windows release remains an unsigned preview as
described in the main README. Activity's typing-time estimate uses the actual
component calculation: timed dictation words / 40 WPM minus speaking duration.
Do not describe the fictional totals as a benchmark or measured customer result.
