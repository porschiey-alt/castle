# Accent Color on Text Contrast Helper

## Diagnosis and Suggested Fix

### Symptoms

When a user customizes the **accent color** or **secondary accent color** to a light value
(e.g., light green `#90EE90`, yellow `#FFFF00`, white `#FFFFFF`), text rendered on top of
those colors becomes unreadable because the text color is hardcoded to `white`.

Affected surfaces:

| Surface | File | Line(s) | Current Value |
|---------|------|---------|---------------|
| Primary filled buttons (`.mat-mdc-unelevated-button.mat-primary`) | `src/styles/styles.scss` | 140, 276 | `--mdc-filled-button-label-text-color: white` |
| Warn filled buttons | `src/styles/styles.scss` | 145, 281 | `--mdc-filled-button-label-text-color: white` |
| Primary raised buttons (`.mat-mdc-raised-button.mat-primary`) | `src/styles/styles.scss` | 151, 287 | `--mdc-protected-button-label-text-color: white` |
| User chat bubbles | `src/app/features/chat/message-bubble/message-bubble.component.scss` | 16 | `color: white` |
| Settings preview accent pills | `src/app/features/settings/settings-page.component.scss` | 256 | `color: white` |
| Settings preview accent pills (HTML) | `src/app/features/settings/settings-page.component.html` | 175–176 | No dynamic `[style.color]` binding |

The app **already** solves this exact problem for text against the page background — in
`theme.service.ts` line 190, it calls `getContrastingTextColor(bgPrimary)` and sets
`--text-primary`. But it never calls the same function for the accent color surfaces.

### Root Cause Analysis

In `src/app/core/services/theme.service.ts`, the `applyTheme()` method (line 166)
computes auto-derived text colors only for the **page background** (`bgPrimary`):

```typescript
// Line 190 — ✅ works for page background
const textPrimary = getContrastingTextColor(bgPrimary);
```

It sets `--theme-primary` and `--theme-secondary-accent` as CSS custom properties
(lines 181–183), but **never computes or sets a corresponding contrast text color** for
those accent values. No `--theme-primary-contrast` or `--theme-secondary-accent-contrast`
variable exists.

Meanwhile, in `styles.scss`, every button override hardcodes label text to `white`:

```scss
// Dark theme — lines 138–141
.mat-mdc-unelevated-button.mat-primary {
  --mdc-filled-button-container-color: var(--theme-primary);
  --mdc-filled-button-label-text-color: white;  // ← hardcoded
}
```

The same pattern repeats for raised buttons, warn buttons, and in the light theme block.
The user chat bubble in `message-bubble.component.scss` also hardcodes `color: white`.

**Root cause**: The contrast-aware text color derivation that exists for page backgrounds
is not applied to accent-colored surfaces (buttons, bubbles, preview pills).

### Suggested Fix

The fix has three parts:

#### 1. Compute and set contrast CSS variables in `theme.service.ts`

In the `applyTheme()` method, after determining the effective accent colors, compute
their contrasting text colors and set new CSS custom properties:

```typescript
// In applyTheme(), after line 183:
import { getContrastingTextColor } from '../../shared/utils/color.utils';

const accent = custom.accentColor || theme.primary;
const secondaryAccent = custom.secondaryAccentColor || theme.secondaryAccent;

// NEW: derive contrast text colors for accent surfaces
root.style.setProperty('--theme-primary-contrast', getContrastingTextColor(accent));
root.style.setProperty('--theme-secondary-accent-contrast', getContrastingTextColor(secondaryAccent));
root.style.setProperty('--theme-warn-contrast', getContrastingTextColor(theme.warn));
```

#### 2. Replace hardcoded `white` with CSS variables in `styles.scss`

```scss
// Dark theme block — replace all 3 occurrences:
.mat-mdc-unelevated-button.mat-primary {
  --mdc-filled-button-container-color: var(--theme-primary);
  --mdc-filled-button-label-text-color: var(--theme-primary-contrast, white);
}

.mat-mdc-unelevated-button.mat-warn {
  --mdc-filled-button-container-color: var(--theme-warn);
  --mdc-filled-button-label-text-color: var(--theme-warn-contrast, white);
}

.mat-mdc-raised-button.mat-primary {
  --mdc-protected-button-container-color: var(--theme-primary);
  --mdc-protected-button-label-text-color: var(--theme-primary-contrast, white);
}

// Light theme block — same changes (lines 273–287)
```

Also update the `:root` defaults:

```scss
:root {
  --theme-primary-contrast: white;
  --theme-secondary-accent-contrast: white;
  --theme-warn-contrast: white;
}
```

#### 3. Fix user chat bubble and settings preview

**`message-bubble.component.scss`** — line 16:
```scss
&.user .message-content .message-body {
  background-color: var(--user-bubble);
  color: var(--theme-primary-contrast, white);
}
```

**`settings-page.component.html`** — lines 175–176, add `[style.color]` bindings:
```html
<span class="preview-accent"
      [style.background]="customSecondaryAccentColor"
      [style.color]="getContrastingText(customSecondaryAccentColor)">Secondary</span>
<span class="preview-accent"
      [style.background]="customAccentColor"
      [style.color]="getContrastingText(customAccentColor)">Accent</span>
```

**`settings-page.component.ts`** — add a helper method:
```typescript
getContrastingText(hex: string): string {
  return getContrastingTextColor(hex || '#000000');
}
```

**`settings-page.component.scss`** — remove the hardcoded `color: white` from
`.preview-accent` (line 256), since it will be set dynamically via the inline style.

### Verification Steps

1. **Light accent color test**: Set accent color to `#90EE90` (light green). Confirm
   that all primary buttons now display dark text (`#1a1a1a`) instead of white.

2. **Dark accent color test**: Set accent color to `#1a1a8a` (dark blue). Confirm that
   button text remains light (`#e5e5e5`).

3. **Secondary accent test**: Set secondary accent to `#FFFF00` (yellow). Confirm that
   tab indicators and preview pills show dark text.

4. **Chat bubble test**: Send a user message with a light accent color. Confirm the
   message text inside the user bubble is readable (dark on light).

5. **Settings preview test**: Open Settings → Customize Colors. Change the accent
   picker to various light/dark values. Confirm the preview pills ("Accent" /
   "Secondary") dynamically switch between dark and light text.

6. **Default theme regression test**: Switch between all four preset themes (Castle Dark,
   Castle Light, Midnight, AMOLED) without any customization. Confirm no visual
   regressions — buttons and bubbles should look identical to before (all presets use
   dark accent colors, so text should remain light/white).

7. **WCAG compliance**: For any accent color, verify the contrast ratio between the
   accent background and the auto-selected text color is ≥ 4.5:1 (AA standard). The
   `getContrastingTextColor()` function uses a luminance threshold of 0.179, which
   produces ratios above 4.5:1 for both branches (`#1a1a1a` on light, `#e5e5e5` on dark).
