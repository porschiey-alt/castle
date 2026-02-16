# Research: Dynamic Theme Adjustments

## Problem Statement

The current settings page provides a static 4-preset theme picker (Castle Dark, Castle Light, Midnight Blue, AMOLED Black). Users select a preset and that's it — no ability to personalize colors. The requested feature transforms this into a full theme customization experience:

1. **Keep presets** as starting points the user selects from.
2. **Let users adjust** primary color, accent color, and background colors after selecting a preset.
3. **Implement background gradients** — allow the background to be a configurable gradient instead of a flat color.
4. **Auto-compute text colors** using contrast algorithms to ensure readability (preventing black text on black backgrounds, etc.).

---

## Current Architecture Analysis

### Theme Service (`src/app/core/services/theme.service.ts`)

- **4 hardcoded presets** in a `readonly availableThemes: CastleTheme[]` array.
- Current theme stored as an Angular **signal**: `currentTheme = signal<CastleTheme>(...)`.
- `applyTheme()` writes **15 CSS custom properties** to `document.documentElement.style`:
  - Color identity: `--theme-primary`, `--theme-accent`, `--theme-warn`
  - Background tiers: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-hover`
  - Text tiers: `--text-primary`, `--text-secondary`, `--text-muted`
  - Structural: `--border-color`, `--user-bubble`, `--agent-bubble`, `--code-bg`
- Adds a **body class** matching the theme ID (e.g. `castle-dark`, `midnight`) for Angular Material palette switching.
- Persists **only the theme ID string** to settings via `electronService.updateSettings({ theme: themeId })`.

### CastleTheme Interface

```ts
export interface CastleTheme {
  id: string;
  name: string;
  mode: ThemeMode;        // 'light' | 'dark'
  primary: string;        // e.g. '#6366f1'
  accent: string;         // e.g. '#22c55e'
  warn: string;           // e.g. '#ef4444'
  bgPrimary?: string;
  bgSecondary?: string;
  bgTertiary?: string;
  bgHover?: string;
  textPrimary?: string;
  textSecondary?: string;
  textMuted?: string;
  borderColor?: string;
}
```

Light theme (`castle-light`) omits `bg*`/`text*` properties — they're hardcoded in `applyTheme()` for light mode. Dark themes define all properties explicitly.

### Settings Persistence Layer

- **`AppSettings.theme`**: Single string field (e.g. `'castle-dark'`), stored in SQLite `settings` table as `key/value` pairs.
- **`DatabaseService`**: Generic `getSettings()` / `updateSettings(Partial<AppSettings>)` using JSON serialization per key.
- **No field exists** for custom color overrides or gradient configuration.
- The settings store is flexible — any new key added to `AppSettings` is automatically serialized/deserialized via the existing generic mechanism. **No schema migration needed.**

### Global Styles (`src/styles/styles.scss`)

- `:root` block defines CSS variable defaults matching the Castle Dark theme.
- Body class selectors `.castle-dark`, `.midnight`, `.amoled` trigger Angular Material dark palette via `@include mat.all-component-colors(mat.define-dark-theme(...))`.
- `.castle-light` overrides CSS variables and includes Material light palette.
- **18 SCSS files** across the app reference these CSS variables (counted 200+ `var(--` usages total).
- Body background: `background-color: var(--bg-primary)` — no gradient support currently.
- No `background-image` or `--bg-gradient` variable exists anywhere.

### Settings Page (`src/app/features/settings/settings-page.component.*`)

- Simple grid of theme cards with preview swatches.
- `setTheme(themeId)` calls `ThemeService.setTheme()`.
- No color picker inputs, no customization controls.

### CSS Variable Dependency Map

All components use the CSS variables indirectly. The critical insight is that **changing the CSS variables at the document root propagates everywhere automatically** — no individual component changes needed for color adjustments.

| Variable | Used By (count of files) |
|----------|-------------------------|
| `--bg-primary` | 14 SCSS files |
| `--bg-secondary` | 14 SCSS files |
| `--text-primary` | 17 SCSS files |
| `--text-secondary` | 17 SCSS files |
| `--theme-primary` | 14 SCSS files |
| `--border-color` | 12 SCSS files |

---

## Proposed Approach

### 1. Data Model Changes

#### New Interfaces (`src/shared/types/settings.types.ts`)

```ts
/** A single stop in a CSS linear-gradient */
export interface GradientStop {
  color: string;       // hex color, e.g. '#0a0a0a'
  position: number;    // percentage 0-100
}

/** Configuration for a background gradient */
export interface GradientConfig {
  angle: number;              // degrees, 0-360 (0 = to top, 180 = to bottom)
  stops: GradientStop[];      // minimum 2 stops
}

/** User's custom color overrides layered on top of a preset */
export interface ThemeCustomization {
  basePresetId: string;       // which preset this customization extends

  // User-editable color overrides (sparse — only set values override the preset)
  primary?: string;           // primary/brand color (buttons, links, selection highlight)
  accent?: string;            // accent color (badges, success indicators)
  bgPrimary?: string;         // main background color
  bgSecondary?: string;       // secondary background (panels, sidebars)
  borderColor?: string;       // border/separator color

  // Background gradient (replaces flat bgPrimary when present)
  bgGradient?: GradientConfig | null;

  // NOTE: Text colors (textPrimary, textSecondary, textMuted) are intentionally
  // excluded. They are ALWAYS auto-computed from background colors to guarantee
  // readable contrast ratios. Users cannot set text colors directly.
}
```

#### Extend `AppSettings`

```ts
export interface AppSettings {
  theme: string;                            // existing — base preset ID
  themeCustomization?: ThemeCustomization;   // NEW — user color overrides
  // ... rest unchanged
}
```

**Backward compatibility**: If `themeCustomization` is `undefined`, the app behaves identically to today. Existing users are unaffected.

---

### 2. Auto-Contrast Text Color Algorithm

This is the core safety mechanism. When background colors change, text colors must be recalculated automatically.

#### WCAG 2.0 Relative Luminance & Contrast Ratio

```ts
/** Parse hex color (#RRGGBB) to RGB. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** WCAG 2.0 relative luminance (0 = black, 1 = white). */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const [rs, gs, bs] = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** Contrast ratio between two colors. Range: 1 (identical) to 21 (black vs white). */
function contrastRatio(c1: string, c2: string): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
```

These are ~20 lines of pure math. No external library needed.

#### Text Color Derivation Strategy

Given a background color, the algorithm produces three text tiers:

| CSS Variable | Requirement | Derivation |
|---|---|---|
| `--text-primary` | WCAG AA: ≥ 4.5:1 contrast against `--bg-primary` | White (`#e5e5e5`) for dark BG, near-black (`#1a1a1a`) for light BG; verified against threshold |
| `--text-secondary` | ≥ 3.5:1 contrast | Slightly muted version of primary text |
| `--text-muted` | ≥ 3:1 (WCAG AA large text) | Furthest from primary text while still readable |

```ts
function computeTextColors(bgPrimary: string): {
  textPrimary: string; textSecondary: string; textMuted: string;
} {
  const lum = relativeLuminance(bgPrimary);
  const isDark = lum <= 0.179;

  if (isDark) {
    // Dark background → light text
    let textPrimary = '#e5e5e5';
    if (contrastRatio(bgPrimary, textPrimary) < 4.5) textPrimary = '#ffffff';
    return { textPrimary, textSecondary: '#a3a3a3', textMuted: '#737373' };
  } else {
    // Light background → dark text
    let textPrimary = '#1a202c';
    if (contrastRatio(bgPrimary, textPrimary) < 4.5) textPrimary = '#000000';
    return { textPrimary, textSecondary: '#4a5568', textMuted: '#718096' };
  }
}
```

#### Deriving Background Tiers from a Single Color

When the user sets only `bgPrimary`, secondary/tertiary/hover colors are computed automatically:

```ts
function deriveBgTiers(bgPrimary: string, mode: ThemeMode) {
  const { r, g, b } = hexToRgb(bgPrimary);
  const step = mode === 'dark' ? 10 : -8; // lighten for dark, darken for light

  const shift = (r: number, g: number, b: number, amount: number) => {
    const clamp = (v: number) => Math.max(0, Math.min(255, v + amount));
    return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  };

  return {
    bgPrimary,
    bgSecondary: shift(r, g, b, step),
    bgTertiary: shift(r, g, b, step * 2),
    bgHover: shift(r, g, b, step * 3),
  };
}
```

#### Auto-Detection of Light vs Dark Mode

```ts
function detectMode(bgPrimary: string): ThemeMode {
  return relativeLuminance(bgPrimary) > 0.179 ? 'light' : 'dark';
}
```

This determines which Angular Material palette class to apply (`.castle-light` vs dark group).

---

### 3. Background Gradient Implementation

#### CSS Changes (`src/styles/styles.scss`)

```scss
body {
  background-color: var(--bg-primary);         // existing fallback
  background-image: var(--bg-gradient, none);  // NEW gradient layer
  background-attachment: fixed;                // prevent gradient scrolling
  min-height: 100vh;
}
```

#### Theme Service Gradient Application

```ts
private applyGradient(root: HTMLElement, gradient: GradientConfig | null | undefined): void {
  if (gradient && gradient.stops.length >= 2) {
    const stops = gradient.stops
      .map(s => `${s.color} ${s.position}%`)
      .join(', ');
    root.style.setProperty('--bg-gradient', `linear-gradient(${gradient.angle}deg, ${stops})`);
  } else {
    root.style.setProperty('--bg-gradient', 'none');
  }
}
```

#### Gradient + Text Contrast

When a gradient is active, text must be readable against **every** gradient stop, not just `bgPrimary`:

```ts
function validateGradientContrast(gradient: GradientConfig, textColor: string): boolean {
  return gradient.stops.every(stop =>
    contrastRatio(stop.color, textColor) >= 4.5
  );
}
```

If any stop fails, the algorithm adjusts text color to the extreme (pure white or pure black) and re-validates. If the gradient spans both very light and very dark, a warning should be displayed in the UI suggesting the user narrow the gradient color range.

---

### 4. Theme Service Changes (`src/app/core/services/theme.service.ts`)

#### Updated `applyTheme()` Flow

```
1. Look up base preset from availableThemes[] using theme ID
2. If ThemeCustomization exists, overlay sparse overrides onto preset values
3. Auto-derive:
   a. bgSecondary/bgTertiary/bgHover from bgPrimary (if only primary BG changed)
   b. textPrimary/textSecondary/textMuted from background colors (contrast algorithm)
   c. borderColor from bgPrimary (slightly shifted)
   d. userBubble from primary color
   e. agentBubble from bgTertiary
   f. codeBg from bgPrimary (darker shift)
4. If bgGradient exists → compute CSS gradient string, validate contrast
5. Detect mode (light/dark) from bgPrimary luminance
6. Apply correct Material palette body class
7. Write all CSS custom properties to document.documentElement
```

#### New Public Methods

```ts
/** Apply customization overrides on top of the current preset, with live preview */
applyCustomization(customization: Partial<ThemeCustomization>): void;

/** Reset all customizations, revert to pure base preset */
resetCustomization(): void;

/** Get the current effective (merged) theme with all computed values */
getEffectiveTheme(): CastleTheme;
```

#### New Private Methods

```ts
private computeTextColors(bgPrimary: string): { textPrimary: string; textSecondary: string; textMuted: string };
private deriveBgTiers(bgPrimary: string, mode: ThemeMode): { bgSecondary: string; bgTertiary: string; bgHover: string };
private buildGradientCss(config: GradientConfig): string;
private mergeCustomization(preset: CastleTheme, custom: ThemeCustomization): CastleTheme;
private detectMode(bgPrimary: string): ThemeMode;
```

#### Persistence Changes

Currently `setTheme()` saves `{ theme: themeId }`. Updated flow:

```ts
async applyCustomization(custom: Partial<ThemeCustomization>): Promise<void> {
  const merged = { ...this.currentCustomization(), ...custom };
  this.currentCustomization.set(merged);
  // Recompute and apply theme
  this.applyEffectiveTheme();
  // Persist both preset ID and customization
  await this.electronService.updateSettings({
    theme: merged.basePresetId,
    themeCustomization: merged,
  });
}
```

New signal to track customization state:

```ts
currentCustomization = signal<ThemeCustomization | null>(null);
```

---

### 5. Settings Page UI Changes

#### Layout Design

```
┌──────────────────────────────────────────────┐
│ 🎨 Theme                                     │
│                                              │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         │  ← Existing preset grid
│ │ Dark │ │Light │ │ Mid  │ │AMOLED│         │
│ └──────┘ └──────┘ └──────┘ └──────┘         │
│                                              │
│ ─────── Customize Colors ────────            │
│                                              │
│ Primary Color    [████ #6366f1] [🎨]         │  ← Color picker + hex input
│ Accent Color     [████ #22c55e] [🎨]         │
│ Background       [████ #0a0a0a] [🎨]         │
│ Secondary BG     [████ #111111] [🎨]         │
│ Border Color     [████ #262626] [🎨]         │
│                                              │
│ ☐ Enable background gradient                 │  ← Gradient toggle
│ ┌──────────────────────────────────────────┐ │
│ │ Angle: [────●──────] 135°                │ │  ← Gradient controls
│ │                                          │ │     (shown when enabled)
│ │ Stop 1: [████ #0a0a0a] at [──●───] 0%   │ │
│ │ Stop 2: [████ #1a1a28] at [────●─] 100% │ │
│ │ [+ Add Stop]                             │ │
│ │                                          │ │
│ │ Preview: ████████████████████████████████ │ │  ← Live gradient strip
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │            Live Preview                  │ │  ← Shows text on bg
│ │  Primary text sample                     │ │
│ │  Secondary text sample                   │ │
│ │  Muted text sample                       │ │
│ │  [Primary Button]  [Accent Badge]        │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ [Reset to Preset]                            │  ← Clears customization
└──────────────────────────────────────────────┘
```

#### Color Picker Implementation

Use the native `<input type="color">` (fully supported in Electron/Chromium) paired with a hex text input:

```html
<div class="color-picker-row">
  <span class="color-label">Primary Color</span>
  <div class="color-input-group">
    <div class="color-swatch" [style.background]="customPrimary"></div>
    <input type="color"
           [value]="customPrimary"
           (input)="onColorChange('primary', $event)" />
    <input type="text"
           [value]="customPrimary"
           (change)="onHexInput('primary', $event)"
           maxlength="7"
           class="hex-input" />
  </div>
</div>
```

**No third-party color picker library needed.** The native input provides a full OS color dialog.

#### Debouncing

Color picker `input` events fire continuously while the user drags the color wheel. Apply a 100ms debounce to avoid excessive DOM style writes:

```ts
private colorChangeSubject = new Subject<{ field: string; value: string }>();

constructor() {
  this.colorChangeSubject.pipe(
    debounceTime(100)
  ).subscribe(({ field, value }) => {
    this.themeService.applyCustomization({ [field]: value });
  });
}
```

#### Gradient Editor Component

The gradient editor should be a collapsible section, hidden by default:

- **Angle control**: Range slider (0–360°) with numeric display
- **Color stops**: List of rows, each with `<input type="color">`, position slider (0–100%), and a remove button
- **Add stop button**: Inserts a new stop at the midpoint between the last two stops
- **Minimum 2 stops** enforced (disable remove when at 2)
- **Live preview strip**: A `<div>` with the computed `linear-gradient()` as its background

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/shared/types/settings.types.ts` | Add `GradientStop`, `GradientConfig`, `ThemeCustomization` interfaces; add `themeCustomization?` to `AppSettings` |
| `src/app/core/services/theme.service.ts` | Add color utility functions (`hexToRgb`, `relativeLuminance`, `contrastRatio`, `computeTextColors`, `deriveBgTiers`); add `currentCustomization` signal; add `applyCustomization()`, `resetCustomization()`, `mergeCustomization()`; update `applyTheme()` to merge customizations and auto-compute text colors; update `loadSavedTheme()` to restore customization; add gradient CSS generation |
| `src/app/features/settings/settings-page.component.html` | Add "Customize Colors" section with color picker rows; add gradient toggle and editor; add live preview panel; add reset button |
| `src/app/features/settings/settings-page.component.ts` | Add customization state properties; add color change handlers with debouncing; add gradient editor logic; wire up `ThemeService.applyCustomization()` |
| `src/app/features/settings/settings-page.component.scss` | Styles for color picker rows, gradient editor, preview panel, toggle |
| `src/styles/styles.scss` | Add `background-image: var(--bg-gradient, none)` and `background-attachment: fixed` to `body` |

### Files That Require NO Changes

- **`src/main/services/database.service.ts`** — The generic `key/value` store already handles arbitrary JSON. Adding `themeCustomization` to `AppSettings` works automatically.
- **All 18 component SCSS files** — They already reference CSS variables. Changed variable values propagate with zero code changes.
- **Preload/IPC layer** — `updateSettings(Partial<AppSettings>)` already accepts any partial settings object.
- **`src/app/shared/components/settings-dialog/`** — This dialog handles remote access only, no theme code.

---

## Implementation Phases

### Phase 1: Core Infrastructure (Foundation)

1. Define new interfaces in `settings.types.ts` (`GradientStop`, `GradientConfig`, `ThemeCustomization`).
2. Add `themeCustomization?` to `AppSettings` (backward-compatible).
3. Implement color utility functions in `theme.service.ts` (hex parsing, luminance, contrast ratio, text color derivation, background tier derivation).
4. Update `applyTheme()` to merge customizations over presets and auto-compute text colors.
5. Add `currentCustomization` signal, `applyCustomization()`, and `resetCustomization()` methods.
6. Update `loadSavedTheme()` to restore `themeCustomization` from settings.

### Phase 2: Settings UI — Color Customization

7. Add "Customize Colors" section to the settings page HTML with color picker rows (Primary, Accent, Background, Secondary BG, Border).
8. Implement color change handlers in the component with debounced Subject.
9. Add live preview panel showing sample text at all three tiers on the current background.
10. Add "Reset to Preset" button.
11. Style the new sections in SCSS.

### Phase 3: Gradient Support

12. Add `background-image: var(--bg-gradient, none)` to `body` in global styles.
13. Implement gradient editor UI (angle slider, color stop list, add/remove, preview strip).
14. Add gradient CSS generation in ThemeService.
15. Implement gradient-aware contrast validation (check text against all stops).

### Phase 4: Polish & Edge Cases

16. Update theme card previews to reflect active customizations (show customized swatch colors instead of default preset colors).
17. Handle preset switching — when user selects a new preset, clear the current customization (or prompt to keep compatible overrides).
18. Add contrast warning indicator in the gradient editor when stops produce borderline readability.
19. Test with extreme color combinations (pure white bg, pure black bg, high-chroma accent colors).

---

## Considerations & Edge Cases

### 1. Performance

Color math operations (luminance, contrast) execute in **microseconds** — trivial cost. The main concern is rapid DOM style updates during color picker dragging. The 100ms debounce on the `input` event handles this. CSS gradient rendering is GPU-accelerated and has negligible performance impact.

### 2. Backward Compatibility

- `themeCustomization` is an optional field. If absent (all existing users), the app behaves identically to today.
- The `theme` string ID continues to function as the base preset selector.
- If a user with customizations downgrades to a version without this feature, the unknown `themeCustomization` key is simply ignored by the old code.

### 3. Angular Material Palette Limitation

Material component palettes (light/dark) are set via SCSS `@include mat.all-component-colors(...)` at compile time, gated by body class selectors. Dynamically generating Material palettes at runtime would require a major refactor.

**Recommended approach**: Keep the existing two palette groups (dark: `.castle-dark, .midnight, .amoled` and light: `.castle-light`) and auto-detect which to apply based on `bgPrimary` luminance:

```ts
const bodyClass = detectMode(effectiveBgPrimary) === 'light' ? 'castle-light' : 'castle-dark';
```

This means a user who picks a light background color will automatically get light Material components (light dropdowns, light dialogs, etc.) even if they started from a dark preset.

### 4. Gradient Edge Cases

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Gradient from very dark to very light | Text unreadable at some point | Validate contrast against ALL stops; show warning if any stop fails |
| Gradient on `body` not covering fixed elements | Visual inconsistency | Use `background-attachment: fixed` + `min-height: 100vh` |
| Too many gradient stops | Overly complex/ugly gradient | Cap at 5 stops in the UI |
| Gradient angle causes visual confusion | Distracting background | Preview strip shows exact result before applying |

### 5. No Third-Party Dependencies Required

| Capability | Implementation |
|-----------|----------------|
| Color picker | Native `<input type="color">` (Chromium) |
| Contrast math | ~25 lines of TypeScript (WCAG 2.0 spec) |
| Gradient rendering | CSS `linear-gradient()` |
| Debouncing | RxJS `debounceTime()` (already a dependency) |

### 6. Accessibility

The auto-contrast algorithm enforces **WCAG AA compliance** (4.5:1 for normal text, 3:1 for large text/UI components). This is a strict improvement over the current system where preset colors are hand-picked but never programmatically validated.

### 7. Settings Storage Size

A `ThemeCustomization` object serializes to approximately 200-400 bytes of JSON. The existing SQLite `settings` table stores values as `TEXT` — no size concern.

### 8. Future Extensions

The `ThemeCustomization` model naturally supports:
- **User-created presets**: Save a customization as a new named preset (add `customThemes: ThemeCustomization[]` to settings).
- **Import/export themes**: Serialize a `ThemeCustomization` to JSON for sharing.
- **Radial gradients**: Extend `GradientConfig` with a `type` field (`'linear' | 'radial'`).

These are out of scope for the initial implementation but the architecture accommodates them cleanly.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Color picker UX feels bare | Medium | Low | Native `<input type="color">` provides a full OS dialog; hex input covers power users |
| User creates unreadable theme | Very Low | High | Text colors are never user-editable — always auto-computed via WCAG contrast |
| Gradient with extreme color range | Low | Medium | Contrast validation against all stops; warning in UI |
| Material palette mismatch with custom bg | Medium | Medium | Auto-detect light/dark mode from luminance; apply correct Material class |
| Settings migration for existing users | Very Low | Low | `themeCustomization` is optional; missing = default preset behavior |
| Debounce feels laggy on color drag | Low | Low | 100ms debounce is imperceptible; can reduce to 50ms if needed |

---

## Summary

The implementation requires changes to **6 files** with zero new dependencies. The core work is:

1. **~80 lines** of color utility functions (hex parsing, luminance, contrast, tier derivation).
2. **~60 lines** of ThemeService updates (customization merging, gradient CSS, persistence).
3. **~120 lines** of settings page template (color pickers, gradient editor, preview).
4. **~80 lines** of settings page component logic (handlers, debouncing, state).
5. **~100 lines** of SCSS for the new UI sections.
6. **2 lines** in global styles for gradient support.

The existing CSS variable architecture makes this feature particularly clean to implement — all 18+ component SCSS files automatically reflect customized colors without any changes.
