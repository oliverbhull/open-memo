// Isolated promotional fixture. Never reads or changes the user's Memo database.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../electron/renderer/src/context/ThemeContext';
import { Settings } from '../../electron/renderer/src/components/Settings';
import { Feed } from '../../electron/renderer/src/components/Feed';
import './studio.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'activity';
const raw = params.has('raw');
const apps = ['Slack', 'Notes', 'Mail', 'Cursor', 'Safari'];
const sentences = [
  'The new onboarding flow is ready for review. I left a few notes on the empty states.',
  'An idea for next week: make the first five minutes feel effortless.',
  'Thanks for the conversation today. I’ll send over the updated proposal tomorrow morning.',
  'Keep the API small, make the errors useful, and document the happy path.',
  'A quiet workspace, a good idea, and a little less time at the keyboard.',
];
const entries = Array.from({ length: 384 }, (_, i) => {
  const appName = apps[i % 5];
  const date = new Date(2026, 10, 20 - Math.floor(i / 14), 8 + (i * 7 % 12), i * 11 % 60);
  const text = Array.from({ length: 1 + i % 7 }, () => sentences[i % 5]).join(' ');
  return { id: `sample-${i}`, deviceId: 'promo-fixture', text, timestamp: +date, createdAt: +date, updatedAt: +date,
    appContext: { appName, windowTitle: ['Product team', 'Ideas worth keeping', 'Following up', 'Project notes', 'Research'][i % 5] },
    context: { source: 'desktop', appContext: { appName, windowTitle: '' }, audio: { duration: text.split(/\s+/).length / 2.6 } } };
});
const settings = {
  asrModel: 'conomo', hotkey: 'function', lockHotkey: 'function+controlleft',
  groqKeySaved: false, groqCleanupEnabled: false, startAtLogin: true, saveAudio: false, dictationSounds: true,
  vocabWords: ['Open Memo', 'Conomo', 'TypeScript', 'Figma', 'PostHog', 'Core ML', 'WebSocket', 'SvelteKit'],
  phraseReplacements: [
    { id: 'signature', find: 'my signature', replace: 'Best,\nAlex Morgan\nProduct designer', enabled: true },
    { id: 'link', find: 'my booking link', replace: 'https://example.com/alex/meet', enabled: true },
    { id: 'address', find: 'office address', replace: '123 Example Street, San Francisco, CA', enabled: true },
    { id: 'name', find: 'open me mo', replace: 'Open Memo', enabled: true },
  ],
};
const noop = () => () => {};
const icons = await fetch('/scripts/promo/icons.json').then(r => r.json());
(window as any).electronAPI = {
  platform: 'darwin',
  interface: { getSettings: async () => settings, setOverlayAccentColor: async () => {}, onHotkeyCapture: noop, endHotkeyCapture: async () => {} },
  entries: { initialize: async () => ({ legacyImportComplete: true }), getAllActive: async () => entries },
  microphone: { getState: async () => ({ devices: [], selectedDeviceName: null }), onStateChanged: noop },
  onDictationLatency: noop,
  appIcons: { get: async (name: string) => icons[name] || null },
};
const copy: Record<string, { tag: string; title: React.ReactNode; description: string }> = {
  activity: { tag: 'YOUR VOICE, AT A GLANCE', title: <>See your words<br/>add up.</>, description: 'Explore your dictation habits, busiest hours, and the apps where your ideas land.' },
  history: { tag: 'A SECOND HOME FOR YOUR WORDS', title: <>Said it?<br/>Saved it.</>, description: 'Find a recent dictation. Copy it. Keep going. Your history stays on your computer.' },
  writing: { tag: 'MAKE IT SOUND LIKE YOU', title: <>Your words.<br/>Your vocabulary.</>, description: 'Save the names, acronyms, and phrases you use every day.' },
  snippets: { tag: 'LESS REPETITION, MORE FLOW', title: <>Say a little.<br/>Insert a lot.</>, description: 'Turn a spoken phrase into a signature, a link, or the text you reach for every day.' },
  hero: { tag: 'FREE. PRIVATE. OPEN SOURCE.', title: <>Good ideas move<br/>faster by voice.</>, description: 'Speak naturally. Write anywhere. Local dictation for Mac and Windows.' },
};
const selected = copy[view];
const screen = view === 'hero' ? 'activity' : view;
function AppScreen() {
  return <div className="product-window">
    <div className="window-chrome"><div className="traffic"><i/><i/><i/></div><span>Memo</span><span className="window-label">{screen === 'history' ? 'Dictation history' : 'Settings'}</span></div>
    {screen === 'history' ? <Feed entries={entries.slice(0, 5).map((entry, i) => ({ ...entry, text: sentences[i], timestamp: +new Date(2026, 10, 20, 11, 54 - i * 13), createdAt: +new Date(2026, 10, 20, 11, 54 - i * 13) }))} /> : <Settings onClose={() => {}} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider>
  {raw ? <AppScreen/> : <main className={`artboard ${view}`}>
    <header className="brand"><img src="/assets/app-icons/app-icon-192.png"/><span>Open Memo</span><span className="brand-note">VOICE → TEXT</span></header>
    <div className="editorial"><div className="eyebrow">{selected.tag}</div><h1>{selected.title}</h1><p>{selected.description}</p><div className="feature-note"><span/> {view === 'hero' ? 'No subscriptions. No credits. No usage limits.' : 'On your computer. In your control.'}</div></div>
    <div className="screen-frame"><AppScreen/></div>
    <footer><span>github.com/oliverbhull/open-memo</span><span>{view === 'hero' ? 'MAC + WINDOWS · MAC INTERFACE · SAMPLE DATA' : 'MAC INTERFACE · SAMPLE DATA'}</span></footer>
  </main>}
</ThemeProvider>);
setTimeout(() => {
  if (screen !== 'activity' && screen !== 'history') (document.querySelector(`button[aria-label="${screen[0].toUpperCase() + screen.slice(1)}"]`) as HTMLButtonElement)?.click();
  (document.activeElement as HTMLElement)?.blur();
  (window as any).promoReady = true;
}, 700);
