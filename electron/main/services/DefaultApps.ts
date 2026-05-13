import { AppConfig } from './SettingsService';

export const DEFAULT_APPS: AppConfig[] = [
  {
    name: 'Safari',
    bundleId: 'com.apple.Safari',
    path: '/Applications/Safari.app',
    aliases: ['safari', 'web browser', 'browser'],
    enabled: true,
    commands: [
      { 
        trigger: 'new tab', 
        aliases: ['open tab', 'add tab'], 
        action: { type: 'keystroke', keys: 'cmd+t' } 
      },
      { 
        trigger: 'close tab', 
        aliases: ['close this tab'], 
        action: { type: 'keystroke', keys: 'cmd+w' } 
      },
      { 
        trigger: 'search', 
        aliases: ['find'], 
        action: { type: 'keystroke', keys: 'cmd+l' } 
      },
    ]
  },
  {
    name: 'Messages',
    bundleId: 'com.apple.MobileSMS',
    path: '/Applications/Messages.app',
    aliases: ['messages', 'imessage', 'text messages'],
    enabled: true,
    commands: [
      { 
        trigger: 'new message', 
        aliases: ['new conversation'], 
        action: { type: 'keystroke', keys: 'cmd+n' } 
      },
    ]
  },
  {
    name: 'Cursor',
    bundleId: 'com.todesktop.230313mzl4w4u92',
    path: '/Applications/Cursor.app',
    aliases: ['cursor', 'code editor'],
    enabled: true,
    commands: [
      { 
        trigger: 'new file', 
        aliases: ['create file'], 
        action: { type: 'keystroke', keys: 'cmd+n' } 
      },
      { 
        trigger: 'save', 
        aliases: ['save file'], 
        action: { type: 'keystroke', keys: 'cmd+s' } 
      },
    ]
  },
  {
    name: 'WhatsApp',
    bundleId: 'net.whatsapp.WhatsApp',
    path: '/Applications/WhatsApp.app',
    aliases: ['whatsapp', 'whats app'],
    enabled: true,
    commands: [
      { 
        trigger: 'new chat', 
        aliases: ['new conversation'], 
        action: { type: 'keystroke', keys: 'cmd+n' } 
      },
    ]
  },
  {
    name: 'Slack',
    bundleId: 'com.tinyspeck.slackmacgap',
    path: '/Applications/Slack.app',
    aliases: ['slack'],
    enabled: true,
    commands: [
      { 
        trigger: 'new message', 
        aliases: ['new dm'], 
        action: { type: 'keystroke', keys: 'cmd+k' } 
      },
    ]
  },
];
