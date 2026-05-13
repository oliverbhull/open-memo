/**
 * Static mappings from app names to simple-icons slugs
 * This is created once at module load time for O(1) lookups
 */

export const APP_NAME_TO_SLUG: Record<string, string> = {
  // Messaging
  'slack': 'slack',
  'discord': 'discord',
  'telegram': 'telegram',
  'whatsapp': 'whatsapp',
  'signal': 'signal',
  'messages': 'apple',
  'imessage': 'apple',
  
  // Code editors
  'vscode': 'visualstudiocode',
  'visual studio code': 'visualstudiocode',
  'code': 'visualstudiocode',
  'cursor': 'cursor',
  'sublime': 'sublimetext',
  'sublime text': 'sublimetext',
  'atom': 'atom',
  'vim': 'vim',
  'neovim': 'neovim',
  
  // AI/Chat
  'chatgpt': 'openai',
  'openai': 'openai',
  'claude': 'anthropic',
  'anthropic': 'anthropic',
  'perplexity': 'perplexity',
  'gemini': 'google',
  'bard': 'google',
  
  // Browsers
  'chrome': 'googlechrome',
  'google chrome': 'googlechrome',
  'safari': 'safari',
  'firefox': 'firefox',
  'edge': 'microsoftedge',
  'microsoft edge': 'microsoftedge',
  'brave': 'brave',
  
  // Productivity
  'notion': 'notion',
  'obsidian': 'obsidian',
  'roam': 'roamresearch',
  'roam research': 'roamresearch',
  'evernote': 'evernote',
  'onenote': 'microsoftonenote',
  'microsoft onenote': 'microsoftonenote',
  
  // Email
  'gmail': 'gmail',
  'outlook': 'microsoftoutlook',
  'microsoft outlook': 'microsoftoutlook',
  'mail': 'apple',
  'apple mail': 'apple',
  
  // Social
  'twitter': 'x',
  'x': 'x',
  'linkedin': 'linkedin',
  'facebook': 'facebook',
  'instagram': 'instagram',
  'reddit': 'reddit',
  
  // Development
  'github': 'github',
  'gitlab': 'gitlab',
  'bitbucket': 'bitbucket',
  'docker': 'docker',
  'kubernetes': 'kubernetes',
  
  // Cloud/Storage
  'dropbox': 'dropbox',
  'google drive': 'googledrive',
  'onedrive': 'microsoftonedrive',
  'microsoft onedrive': 'microsoftonedrive',
  'icloud': 'apple',
  
  // Video/Media
  'youtube': 'youtube',
  'vimeo': 'vimeo',
  'spotify': 'spotify',
  'apple music': 'applemusic',
  'netflix': 'netflix',
  
  // Other common apps
  'zoom': 'zoom',
  'teams': 'microsoftteams',
  'microsoft teams': 'microsoftteams',
  'figma': 'figma',
  'adobe': 'adobe',
  'photoshop': 'adobe',
  'illustrator': 'adobe',
};


