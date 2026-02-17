/**
 * Icon utility functions for distinguishing Material Icons from emoji
 */

/** Check if an icon string represents a Material Icon (prefixed with "mat:") */
export function isMatIcon(icon: string): boolean {
  return icon.startsWith('mat:');
}

/** Extract the Material Icon name from a "mat:icon_name" string */
export function getMatIconName(icon: string): string {
  return icon.replace('mat:', '');
}
