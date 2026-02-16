/**
 * Color utility functions for theme management
 */

/**
 * Parse a hex color string to RGB components
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : null;
}

/**
 * Convert RGB to hex color string
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Calculate relative luminance of a color (WCAG 2.0)
 */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [rs, gs, bs] = [rgb.r / 255, rgb.g / 255, rgb.b / 255].map(c =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors (WCAG 2.0)
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick the best contrasting text color for a given background.
 * Returns a light or dark text color that ensures readability.
 */
export function getContrastingTextColor(bgHex: string): string {
  const lum = relativeLuminance(bgHex);
  // Use white text on dark backgrounds, dark text on light backgrounds
  return lum > 0.179 ? '#1a1a1a' : '#e5e5e5';
}

/**
 * Derive a secondary text color (muted) from a primary text color
 */
export function getMutedTextColor(bgHex: string): string {
  const lum = relativeLuminance(bgHex);
  return lum > 0.179 ? '#718096' : '#737373';
}

/**
 * Derive a secondary text color from a primary text color
 */
export function getSecondaryTextColor(bgHex: string): string {
  const lum = relativeLuminance(bgHex);
  return lum > 0.179 ? '#4a5568' : '#a3a3a3';
}

/**
 * Derive a border color appropriate for the given background
 */
export function getBorderColor(bgHex: string): string {
  const lum = relativeLuminance(bgHex);
  return lum > 0.179 ? '#e2e8f0' : '#262626';
}

/**
 * Lighten or darken a hex color by a given amount (0-100)
 */
export function adjustBrightness(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return rgbToHex(
    clamp(rgb.r + amount),
    clamp(rgb.g + amount),
    clamp(rgb.b + amount)
  );
}

/**
 * Derive secondary/tertiary/hover background colors from a primary background
 */
export function deriveBackgroundColors(bgPrimary: string): {
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
} {
  const lum = relativeLuminance(bgPrimary);
  if (lum > 0.179) {
    // Light background: derive darker variants
    return {
      bgSecondary: adjustBrightness(bgPrimary, -8),
      bgTertiary: adjustBrightness(bgPrimary, -18),
      bgHover: adjustBrightness(bgPrimary, -28),
    };
  } else {
    // Dark background: derive lighter variants
    return {
      bgSecondary: adjustBrightness(bgPrimary, 10),
      bgTertiary: adjustBrightness(bgPrimary, 18),
      bgHover: adjustBrightness(bgPrimary, 28),
    };
  }
}
