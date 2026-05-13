# Voice Commands

Open Memo can recognize spoken commands in addition to normal dictation. Commands can launch apps, trigger app-specific shortcuts, and open URLs.

## Examples

- "open Safari" launches Safari.
- "new tab" while Safari is active sends Command-T.
- "go to claude.ai" opens `https://claude.ai` in the default browser.

## How Detection Works

The command system combines three layers:

1. `memo-stt` transcribes speech and receives vocabulary hints for app and command names.
2. `CommandDetector` matches transcribed text against app launch, URL, and app-scoped command patterns.
3. `CommandExecutor` launches apps, opens URLs, or sends macOS keystrokes/AppleScript actions.

```text
Speech -> memo-stt -> CommandDetector -> CommandExecutor -> macOS action
```

## Command Types

### App Launch

Open, launch, start, or run an app by name:

```text
open Safari
launch Messages
start Cursor
```

App names are matched by exact name, alias, and simple fuzzy matching.

### URLs

Open a URL or spoken domain:

```text
go to github.com
open claude dot ai
visit www.example.com
```

Open Memo adds `https://` when needed.

### App-Scoped Commands

Commands can be limited to the currently active app:

```text
new tab
close tab
new message
save
```

These only run when the matching app is active and enabled in settings.

## Default Apps

Open Memo includes defaults for common macOS apps such as Safari, Messages, Cursor, WhatsApp, and Slack. Users can enable, disable, or customize commands in the Voice Commands settings.

## Implementation Files

- `electron/main/services/CommandDetector.ts`
- `electron/main/services/CommandExecutor.ts`
- `electron/main/services/DefaultApps.ts`
- `electron/main/services/SettingsService.ts`
- `electron/main/services/MemoSttService.ts`
- `electron/renderer/src/components/VoiceCommandSettings.tsx`

## Troubleshooting

If a command is not detected:

- Confirm voice commands are enabled in settings.
- Check the app is configured and enabled.
- Verify the transcription text matches the expected phrase.
- Check logs for command confidence or AppleScript errors.

If a command executes but nothing happens:

- Confirm the target app is active for app-scoped commands.
- Confirm Accessibility permission is enabled for Memo.
- Verify configured keystrokes use syntax such as `cmd+t` or `shift+cmd+n`.
