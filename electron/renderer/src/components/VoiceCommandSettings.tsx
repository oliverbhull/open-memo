import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';

// Types matching SettingsService (duplicated for renderer)
export type CommandAction = 
  | { type: 'applescript'; script: string }
  | { type: 'keystroke'; keys: string }
  | { type: 'url'; template: string };

export interface AppCommand {
  trigger: string;
  aliases: string[];
  action: CommandAction;
}

export interface AppConfig {
  name: string;
  bundleId?: string;
  path?: string;
  aliases: string[];
  commands: AppCommand[];
  enabled: boolean;
}

interface VoiceCommandSettingsProps {
  enabled: boolean;
  apps: AppConfig[];
  globalCommands?: AppCommand[];
  onEnabledChange: (enabled: boolean) => void;
  onAppsChange: (apps: AppConfig[]) => void;
  onGlobalCommandsChange?: (commands: AppCommand[]) => void;
}

export const VoiceCommandSettings: React.FC<VoiceCommandSettingsProps> = ({
  enabled,
  apps,
  globalCommands = [],
  onEnabledChange,
  onAppsChange,
  onGlobalCommandsChange,
}) => {
  const [editingApp, setEditingApp] = useState<AppConfig | null>(null);
  const [showAddApp, setShowAddApp] = useState(false);
  const [editingGlobal, setEditingGlobal] = useState(false);

  const handleAddApp = () => {
    const newApp: AppConfig = {
      name: '',
      aliases: [],
      commands: [],
      enabled: true,
    };
    setEditingApp(newApp);
    setShowAddApp(true);
  };

  const handleEditApp = (app: AppConfig) => {
    setEditingApp({ ...app });
    setShowAddApp(true);
  };

  const handleDeleteApp = (appName: string) => {
    onAppsChange(apps.filter(a => a.name !== appName));
  };

  const handleSaveApp = (app: AppConfig) => {
    if (!app.name.trim()) {
      return;
    }

    // Handle Global commands separately
    if (editingGlobal && app.name === 'Global') {
      if (onGlobalCommandsChange) {
        onGlobalCommandsChange(app.commands);
      }
      setEditingApp(null);
      setShowAddApp(false);
      setEditingGlobal(false);
      return;
    }

    const existingIndex = apps.findIndex(a => a.name === app.name);
    if (existingIndex >= 0) {
      const updated = [...apps];
      updated[existingIndex] = app;
      onAppsChange(updated);
    } else {
      onAppsChange([...apps, app]);
    }
    setEditingApp(null);
    setShowAddApp(false);
    setEditingGlobal(false);
  };

  const handleToggleApp = (appName: string) => {
    onAppsChange(
      apps.map(a => (a.name === appName ? { ...a, enabled: !a.enabled } : a))
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          style={{ cursor: 'pointer', width: '14px', height: '14px' }}
        />
        <span style={{ fontSize: '12px', fontWeight: '500' }}>
          Enable voice commands
        </span>
      </div>

      {enabled && (
        <>
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '6px',
          }}>
            {/* Global Commands */}
            <div
              style={{
                background: 'rgba(18, 18, 24, 0.6)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '6px',
                padding: '8px 10px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: '500' }}>
                  Global
                </div>
                {globalCommands.length > 0 && (
                  <div style={{ fontSize: '11px', opacity: 0.5 }}>
                    {globalCommands.length} command{globalCommands.length !== 1 ? 's' : ''}
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  setEditingApp({
                    name: 'Global',
                    aliases: [],
                    commands: globalCommands,
                    enabled: true,
                  });
                  setEditingGlobal(true);
                  setShowAddApp(true);
                }}
                title="Edit"
                style={{
                  padding: '4px',
                  background: 'transparent',
                  border: 'none',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.7,
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
            </div>
            
            {apps.map((app) => (
              <div
                key={app.name}
                style={{
                  background: 'rgba(18, 18, 24, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <input
                  type="checkbox"
                  checked={app.enabled}
                  onChange={() => handleToggleApp(app.name)}
                  style={{ cursor: 'pointer', width: '14px', height: '14px' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: '500' }}>
                    {app.name}
                  </div>
                  {app.commands.length > 0 && (
                    <div style={{ fontSize: '11px', opacity: 0.5 }}>
                      {app.commands.length} command{app.commands.length !== 1 ? 's' : ''}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleEditApp(app)}
                  title="Edit"
                  style={{
                    padding: '4px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.7,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDeleteApp(app.name)}
                  title="Delete"
                  style={{
                    padding: '4px',
                    background: 'transparent',
                    border: 'none',
                    color: '#ff6b6b',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.7,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={handleAddApp}
            style={{
              padding: '5px 10px',
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '6px',
              color: 'rgba(255, 255, 255, 0.7)',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: '500',
            }}
          >
            + Add App
          </button>

          {showAddApp && editingApp && (
            <AppEditModal
              app={editingApp}
              onSave={handleSaveApp}
              onCancel={() => {
                setEditingApp(null);
                setShowAddApp(false);
                setEditingGlobal(false);
              }}
              isGlobal={editingGlobal}
            />
          )}
        </>
      )}
    </div>
  );
};

interface AppEditModalProps {
  app: AppConfig;
  onSave: (app: AppConfig) => void;
  onCancel: () => void;
  isGlobal?: boolean;
}

const AppEditModal: React.FC<AppEditModalProps> = ({ app, onSave, onCancel, isGlobal = false }) => {
  const [editedApp, setEditedApp] = useState<AppConfig>({ ...app });
  const [aliasesText, setAliasesText] = useState(app.aliases.join(', '));
  const [autoFocusCommandIndex, setAutoFocusCommandIndex] = useState<number | null>(null);

  const handleSave = () => {
    const aliases = aliasesText
      .split(',')
      .map(a => a.trim())
      .filter(a => a.length > 0);
    
    onSave({
      ...editedApp,
      aliases,
    });
  };

  const handleAddCommand = () => {
    const newIndex = editedApp.commands.length;
    setEditedApp({
      ...editedApp,
      commands: [
        ...editedApp.commands,
        {
          trigger: '',
          aliases: [],
          action: { type: 'keystroke', keys: '' },
        },
      ],
    });
    setAutoFocusCommandIndex(newIndex);
  };

  const handleRemoveCommand = (index: number) => {
    setEditedApp({
      ...editedApp,
      commands: editedApp.commands.filter((_, i) => i !== index),
    });
  };

  const handleUpdateCommand = (index: number, command: AppCommand) => {
    const updated = [...editedApp.commands];
    updated[index] = command;
    setEditedApp({ ...editedApp, commands: updated });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'rgba(8, 8, 12, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '16px',
          padding: '14px',
          width: '480px',
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '8px', opacity: 0.9 }}>
          {isGlobal ? 'Global Commands' : (app.name ? app.name : 'Add App')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {!isGlobal && (
            <>
              <div>
                <label style={{ fontSize: '12px', opacity: 0.7, marginBottom: '2px', display: 'block' }}>
                  App Name
                </label>
                <input
                  type="text"
                  value={editedApp.name}
                  onChange={(e) => setEditedApp({ ...editedApp, name: e.target.value })}
                  placeholder="Safari"
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '6px',
                    color: '#fff',
                    fontSize: '13px',
                  }}
                />
              </div>

              <div>
                <label style={{ fontSize: '12px', opacity: 0.7, marginBottom: '2px', display: 'block' }}>
                  Aliases
                </label>
                <input
                  type="text"
                  value={aliasesText}
                  onChange={(e) => setAliasesText(e.target.value)}
                  placeholder="safari, web browser, browser"
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '6px',
                    color: '#fff',
                    fontSize: '13px',
                  }}
                />
              </div>
            </>
          )}

          <div>
            <label style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px', display: 'block' }}>
              Commands
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {editedApp.commands.map((cmd, index) => (
                <CommandEditor
                  key={index}
                  command={cmd}
                  autoFocusTrigger={autoFocusCommandIndex === index}
                  onAutoFocusTriggerConsumed={() => setAutoFocusCommandIndex(null)}
                  onUpdate={(updated) => handleUpdateCommand(index, updated)}
                  onRemove={() => handleRemoveCommand(index)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={handleAddCommand}
              style={{
                marginTop: '6px',
                width: '100%',
                padding: '6px 8px',
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '6px',
                color: 'rgba(255, 255, 255, 0.85)',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 500,
              }}
            >
              + Add command
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', marginTop: '10px', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 12px',
              background: 'rgba(255, 255, 255, 0.07)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '6px',
              color: 'rgba(255, 255, 255, 0.7)',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isGlobal && !editedApp.name.trim()}
            style={{
              padding: '6px 12px',
              background: (isGlobal || editedApp.name.trim()) ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '6px',
              color: '#fff',
              cursor: (isGlobal || editedApp.name.trim()) ? 'pointer' : 'default',
              fontSize: '12px',
              opacity: (isGlobal || editedApp.name.trim()) ? 1 : 0.4,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

interface CommandEditorProps {
  command: AppCommand;
  onUpdate: (command: AppCommand) => void;
  onRemove: () => void;
  autoFocusTrigger?: boolean;
  onAutoFocusTriggerConsumed?: () => void;
}

const CommandEditor: React.FC<CommandEditorProps> = ({
  command,
  onUpdate,
  onRemove,
  autoFocusTrigger = false,
  onAutoFocusTriggerConsumed,
}) => {
  const triggerInputRef = useRef<HTMLInputElement>(null);
  const [trigger, setTrigger] = useState(command.trigger);
  const [actionType, setActionType] = useState<'keystroke' | 'applescript' | 'url'>(command.action.type);
  const [actionValue, setActionValue] = useState(
    command.action.type === 'keystroke' ? command.action.keys :
    command.action.type === 'applescript' ? command.action.script :
    command.action.template
  );
  const [aliasesText, setAliasesText] = useState(command.aliases?.join(', ') || '');
  const [isRecording, setIsRecording] = useState(false);
  const keyDownHandlerRef = useRef<((e: KeyboardEvent) => Promise<void>) | null>(null);
  const isRecordingRef = useRef(false);

  const handleSave = () => {
    let action;
    if (actionType === 'keystroke') {
      action = { type: 'keystroke' as const, keys: actionValue };
    } else if (actionType === 'applescript') {
      action = { type: 'applescript' as const, script: actionValue };
    } else {
      action = { type: 'url' as const, template: actionValue };
    }

    const aliases = aliasesText
      .split(',')
      .map(a => a.trim())
      .filter(a => a.length > 0);

    onUpdate({
      ...command,
      trigger,
      aliases,
      action,
    });
  };

  useEffect(() => {
    handleSave();
  }, [trigger, actionType, actionValue, aliasesText]);

  useLayoutEffect(() => {
    if (autoFocusTrigger && triggerInputRef.current) {
      triggerInputRef.current.focus();
      onAutoFocusTriggerConsumed?.();
    }
  }, [autoFocusTrigger, onAutoFocusTriggerConsumed]);

  const handleStartRecording = async () => {
    if (actionType !== 'keystroke') {
      return;
    }

    // Clean up any existing listener first
    if (keyDownHandlerRef.current) {
      window.removeEventListener('keydown', keyDownHandlerRef.current as any, true);
      keyDownHandlerRef.current = null;
    }

    try {
      // Blur any active input to ensure keystrokes are captured properly
      if (document.activeElement && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      await window.electronAPI.keystroke.startRecording();
      setIsRecording(true);
      isRecordingRef.current = true;

      // Set up keyboard event listeners
      const handleKeyDown = async (e: KeyboardEvent) => {
        // Check if we're still recording using ref
        if (!isRecordingRef.current) {
          return;
        }

        // Don't capture if user is typing in an input field (they might have clicked back into it)
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          // User is typing in an input - don't capture, allow normal typing
          return;
        }

        // Prevent default and stop propagation for captured keystrokes
        e.preventDefault();
        e.stopPropagation();

        // Stop on Escape
        if (e.key === 'Escape') {
          isRecordingRef.current = false;
          const result = await window.electronAPI.keystroke.stopRecording();
          setIsRecording(false);
          if (result.success && result.keystroke) {
            setActionValue(result.keystroke.formatted);
          }
          if (keyDownHandlerRef.current) {
            window.removeEventListener('keydown', keyDownHandlerRef.current as any, true);
            keyDownHandlerRef.current = null;
          }
          return;
        }

        // Skip if this is just a modifier key being pressed (not a key combination)
        const modifierKeys = ['meta', 'command', 'cmd', 'control', 'ctrl', 'alt', 'option', 'shift'];
        const keyLower = e.key.toLowerCase();
        if (modifierKeys.includes(keyLower)) {
          // This is just a modifier key press, wait for the actual key
          return;
        }

        const modifiers: string[] = [];
        if (e.metaKey) modifiers.push('command');
        if (e.shiftKey) modifiers.push('shift');
        if (e.altKey) modifiers.push('option');
        if (e.ctrlKey) modifiers.push('control');

        // Get the key name
        let key = e.key.toLowerCase();
        if (key === ' ') key = 'space';
        if (key === 'enter') key = 'return';
        if (key === 'arrowup') key = 'up';
        if (key === 'arrowdown') key = 'down';
        if (key === 'arrowleft') key = 'left';
        if (key === 'arrowright') key = 'right';

        // Record the keystroke
        isRecordingRef.current = false; // Stop recording before recording the keystroke
        await window.electronAPI.keystroke.record(modifiers, key);

        // Stop recording after capturing one keystroke
        const result = await window.electronAPI.keystroke.stopRecording();
        setIsRecording(false);

        if (result.success && result.keystroke) {
          setActionValue(result.keystroke.formatted);
        }

        // Remove listener
        if (keyDownHandlerRef.current) {
          window.removeEventListener('keydown', keyDownHandlerRef.current as any, true);
          keyDownHandlerRef.current = null;
        }
      };

      keyDownHandlerRef.current = handleKeyDown;
      window.addEventListener('keydown', handleKeyDown, true); // Use capture phase
    } catch (error) {
      console.error('Failed to start recording:', error);
      setIsRecording(false);
      isRecordingRef.current = false;
      keyDownHandlerRef.current = null;
    }
  };

  const handleStopRecording = async () => {
    try {
      // Stop recording flag first
      isRecordingRef.current = false;

      // Clean up listener
      if (keyDownHandlerRef.current) {
        window.removeEventListener('keydown', keyDownHandlerRef.current as any, true);
        keyDownHandlerRef.current = null;
      }

      const result = await window.electronAPI.keystroke.stopRecording();
      setIsRecording(false);

      if (result.success && result.keystroke) {
        setActionValue(result.keystroke.formatted);
      }
    } catch (error) {
      console.error('Failed to stop recording:', error);
      setIsRecording(false);
      isRecordingRef.current = false;
      if (keyDownHandlerRef.current) {
        window.removeEventListener('keydown', keyDownHandlerRef.current as any, true);
        keyDownHandlerRef.current = null;
      }
    }
  };

  // Cleanup listener on unmount
  useEffect(() => {
    return () => {
      isRecordingRef.current = false;
      if (keyDownHandlerRef.current) {
        window.removeEventListener('keydown', keyDownHandlerRef.current as any, true);
        keyDownHandlerRef.current = null;
      }
    };
  }, []);

  return (
    <div
      style={{
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '6px',
        padding: '6px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          ref={triggerInputRef}
          type="text"
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          placeholder="Command phrase"
          style={{
            flex: 1,
            minWidth: '120px',
            padding: '5px 6px',
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '4px',
            color: '#fff',
            fontSize: '12px',
          }}
        />
        <select
          value={actionType}
          onChange={(e) => setActionType(e.target.value as 'keystroke' | 'applescript' | 'url')}
          style={{
            padding: '5px 6px',
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '4px',
            color: '#fff',
            fontSize: '12px',
            cursor: 'pointer',
            minWidth: '100px',
          }}
        >
          <option value="keystroke">Keystroke</option>
          <option value="applescript">AppleScript</option>
          <option value="url">URL</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <input
          type="text"
          value={actionValue}
          onChange={(e) => setActionValue(e.target.value)}
          placeholder={
            actionType === 'keystroke' ? 'cmd+t' :
            actionType === 'applescript' ? 'tell application "Safari" to activate' :
            'https://example.com'
          }
          style={{
            flex: 1,
            padding: '5px 6px',
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '4px',
            color: '#fff',
            fontSize: '12px',
          }}
        />
        {actionType === 'keystroke' && (
          <button
            onClick={isRecording ? handleStopRecording : handleStartRecording}
            title={isRecording ? 'Stop recording (or press Escape)' : 'Record keystroke'}
            style={{
              padding: '5px',
              background: isRecording ? 'rgba(255, 0, 0, 0.3)' : 'rgba(255, 255, 255, 0.1)',
              border: isRecording ? '1px solid rgba(255, 0, 0, 0.5)' : '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '4px',
              color: isRecording ? '#ff6b6b' : '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: '30px',
              height: '30px',
            }}
          >
            {isRecording ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
              </svg>
            )}
          </button>
        )}
        <button
          onClick={onRemove}
          title="Remove"
          style={{
            padding: '4px',
            background: 'transparent',
            border: 'none',
            color: 'rgba(255, 100, 100, 0.5)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255, 100, 100, 0.9)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255, 100, 100, 0.5)'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div
        style={{
          marginTop: '0',
          paddingTop: '6px',
          borderTop: '1px solid rgba(255, 255, 255, 0.06)',
          fontSize: '11px',
        }}
      >
        <div style={{ marginBottom: '3px', opacity: 0.7, fontSize: '10px' }}>Aliases</div>
        <input
          type="text"
          value={aliasesText}
          onChange={(e) => setAliasesText(e.target.value)}
          placeholder="Spoken alternatives, comma-separated"
          style={{
            width: '100%',
            padding: '5px 6px',
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '4px',
            color: '#fff',
            fontSize: '11px',
          }}
        />
      </div>
    </div>
  );
};
