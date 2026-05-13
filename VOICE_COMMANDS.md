# Voice Commands System Documentation

## Overview

The voice commands system allows users to control their Mac applications through voice commands. Users can launch apps, execute app-specific commands, and open URLs by speaking naturally.

**Example Commands:**
- "open Safari" → Launches Safari
- "new tab" (while Safari is active) → Opens a new tab in Safari
- "go to claude.ai" → Opens https://claude.ai in the default browser

## Architecture

The system uses a **hybrid approach** combining:

1. **Word Boosting (Rust/memo-stt)**: Improves speech recognition accuracy for app names and commands
2. **Command Detection (TypeScript)**: Pattern matching and fuzzy matching for command recognition
3. **Command Execution (TypeScript)**: Executes actions via macOS system APIs

### Data Flow

```
User speaks → memo-stt (with vocabulary boost) → Transcription JSON
    ↓
CommandDetector (pattern matching)
    ↓
CommandExecutor (app launch/keystrokes/URLs)
    ↓
Action executed + UI feedback
```

## Command Detection

The `CommandDetector` class analyzes transcriptions and detects three types of commands:

### 1. App Launch Commands

**Pattern:** `open|launch|start|run <app_name>`

**Regex:**
```typescript
/^(?:open|launch|start|run)\s+(.+)$/i
```

**Examples:**
- "open Safari" → Detects Safari app
- "launch Messages" → Detects Messages app
- "start Cursor" → Detects Cursor app
- "open Safari." → Handles trailing punctuation automatically

**Matching Process:**
1. Extracts app name from transcription
2. Removes trailing punctuation (`.`, `!`, `?`, `;`, `:`)
3. Searches for app using:
   - Exact match on app name
   - Exact match on aliases
   - Fuzzy matching (contains/substring match)

**Confidence:** 0.9 (highest priority)

### 2. URL Commands

**Pattern:** `go to|goto|open|visit <url>`

**Regex:**
```typescript
/^(?:go to|goto|open|visit)\s+(.+)$/i
```

**Supported URL Formats:**

| Spoken Format | Detected URL |
|--------------|--------------|
| `claude.ai` | `https://claude.ai` |
| `google.com` | `https://google.com` |
| `claude dot ai` | `https://claude.ai` |
| `www.claude.ai` | `https://www.claude.ai` |
| `https://claude.ai` | `https://claude.ai` (unchanged) |

**URL Detection Regex Patterns:**

1. **Simple domain:** `/^[a-z0-9-]+\.[a-z]{2,}$/i`
   - Matches: `claude.ai`, `google.com`
   - Adds `https://` prefix

2. **Spoken dots:** `/^[a-z0-9-]+\s+dot\s+[a-z]+$/i`
   - Matches: `claude dot ai`
   - Converts to: `claude.ai`

3. **WWW prefix:** `/^(https?:\/\/|www\.)/i`
   - Matches: `www.claude.ai`, `https://claude.ai`
   - Adds `https://` if needed

**Confidence:** 0.85

### 3. App-Scoped Commands

**Pattern:** `<command>` (only when the target app is active)

**Examples:**
- "new tab" (Safari active) → Opens new tab
- "close tab" (Safari active) → Closes current tab
- "new message" (Messages active) → Creates new message

**Matching Process:**
1. Checks if a configured app is currently active (from `appContext`)
2. Searches that app's command list for:
   - Exact match on trigger
   - Exact match on aliases
   - Substring match (contains)

**Confidence:** 0.8

## Matching Features

### Fuzzy Matching

The system uses multiple matching strategies for flexibility:

#### 1. Exact Matching (Highest Priority)
- App name: `"Safari"` matches `"Safari"`
- Alias: `"web browser"` matches `"web browser"`
- Case-insensitive

#### 2. Contains Matching (Fallback)
- `"saf"` matches `"Safari"` (substring)
- `"Safari"` matches `"safari browser"` (contains)
- Works both ways (A contains B or B contains A)

#### 3. Alias Matching
Each app can have multiple aliases:
```typescript
{
  name: 'Safari',
  aliases: ['safari', 'web browser', 'browser']
}
```

All aliases are checked before falling back to fuzzy matching.

### Command Matching

Commands support:
- **Trigger:** Primary voice command
- **Aliases:** Alternative phrases

Example:
```typescript
{
  trigger: 'new tab',
  aliases: ['open tab', 'add tab']
}
```

All of these will work:
- "new tab"
- "open tab"
- "add tab"

## Default Applications

The system comes with 5 pre-configured applications:

### 1. Safari

**Bundle ID:** `com.apple.Safari`  
**Path:** `/Applications/Safari.app`  
**Aliases:** `safari`, `web browser`, `browser`

**Commands:**
- **"new tab"** → `⌘T` (aliases: "open tab", "add tab")
- **"close tab"** → `⌘W` (aliases: "close this tab")
- **"search"** → `⌘L` (aliases: "find")

### 2. Messages

**Bundle ID:** `com.apple.MobileSMS`  
**Path:** `/Applications/Messages.app`  
**Aliases:** `messages`, `imessage`, `text messages`

**Commands:**
- **"new message"** → `⌘N` (aliases: "new conversation")

### 3. Cursor

**Bundle ID:** `com.todesktop.230313mzl4w4u92`  
**Path:** `/Applications/Cursor.app`  
**Aliases:** `cursor`, `code editor`

**Commands:**
- **"new file"** → `⌘N` (aliases: "create file")
- **"save"** → `⌘S` (aliases: "save file")

### 4. WhatsApp

**Bundle ID:** `net.whatsapp.WhatsApp`  
**Path:** `/Applications/WhatsApp.app`  
**Aliases:** `whatsapp`, `whats app`

**Commands:**
- **"new chat"** → `⌘N` (aliases: "new conversation")

### 5. Slack

**Bundle ID:** `com.tinyspeck.slackmacgap`  
**Path:** `/Applications/Slack.app`  
**Aliases:** `slack`

**Commands:**
- **"new message"** → `⌘K` (aliases: "new dm")

## Command Execution

### App Launching

**Priority:**
1. Bundle ID (preferred): `open -b com.apple.Safari`
2. App Path (fallback): `/Applications/Safari.app`

**Implementation:**
```typescript
if (appConfig.bundleId) {
  execSync(`open -b ${appConfig.bundleId}`);
} else if (appConfig.path) {
  await shell.openPath(appConfig.path);
}
```

### Keystroke Execution

**Format:** `modifier+key`

**Supported Modifiers:**
- `cmd` or `command` → Command key
- `shift` → Shift key
- `alt` or `option` → Option key
- `ctrl` or `control` → Control key

**Examples:**
- `cmd+t` → Command+T
- `cmd+shift+n` → Command+Shift+N
- `cmd+alt+s` → Command+Option+S

**Conversion to AppleScript:**
```
"cmd+t" → tell application "System Events" to keystroke "t" using {command down}
```

### AppleScript Execution

Direct AppleScript execution for complex actions:

```typescript
{
  type: 'applescript',
  script: 'tell application "Safari" to activate'
}
```

### URL Opening

Uses Electron's `shell.openExternal()` to open URLs in the default browser.

## Vocabulary Boosting

To improve speech recognition accuracy, app names and commands are sent to the Whisper model as vocabulary hints.

### Vocabulary Format

Sent to memo-stt via stdin:
```
VOCAB:{"apps":["Safari","Messages","Cursor"],"commands":["new tab","close tab","search"]}
```

### Prompt Building

The vocabulary is combined with app context in the transcription prompt:

```
You are transcribing for Safari. The current window is: GitHub.
Voice commands: open Safari, Messages, Cursor. Commands: new tab, close tab, search.
```

This helps Whisper recognize:
- App names more accurately
- Command phrases more reliably
- Technical terms and proper nouns

## Detection Priority

Commands are detected in this order (first match wins):

1. **App Launch** (confidence: 0.9)
   - Highest priority
   - Matches: "open Safari", "launch Messages"

2. **URL** (confidence: 0.85)
   - Second priority
   - Matches: "go to claude.ai", "visit google.com"

3. **App Command** (confidence: 0.8)
   - Only when app is active
   - Matches: "new tab" (Safari active)

4. **Normal Transcription** (confidence: 0)
   - Fallback if no command detected
   - Text is injected normally

## Confidence Threshold

Commands must have **confidence ≥ 0.7** to execute. Lower confidence commands are ignored and treated as normal transcription.

## Configuration

### Settings Structure

```typescript
{
  voiceCommands: {
    enabled: true,  // Enable/disable voice commands
    apps: AppConfig[],  // Configured applications
    globalCommands: AppCommand[],  // Global commands (future)
    urlPatterns: string[]  // Custom URL patterns (future)
  }
}
```

### App Configuration

```typescript
{
  name: string,           // Display name
  bundleId?: string,      // macOS bundle identifier
  path?: string,          // Application path
  aliases: string[],      // Voice trigger aliases
  commands: AppCommand[], // App-specific commands
  enabled: boolean        // Enable/disable this app
}
```

### Command Configuration

```typescript
{
  trigger: string,        // Primary voice command
  aliases: string[],      // Alternative phrases
  action: CommandAction  // Action to execute
}
```

### Action Types

1. **Keystroke:**
   ```typescript
   { type: 'keystroke', keys: 'cmd+t' }
   ```

2. **AppleScript:**
   ```typescript
   { type: 'applescript', script: 'tell application "Safari" to activate' }
   ```

3. **URL:**
   ```typescript
   { type: 'url', template: 'https://example.com' }
   ```

## Examples

### Example 1: Launch Safari

**User says:** "open Safari"

**Detection:**
1. Matches app launch pattern: `/^(?:open|launch|start|run)\s+(.+)$/i`
2. Extracts: `"Safari"`
3. Finds app by name: `Safari`
4. Confidence: 0.9

**Execution:**
1. Calls `openApp({ name: 'Safari', bundleId: 'com.apple.Safari' })`
2. Executes: `open -b com.apple.Safari`
3. Safari launches

### Example 2: New Tab in Safari

**User says:** "new tab" (while Safari is active)

**Detection:**
1. Active app: `"Safari"`
2. Finds Safari config
3. Matches command: `"new tab"`
4. Confidence: 0.8

**Execution:**
1. Calls `executeCommand({ type: 'keystroke', keys: 'cmd+t' })`
2. Converts to AppleScript: `tell application "System Events" to keystroke "t" using {command down}`
3. New tab opens

### Example 3: Open URL

**User says:** "go to claude.ai"

**Detection:**
1. Matches URL pattern: `/^(?:go to|goto|open|visit)\s+(.+)$/i`
2. Extracts: `"claude.ai"`
3. Matches domain pattern: `/^[a-z0-9-]+\.[a-z]{2,}$/i`
4. Confidence: 0.85

**Execution:**
1. Calls `executeCommand({ type: 'url', template: 'https://claude.ai' })`
2. Opens URL in default browser

### Example 4: Fuzzy Matching

**User says:** "open saf" (partial match)

**Detection:**
1. Matches app launch pattern
2. Extracts: `"saf"`
3. Exact match fails
4. Fuzzy match succeeds: `"Safari".includes("saf")`
5. Confidence: 0.9

**Execution:**
1. Launches Safari (same as Example 1)

## Troubleshooting

### Command Not Detected

1. **Check voice commands are enabled:**
   - Settings → Voice Commands → Toggle enabled

2. **Check app is configured:**
   - Settings → Voice Commands → Verify app exists and is enabled

3. **Check confidence threshold:**
   - Commands need confidence ≥ 0.7
   - Check logs for: `Command detected but confidence too low`

4. **Check transcription:**
   - Verify the exact text transcribed matches expected patterns
   - Logs show: `Command detection: text="..."`

### App Not Launching

1. **Check bundle ID/path:**
   - Verify app exists at configured path
   - Check bundle ID is correct: `mdls -name kCFBundleIdentifier /Applications/Safari.app`

2. **Check permissions:**
   - macOS may require Accessibility permissions for some actions

### Command Executes But Nothing Happens

1. **Check active app:**
   - App-scoped commands only work when the target app is active
   - Verify `appContext.appName` matches configured app name

2. **Check keystroke format:**
   - Verify keystroke syntax: `cmd+t`, `shift+cmd+n`
   - Check logs for AppleScript errors

## Implementation Files

- **Command Detection:** `electron/main/services/CommandDetector.ts`
- **Command Execution:** `electron/main/services/CommandExecutor.ts`
- **Default Apps:** `electron/main/services/DefaultApps.ts`
- **Settings:** `electron/main/services/SettingsService.ts`
- **Integration:** `electron/main/services/MemoSttService.ts`
- **UI:** `electron/renderer/src/components/VoiceCommandSettings.tsx`
- **Vocabulary:** `memo-stt/src/main.rs` (VOCAB: command handler)
