# Research: Dynamic Theme Adjustment

## Problem Statement

The current settings page offers a simple 4-preset theme picker (Castle Dark, Castle Light, Midnight Blue, AMOLED Black). Users can only select a preset — they cannot customize individual colors. The requested feature transforms this into a richer theming experience:

1. **Keep presets** as starting points (and allow new ones).
2. **Let users adjust** primary/accent, background, and gradient colors after selecting a preset.
3. **Implement background gradients** — allow the background to be a configurable gradient instead of a flat color.
4. **Auto-compute text colors** to ensure readable contrast, preventing problems like black-on-black.

---

## Current Architecture

### Theme Service (`src/app/core/services/theme.service.ts`)

- Maintains a hardcoded `availableThemes: CastleTheme[]` array of 4 presets.
- Current theme is a **signal**: `currentTheme = signal<CastleTheme>(...)`.
- `applyTheme()` writes 15 CSS custom properties on `document.documentElement`:
  - `--theme-primary`, `--theme-accent`, `--theme-warn`
  - `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-hover`
  - `--text-primary`, `--text-secondary`, `--text-muted`
  - `--border-color`, `--user-bubble`, `--agent-bubble`, `--code-bg`
- Theme class added to `<body>` (e.g. `castle-dark`) for Angular Material color palette switching.
- Persists only the `theme` string ID to settings.

### CastleTheme Interface

```ts
export interface CastleTheme {
  id: string;
  name: string;
  mode: ThemeMode;        // 'light' | 'dark'
  primary: string;
  accent: string;
  warn: string;
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

### Settings Persistence

- `AppSettings.theme` is a single string (`'castle-dark'`), stored in SQLite via `key/value` table.
- `DatabaseService.updateSettings()` serializes each key as JSON.
- There is **no field** for custom color overrides or gradient configuration.

### Global Styles (`src/styles/styles.scss`)

- `:root` defines default dark theme CSS variables.
- Body class selectors (`.castle-dark`, `.midnight`, `.amoled`) trigger Material dark palette.
- `.castle-light` overrides CSS variables + includes Material light palette.
- All components reference these CSS variables (e.g. `var(--bg-primary)`, `var(--text-primary)`).

### Settings Page (`src/app/features/settings/settings-page.component.*`)

- Simple grid of 4 theme cards, each with a preview swatch.
- `setTheme(themeId)` calls `ThemeService.setTheme()`.
- No custom color inputs exist.

---

## Proposed Approach

### Data Model Changes

#### 1. New `ThemeCustomization` Interface

```ts
/** User's custom color overrides on top of a preset */
export interface ThemeCustomization {
  /** Base preset ID the customization is derived from */
  basePresetId: string;

  /** Primary brand color (buttons, links, selection) */
  primary?: string;
  /** Accent color (badges, success indicators) */
  accent?: string;

  /** Background colors */
  bgPrimary?: string;
  bgSecondary?: string;

  /** Background gradient (replaces flat bgPrimary when set) */
  bgGradient?: GradientConfig | null;

  /** Border color override */
  borderColor?: string;

  // Text colors are NOT user-editable — they are auto-computed.
}

export interface GradientConfig {
  /** CSS angle in degrees (e.g. 135 for top-left → bottom-right) */
  angle: number;
  /** Ordered color stops */
  stops: GradientStop[];
}

export interface GradientStop {
  color: string;
  /** Position as percentage 0-100 */
  position: number;
}
```

Only the colors that differ from the base preset are stored (sparse overrides). Text colors are **always** derived automatically from backgrounds.

#### 2. Extend `AppSettings`

```ts
export interface AppSettings {
  theme: string;                           // existing — base preset ID
  themeCustomization?: ThemeCustomization;  // new — user overrides
  // ... rest unchanged
}
```

Backward-compatible: if `themeCustomization` is undefined, the app behaves exactly as today.

#### 3. Extend `CastleTheme` with Gradient Support

```ts
export interface CastleTheme {
  // ... existing fields
  bgGradient?: string;  // computed CSS gradient string applied to body
}
```

---

### Auto-Contrast Text Color Algorithm

This is the core safety mechanism. When a user changes background colors, text colors are recalculated to guarantee readability.

#### Algorithm: WCAG Relative Luminance + Contrast Ratio

```ts
/**
 * Parse hex color to RGB components.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * Compute WCAG 2.0 relative luminance.
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const [rs, gs, bs] = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * WCAG contrast ratio between two colors.
 * Returns value between 1 (identical) and 21 (black/white).
 */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Given a background color, pick a text color that meets WCAG AA (4.5:1).
 * Tries the base theme's preferred text, then falls back to white or black.
 */
function autoTextColor(bgHex: string, preferredText: string): string {
  if (contrastRatio(bgHex, preferredText) >= 4.5) return preferredText;
  // Determine if background is light or dark
  const lum = relativeLuminance(bgHex);
  return lum > 0.179 ? '#1a1a1a' : '#e5e5e5';
}
```

**Three-tier text colors derived from background:**

| Variable | Derivation |
|----------|-----------|
| `--text-primary` | Must pass WCAG AA (4.5:1) against `--bg-primary` |
| `--text-secondary` | Same base as primary but with reduced opacity or lighter shade, still ≥ 3:1 |
| `--text-muted` | Minimum 3:1 against `--bg-primary` (WCAG AA for large text) |

**Derived background tiers** (when user only picks one background color):

```ts
function deriveBgTiers(bgPrimary: string, mode: 'light' | 'dark') {
  const { r, g, b } = hexToRgb(bgPrimary);
  const shift = mode === 'dark' ? 1 : -1; // lighten for dark, darken for light
  const step = 10; // per-tier shift amount

  return {
    bgPrimary,
    bgSecondary: shiftColor(r, g, b, step * shift),
    bgTertiary:  shiftColor(r, g, b, step * 2 * shift),
    bgHover:     shiftColor(r, g, b, step * 3 * shift),
  };
}
```

This means the user picks **one or two background colors**, and the entire set of bg/text/border variables is computed automatically.

---

### Background Gradient Implementation

#### CSS Application

The body background currently uses `background-color: var(--bg-primary)`. For gradient support:

```scss
body {
  background-color: var(--bg-primary);           // fallback
  background-image: var(--bg-gradient, none);    // gradient layer
}
```

The theme service sets `--bg-gradient` when a gradient is configured:

```ts
if (gradient) {
  const stops = gradient.stops
    .map(s => `${s.color} ${s.position}%`)
    .join(', ');
  const css = `linear-gradient(${gradient.angle}deg, ${stops})`;
  root.style.setProperty('--bg-gradient', css);
} else {
  root.style.setProperty('--bg-gradient', 'none');
}
```

#### Gradient Editor UI

A simple gradient editor in the settings page:

- **Angle slider** (0–360°) with a circular preview indicator
- **Color stop list** — each stop has a color picker and a position slider (0–100%)
- **Add/remove stop buttons** (min 2 stops)
- **Live preview strip** showing the rendered gradient

The gradient editor should be collapsed/hidden by default and revealed via an "Enable gradient" toggle.

#### Text Contrast with Gradients

When a gradient is active, text contrast must be computed against the **darkest stop** (for dark themes) or **lightest stop** (for light themes), whichever produces the worst-case scenario:

```ts
function worstCaseBgForContrast(gradient: GradientConfig, textColor: string): boolean {
  // Ensure text is readable against ALL gradient stops
  return gradient.stops.every(stop =>
    contrastRatio(stop.color, textColor) >= 4.5
  );
}
```

If any stop fails, the text color is adjusted until all stops pass.

---

### Settings Page UI Changes

#### Layout (3 sections within the Theme area)

```
┌─────────────────────────────────────────┐
│ 🎨 Theme                                │
│                                         │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │  ← Preset grid (existing)
│ │ Dark │ │Light │ │ Mid  │ │AMOLED│    │
│ └──────┘ └──────┘ └──────┘ └──────┘    │
│                                         │
│ ─────── Customize ───────               │
│                                         │
│ Primary Color   [████ #6366f1] [picker] │  ← Color picker inputs
│ Accent Color    [████ #22c55e] [picker] │
│ Background      [████ #0a0a0a] [picker] │
│ Border Color    [████ #262626] [picker] │
│                                         │
│ ☐ Enable background gradient            │  ← Gradient toggle
│   (gradient editor, when enabled)       │
│                                         │
│ [ Reset to Preset ]                     │  ← Reset button
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │         Live Preview                │ │  ← Mini preview panel
│ │  Sample text on sample background   │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### Color Picker Component

Use a native `<input type="color">` styled with a hex text input alongside it:

```html
<div class="color-picker-row">
  <label>Primary Color</label>
  <div class="color-input-group">
    <input type="color" [value]="customPrimary"
           (input)="onColorChange('primary', $event)" />
    <input type="text" [value]="customPrimary"
           (change)="onHexInput('primary', $event)"
           pattern="^#[0-9a-fA-F]{6}$" />
  </div>
</div>
```

`<input type="color">` is supported in Electron/Chromium and provides a full OS-native color picker. No third-party library needed.

---

### Theme Service Changes

#### Updated `applyTheme()` Flow

```
1. Start with base preset (CastleTheme from availableThemes[])
2. Overlay user customizations (ThemeCustomization sparse overrides)
3. Auto-derive:
   a. bgSecondary, bgTertiary, bgHover from bgPrimary (if only primary changed)
   b. textPrimary, textSecondary, textMuted from backgrounds (contrast algorithm)
   c. borderColor from bgPrimary (shifted)
   d. userBubble from primary
   e. agentBubble from bgTertiary
   f. codeBg from bgPrimary (darker shift)
4. Compute gradient CSS string (if gradient configured)
5. Determine theme mode → apply Material palette class (dark vs light)
6. Write all CSS custom properties to document root
7. Persist to settings
```

#### New Methods

```ts
/** Apply a customization on top of the current preset */
applyCustomization(customization: Partial<ThemeCustomization>): void;

/** Reset customization, revert to base preset */
resetCustomization(): void;

/** Compute readable text colors for a given background */
private computeTextColors(bg: string, mode: ThemeMode): {
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
};

/** Derive secondary/tertiary/hover backgrounds from a primary bg */
private deriveBgTiers(bgPrimary: string, mode: ThemeMode): {
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
};

/** Build CSS gradient string from config */
private buildGradientCss(config: GradientConfig): string;
```

---

### Files to Modify

| File | Change |
|------|--------|
| `src/shared/types/settings.types.ts` | Add `ThemeCustomization`, `GradientConfig`, `GradientStop` interfaces; add `themeCustomization?` to `AppSettings` |
| `src/app/core/services/theme.service.ts` | Add contrast utilities, `deriveBgTiers()`, `computeTextColors()`, `buildGradientCss()`, `applyCustomization()`, `resetCustomization()`; update `applyTheme()` to merge customizations; update `loadSavedTheme()` to restore customizations |
| `src/app/features/settings/settings-page.component.html` | Add "Customize" section with color picker rows, gradient toggle + editor, reset button, live preview |
| `src/app/features/settings/settings-page.component.ts` | Add state for color pickers and gradient editor; wire up `ThemeService.applyCustomization()`; debounced color change handler |
| `src/app/features/settings/settings-page.component.scss` | Styles for color picker rows, gradient editor, preview panel |
| `src/styles/styles.scss` | Add `--bg-gradient` variable to `body`; ensure gradient fallback |

### Files Unchanged

- `src/main/services/database.service.ts` — No schema changes needed. The `themeCustomization` object is serialized to JSON via the existing generic `key/value` settings store.
- All component SCSS files — They already use CSS custom properties and will automatically respond to the new values.
- Preload/IPC layer — Settings API already handles `Partial<AppSettings>` generically.

---

## Implementation Steps

### Phase 1: Core Infrastructure

1. **Define types** in `settings.types.ts`:
   - `GradientStop`, `GradientConfig`, `ThemeCustomization`
   - Add `themeCustomization?: ThemeCustomization` to `AppSettings`

2. **Add color utility functions** in `theme.service.ts`:
   - `hexToRgb()`, `relativeLuminance()`, `contrastRatio()`
   - `autoTextColor()`, `computeTextColors()`, `deriveBgTiers()`
   - `buildGradientCss()`

3. **Update `applyTheme()`** to:
   - Accept an optional `ThemeCustomization` parameter
   - Merge customization over preset values
   - Auto-compute text colors from final backgrounds
   - Set `--bg-gradient` CSS variable

4. **Add persistence**:
   - `applyCustomization()` saves `themeCustomization` to settings
   - `loadSavedTheme()` restores both preset ID and customization

### Phase 2: Settings UI

5. **Add "Customize" section** below the preset grid:
   - Color picker rows for: Primary, Accent, Background, Border
   - Each row: `<input type="color">` + hex text input + color swatch preview
   - Changes are applied live (debounced ~100ms) via `ThemeService.applyCustomization()`

6. **Add gradient editor** (initially hidden):
   - Toggle: "Enable background gradient"
   - When enabled: angle slider, 2+ color stops with pickers and position sliders
   - Add/remove stop buttons
   - Live gradient preview strip

7. **Add "Reset to Preset" button** that calls `ThemeService.resetCustomization()`

8. **Add live preview panel** showing sample text (primary, secondary, muted) on the current background/gradient with current primary/accent colors

### Phase 3: Polish

9. **Update theme card previews** to reflect customizations — if the user customized "Castle Dark", the card preview should show the customized colors, not the default preset colors.

10. **Gradient-aware contrast** — ensure text is readable against all gradient stops.

11. **Preset switching with customizations** — when switching presets, clear customization (or ask to preserve overrides that are compatible).

---

## Considerations

### 1. Performance

Color utility math (luminance, contrast) is trivial — microseconds per call. Debounce color picker inputs at 100ms to avoid excessive DOM style writes during continuous dragging.

### 2. Backward Compatibility

- If `themeCustomization` is absent in settings, the app falls back to the pure preset behavior — zero change for existing users.
- The `theme` string field continues to work as the base preset selector.

### 3. No Third-Party Dependencies

- `<input type="color">` provides a full color picker in Chromium/Electron.
- WCAG luminance math is ~20 lines of code — no library needed.
- CSS `linear-gradient()` handles all gradient rendering.

### 4. Angular Material Palette Limitation

The Material palette (light vs dark) is determined at compile time by the SCSS `@include mat.all-component-colors(...)`. Dynamically switching between light and dark Material palettes based on user-chosen background luminance would require:

- **Option A**: Keep the existing two classes (`.castle-light` and dark-group) and toggle based on `mode` determined by background luminance — this is what the app already does and is sufficient.
- **Option B**: Use Angular Material's newer theme API to apply palettes at runtime — significant refactor, not recommended for this feature.

**Recommendation**: Stick with Option A. Auto-detect `mode` from `bgPrimary` luminance:

```ts
const mode: ThemeMode = relativeLuminance(bgPrimary) > 0.179 ? 'light' : 'dark';
```

### 5. Gradient Edge Cases

- If a gradient goes from very dark to very light, text will be unreadable at some point. Mitigation: validate that ALL gradient stop colors pass contrast check, and warn the user (or reject) if any stop fails.
- Gradient on `body` may not cover fixed/absolute positioned elements — use `min-height: 100vh` and `background-attachment: fixed`.

### 6. Cross-Device Sync

The existing `SYNC_TASKS_CHANGED` pattern doesn't apply to settings. Currently settings are per-device. If settings sync is added later, the `themeCustomization` object serializes cleanly as JSON and would transfer without issue.

### 7. Accessibility

The auto-contrast algorithm enforces WCAG AA compliance (4.5:1 for normal text, 3:1 for large text). This is a **strict improvement** over the current system where preset colors are hand-picked but not validated.

### 8. Future Extension: User-Created Presets

The architecture naturally supports saving custom presets: a customized theme can be "saved as" a new entry in a `custom_themes` table. This is out of scope but the `ThemeCustomization` model is designed to make it trivial later.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Color picker UX feels clunky | Medium | Low | Native `<input type="color">` is well-supported; add hex input for precision |
| User creates unreadable theme | Low | High | Auto-contrast algorithm prevents this; text colors are never user-editable |
| Gradient performance on low-end devices | Low | Low | CSS gradients are GPU-accelerated; negligible cost |
| Material palette mismatch with custom bg | Medium | Medium | Auto-detect light/dark mode from luminance; apply correct Material class |
| Settings migration for existing users | Low | Low | `themeCustomization` is optional; missing = default preset behavior |
