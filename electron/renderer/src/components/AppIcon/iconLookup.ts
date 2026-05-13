import * as simpleIcons from 'simple-icons';
import { APP_NAME_TO_SLUG } from './iconMappings';

/**
 * Static map of slug to icon data for O(1) lookup
 * Built once at module load time
 */
const SLUG_TO_ICON_MAP = new Map<string, any>();

// Build the slug-to-icon map once at module load
(function buildIconMap() {
  const icons = simpleIcons as any;
  for (const key in icons) {
    const icon = icons[key];
    if (icon && typeof icon === 'object' && icon.slug) {
      SLUG_TO_ICON_MAP.set(icon.slug.toLowerCase(), icon);
      // Also index by title for faster lookup
      if (icon.title) {
        SLUG_TO_ICON_MAP.set(icon.title.toLowerCase(), icon);
      }
    }
  }
})();

/**
 * Cache for app name to slug lookups
 */
const lookupCache = new Map<string, string | null>();

/**
 * Finds an icon by its slug (O(1) lookup)
 */
export function findIconBySlug(slug: string): any {
  return SLUG_TO_ICON_MAP.get(slug.toLowerCase()) || null;
}

/**
 * Optimized icon slug lookup with caching
 * Uses static mappings first, then falls back to icon search
 */
export function getIconSlug(appName: string): string | null {
  if (!appName) return null;
  
  const normalized = appName.toLowerCase().trim();
  
  // Check cache first
  const cached = lookupCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }
  
  let result: string | null = null;
  
  // 1. Check direct mapping (O(1))
  if (APP_NAME_TO_SLUG[normalized]) {
    result = APP_NAME_TO_SLUG[normalized];
    lookupCache.set(normalized, result);
    return result;
  }
  
  // 2. Try partial match in mappings (O(n) but n is small ~50)
  for (const [key, value] of Object.entries(APP_NAME_TO_SLUG)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      result = value;
      lookupCache.set(normalized, result);
      return result;
    }
  }
  
  // 3. Check if normalized name is already a slug (O(1))
  if (SLUG_TO_ICON_MAP.has(normalized)) {
    result = normalized;
    lookupCache.set(normalized, result);
    return result;
  }
  
  // 4. Search by title in icon map (O(1) if title matches exactly)
  const titleIcon = SLUG_TO_ICON_MAP.get(normalized);
  if (titleIcon && titleIcon.slug) {
    result = titleIcon.slug;
    lookupCache.set(normalized, result);
    return result;
  }
  
  // 5. Last resort: linear search through icons (only if not found in cache)
  // This is expensive but rare
  const icons = simpleIcons as any;
  for (const key in icons) {
    const icon = icons[key];
    if (icon && typeof icon === 'object') {
      // Check title match
      if (icon.title && icon.title.toLowerCase() === normalized) {
        result = icon.slug;
        lookupCache.set(normalized, result);
        return result;
      }
      // Check slug match
      if (icon.slug && icon.slug.toLowerCase() === normalized) {
        result = icon.slug;
        lookupCache.set(normalized, result);
        return result;
      }
      // Check partial title match
      if (icon.title && (
        icon.title.toLowerCase().includes(normalized) || 
        normalized.includes(icon.title.toLowerCase())
      )) {
        result = icon.slug;
        lookupCache.set(normalized, result);
        return result;
      }
      // Check partial slug match
      if (icon.slug && (
        icon.slug.toLowerCase().includes(normalized) || 
        normalized.includes(icon.slug.toLowerCase())
      )) {
        result = icon.slug;
        lookupCache.set(normalized, result);
        return result;
      }
    }
  }
  
  // Cache null result to avoid repeated searches
  lookupCache.set(normalized, null);
  return null;
}


