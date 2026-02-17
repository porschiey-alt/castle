# Research: All Default Themes Should Use a Gradient

## Problem Statement

Currently, background gradients are only available as a user customization option via the settings page. Default themes ship with flat solid backgrounds. The goal is to give every default theme a built-in subtle gradient that enhances visual depth out of the box, following the pattern of the user's custom green theme example:

> **Reference gradient (green theme):**
> Start: `#111111` → End: `#001404` · Diagonal to bottom right · Accent: Green · Secondary Accent: Light Green

The key characteristic is that the gradient end color is a **very dark, barely perceptible tint** of the theme's primary/accent hue blended into the base background color.

---

## Current Architecture

### Theme Definition (`CastleTheme` interface)

Located in `src/app/core/services/theme.service.ts` (lines 19–36):

```typescript
export interface CastleTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  primary: string;
  accent: string;
  secondaryAccent: string;
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

**No gradient fields exist on the interface.** Gradients are only in `ThemeCustomization`.

### Existing Gradient System

Gradients are currently a **user-customization-only** feature controlled by `ThemeCustomization`:

```typescript
// src/shared/types/settings.types.ts
export interface ThemeCustomization {
  bgPrimary?: string;
  bgSecondary?: string;
  accentColor?: string;
  secondaryAccentColor?: string;
  gradientEnabled?: boolean;
  gradientEndColor?: string;
  gradientDirection?: string;
}
```

Applied in `theme.service.ts` (lines 215–225):

```typescript
if (custom.gradientEnabled && custom.gradientEndColor) {
  const dir = custom.gradientDirection || 'to bottom';
  root.style.setProperty('--bg-gradient', `linear-gradient(${dir}, ${bgPrimary}, ${custom.gradientEndColor})`);
  body.style.setProperty('background', `var(--bg-gradient)`);
  body.classList.add('gradient-active');
} else {
  root.style.removeProperty('--bg-gradient');
  body.style.removeProperty('background');
  body.classList.remove('gradient-active');
}
```

The CSS infrastructure already supports gradients:

- `body` uses `background: var(--bg-gradient, var(--bg-primary))` — falls back to solid if no gradient set
- `.gradient-active` class makes panels transparent so the gradient shows through
- `.app-container` in `main-layout.component.scss` also references `--bg-gradient`

### Current Default Themes

| Theme | ID | Mode | Primary | Accent | bgPrimary |
|---|---|---|---|---|---|
| Castle Dark | `castle-dark` | dark | `#6366f1` (Indigo) | `#22c55e` (Green) | `#0a0a0a` |
| Castle Light | `castle-light` | light | `#6366F1` (Indigo) | `#14B8A6` (Teal) | `#ffffff` (derived) |
| Midnight Blue | `midnight` | dark | `#3b82f6` (Blue) | `#22c55e` (Green) | `#0c0c14` |
| AMOLED Black | `amoled` | dark | `#ffffff` (White) | `#22c55e` (Green) | `#000000` |

---

## Proposed Approach

### Option A: Add Gradient Fields to `CastleTheme` Interface (Recommended)

Add three new optional fields to `CastleTheme`:

```typescript
export interface CastleTheme {
  // ... existing fields ...
  gradientEndColor?: string;
  gradientDirection?: string;
}
```

Then update `applyTheme()` to use the theme's built-in gradient as a **default** that user customization can override:

```typescript
// Determine gradient settings (user custom > theme default)
const gradientEnabled = custom.gradientEnabled !== undefined
  ? custom.gradientEnabled
  : !!theme.gradientEndColor;  // enabled by default if theme defines one
const gradientEndColor = custom.gradientEndColor || theme.gradientEndColor;
const gradientDirection = custom.gradientDirection || theme.gradientDirection || 'to bottom right';

if (gradientEnabled && gradientEndColor) {
  root.style.setProperty('--bg-gradient', `linear-gradient(${gradientDirection}, ${bgPrimary}, ${gradientEndColor})`);
  body.style.setProperty('background', `var(--bg-gradient)`);
  body.classList.add('gradient-active');
} else {
  root.style.removeProperty('--bg-gradient');
  body.style.removeProperty('background');
  body.classList.remove('gradient-active');
}
```

**Key behavior:** The theme's gradient is on by default but the user can toggle it off via the existing gradient toggle in settings, or override the end color/direction.

### Option B: Bake Gradients into `ThemeCustomization` Defaults (Not Recommended)

Pre-populate `ThemeCustomization` defaults per theme. This muddies the separation between "built-in theme" and "user customization" and would be lost when users reset customization.

---

## Proposed Gradient Designs

The design principle follows the reference example: the gradient end color is the **bgPrimary darkened and very subtly tinted** toward the theme's primary hue. The gradient should be barely noticeable — adding depth without distraction.

### Castle Dark (`castle-dark`)

- **Start:** `#0a0a0a` (existing bgPrimary)
- **End:** `#0a0a14` (very subtle indigo tint — nudges the blue channel by ~10)
- **Direction:** `to bottom right`
- **Rationale:** Primary is `#6366f1` (indigo). A faint indigo wash in the bottom-right corner creates subtle depth while complementing the indigo accent.

### Castle Light (`castle-light`)

- **Start:** `#ffffff` (white)
- **End:** `#f0f0ff` (very subtle indigo/lavender tint)
- **Direction:** `to bottom right`
- **Rationale:** Primary is `#6366F1` (indigo). A gentle lavender fade adds warmth without compromising readability on light backgrounds.

### Midnight Blue (`midnight`)

- **Start:** `#0c0c14` (existing bgPrimary — already has blue tint)
- **End:** `#08081e` (deeper blue push)
- **Direction:** `to bottom right`
- **Rationale:** This theme already commits to a blue tone. Deepening the blue in the corner reinforces the "midnight" identity.

### AMOLED Black (`amoled`)

- **Start:** `#000000` (pure black)
- **End:** `#000a00` (extremely subtle green tint, almost imperceptible)
- **Direction:** `to bottom right`
- **Rationale:** AMOLED themes prioritize true black for power savings. The gradient must be nearly invisible. A tiny green whisper (matching the green accent `#22c55e`) gives it personality without compromising AMOLED black pixel behavior. **Alternative:** skip gradient entirely for this theme if pixel-purity is paramount — set no `gradientEndColor` so it defaults to off.

---

## Implementation Plan

### 1. Extend `CastleTheme` Interface

**File:** `src/app/core/services/theme.service.ts`

Add two optional fields:

```typescript
export interface CastleTheme {
  // ... existing fields ...
  gradientEndColor?: string;
  gradientDirection?: string;
}
```

### 2. Add Gradient Values to Each Default Theme

**File:** `src/app/core/services/theme.service.ts`

Add `gradientEndColor` and `gradientDirection` to each theme object in `availableThemes`:

```typescript
{
  id: 'castle-dark',
  // ... existing ...
  gradientEndColor: '#0a0a14',
  gradientDirection: 'to bottom right',
},
{
  id: 'castle-light',
  // ... existing ...
  gradientEndColor: '#f0f0ff',
  gradientDirection: 'to bottom right',
},
{
  id: 'midnight',
  // ... existing ...
  gradientEndColor: '#08081e',
  gradientDirection: 'to bottom right',
},
{
  id: 'amoled',
  // ... existing ...
  gradientEndColor: '#000a00',
  gradientDirection: 'to bottom right',
},
```

### 3. Update `applyTheme()` Gradient Logic

**File:** `src/app/core/services/theme.service.ts`

Replace the current gradient block (lines 215–225) with logic that merges theme defaults with user overrides:

```typescript
// Gradient support: theme defaults can be overridden by user customization
const gradientEnabled = custom.gradientEnabled !== undefined
  ? custom.gradientEnabled
  : !!theme.gradientEndColor;
const gradientEndColor = custom.gradientEndColor || theme.gradientEndColor;
const gradientDir = custom.gradientDirection || theme.gradientDirection || 'to bottom right';

if (gradientEnabled && gradientEndColor) {
  root.style.setProperty('--bg-gradient', `linear-gradient(${gradientDir}, ${bgPrimary}, ${gradientEndColor})`);
  body.style.setProperty('background', `var(--bg-gradient)`);
  body.classList.add('gradient-active');
} else {
  root.style.removeProperty('--bg-gradient');
  body.style.removeProperty('background');
  body.classList.remove('gradient-active');
}
```

### 4. Update Settings Page Initial State

**File:** `src/app/pages/settings-page/settings-page.component.ts` (or equivalent)

When loading the current theme, pre-populate the gradient toggle and controls with the theme's default values so the user sees that gradients are enabled and can toggle them off or adjust:

```typescript
// When initializing gradient controls:
this.gradientEnabled = customization.gradientEnabled !== undefined
  ? customization.gradientEnabled
  : !!currentTheme.gradientEndColor;
this.gradientEndColor = customization.gradientEndColor || currentTheme.gradientEndColor || '#000000';
this.gradientDirection = customization.gradientDirection || currentTheme.gradientDirection || 'to bottom right';
```

### 5. Handle Theme Switching

The existing `setTheme()` already resets customization to `{}` on theme switch (line 151). With the new logic, this means the new theme's built-in gradient will automatically apply since `custom.gradientEnabled` will be `undefined` (falling back to `!!theme.gradientEndColor`).

**No changes needed** for theme switching — the merge logic handles it.

---

## Considerations

### User Override Precedence

The merge strategy must be:
1. If `custom.gradientEnabled === false` → no gradient (user explicitly turned it off)
2. If `custom.gradientEnabled === true` → use `custom.gradientEndColor` (user explicitly set one)
3. If `custom.gradientEnabled === undefined` → fall back to theme defaults

This means `gradientEnabled: false` must be explicitly persisted when the user toggles the gradient off, rather than relying on the absence of the field. Currently, `onCustomizationChange()` always sets `gradientEnabled: this.gradientEnabled`, so this is already handled.

### AMOLED Theme Special Consideration

True AMOLED displays save power with `#000000` pixels. Even a subtle gradient introduces non-black pixels. Options:
- **Include gradient** with extremely subtle end color (`#000a00`) — most of the screen stays #000000
- **Exclude gradient** by not setting `gradientEndColor` on the AMOLED theme — users can still enable one manually
- **Recommendation:** Include it but make it extremely subtle. Users who care about pixel-purity can toggle it off.

### Light Theme Gradient

Light themes need the gradient to go from lighter to slightly tinted, not darker. The proposed `#ffffff` → `#f0f0ff` is appropriate. Ensure text contrast (already dark text on light bg) isn't affected — the tint is so subtle it won't impact WCAG compliance.

### Performance

CSS `linear-gradient` with two stops is negligible in performance cost. The `gradient-active` class that makes panels transparent is already implemented and tested. No performance concerns.

### Backward Compatibility

- Users with **no saved customization** will see the new gradients (this is the intended behavior — improved defaults)
- Users with **existing customization** (`gradientEnabled: true/false`) will retain their settings since `custom.gradientEnabled !== undefined` takes precedence
- Users who had `gradientEnabled: false` explicitly saved won't be affected
- **Edge case:** Users who never touched gradient settings have `themeCustomization: {}` stored, which means `gradientEnabled` is `undefined`, so they'll get the new theme defaults. This is desired.

### Files Changed Summary

| File | Change |
|---|---|
| `src/app/core/services/theme.service.ts` | Add `gradientEndColor`/`gradientDirection` to interface + theme objects; update `applyTheme()` merge logic |
| `src/app/pages/settings-page/settings-page.component.ts` | Pre-populate gradient controls from theme defaults |

**No changes needed to:**
- `settings.types.ts` (ThemeCustomization already has gradient fields)
- `styles.scss` (gradient-active class already exists)
- `main-layout.component.scss` (already references `--bg-gradient`)

---

## Gradient Color Reference Table

| Theme | Start (bgPrimary) | End (gradientEndColor) | Direction | Tint Source | Hex Diff |
|---|---|---|---|---|---|
| Castle Dark | `#0a0a0a` | `#0a0a14` | to bottom right | Primary (Indigo `#6366f1`) | B+10 |
| Castle Light | `#ffffff` | `#f0f0ff` | to bottom right | Primary (Indigo `#6366F1`) | R-15, G-15 |
| Midnight Blue | `#0c0c14` | `#08081e` | to bottom right | Primary (Blue `#3b82f6`) | R-4, G-4, B+10 |
| AMOLED Black | `#000000` | `#000a00` | to bottom right | Accent (Green `#22c55e`) | G+10 |

All end colors were chosen to be **barely perceptible** — the delta from the start color is ≤15 in any single RGB channel.
