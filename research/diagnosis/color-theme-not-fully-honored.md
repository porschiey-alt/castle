# Color Theme Not Fully Honored

## Diagnosis and Suggested Fix

### Symptoms

1. **Buttons ignore custom accent color.** The "New Task", "Create"/"Save", "Submit Review", "Start Research", "Start Diagnosis", and "Start Implementation" `mat-flat-button color="primary"` buttons always render with Angular Material's hardcoded **indigo** palette regardless of the user's chosen accent color.

2. **Tab indicator/label color ignores accent.** The `mat-tab-group` on the task detail page (Description / Research / Implementation tabs) uses Material's built-in primary palette for the active tab underline and label text, which stays indigo instead of tracking `--theme-primary`.

3. **No secondary accent customization.** The `--theme-accent` CSS variable is set from the theme preset's `accent` field (e.g. `#22c55e`) and is **never customizable** by the user. The settings page's "Accent" color picker only controls `--theme-primary`. There is no way to personalize the secondary accent used for badges, status indicators, and the conversation list.

### Root Cause Analysis

There are **two distinct root causes**:

#### 1. Angular Material palette vs. CSS variables mismatch

In `styles.scss`, the Material theme is defined with static palettes:

```scss
// styles.scss lines 106-112
@include mat.all-component-colors(mat.define-dark-theme((
  color: (
    primary: mat.define-palette(mat.$indigo-palette),   // ← hardcoded
    accent: mat.define-palette(mat.$green-palette),      // ← hardcoded
    warn: mat.define-palette(mat.$red-palette),
  )
)));
```

When a component uses `color="primary"` (e.g. `<button mat-flat-button color="primary">`), Angular Material applies its own palette tokens (`--mdc-filled-button-container-color`, etc.) based on the **static indigo palette**, completely bypassing the `--theme-primary` CSS variable.

The theme service (`theme.service.ts` line 175) correctly updates `--theme-primary` on the `:root` element, and many SCSS files correctly reference `var(--theme-primary)`. But the Material-internal tokens for **filled buttons** and **tabs** are never overridden to use this variable.

#### 2. Missing secondary accent customization

`ThemeCustomization` (`settings.types.ts`) only exposes:
- `bgPrimary`, `bgSecondary` — background colors
- `accentColor` — maps to `--theme-primary` only
- Gradient settings

There is no `secondaryAccentColor` property. The `--theme-accent` variable is always set from the theme preset's `.accent` field (`theme.service.ts` line 176) and cannot be overridden by the user. This means elements that use `var(--theme-accent)` (badges, status bar indicators, conversation list highlights) cannot be personalized.

### Suggested Fix

#### Fix 1: Override Material button and tab tokens to use `--theme-primary`

Add the following overrides inside the `.castle-dark, .midnight, .amoled` block in `styles.scss` (after the existing button overrides around line 134):

```scss
// Filled (flat) button: honor theme accent
.mat-mdc-unelevated-button.mat-primary {
  --mdc-filled-button-container-color: var(--theme-primary);
  --mdc-filled-button-label-text-color: #fff;
}

// Stroked button with color="primary"
.mat-mdc-outlined-button.mat-primary {
  --mdc-outlined-button-label-text-color: var(--theme-primary);
  --mdc-outlined-button-outline-color: var(--theme-primary);
}

// Tab group: honor theme accent
.mat-mdc-tab-group,
.mat-mdc-tab-nav-bar {
  --mdc-tab-indicator-active-indicator-color: var(--theme-primary);
  --mat-tab-header-active-label-text-color: var(--theme-primary);
  --mat-tab-header-active-focus-label-text-color: var(--theme-primary);
  --mat-tab-header-active-hover-label-text-color: var(--theme-primary);
  --mat-tab-header-active-focus-indicator-color: var(--theme-primary);
  --mat-tab-header-active-hover-indicator-color: var(--theme-primary);
}
```

Add equivalent overrides inside the `.castle-light` block as well.

#### Fix 2: Add secondary accent color support

**a. Extend `ThemeCustomization`** in `src/shared/types/settings.types.ts`:

```ts
export interface ThemeCustomization {
  bgPrimary?: string;
  bgSecondary?: string;
  accentColor?: string;
  secondaryAccentColor?: string;   // NEW
  gradientEnabled?: boolean;
  gradientEndColor?: string;
  gradientDirection?: string;
}
```

**b. Apply it in `theme.service.ts`** (in `applyTheme`):

```ts
const secondaryAccent = custom.secondaryAccentColor || theme.accent;
root.style.setProperty('--theme-accent', secondaryAccent);
```

**c. Expose in settings page** — Add a "Secondary Accent" color picker row in `settings-page.component.html` identical to the existing "Accent" row but bound to a new `customSecondaryAccentColor` model that feeds `secondaryAccentColor` in the customization object.

### Verification Steps

1. **Accent propagation to buttons:**
   - Open Settings → change the Accent color to a distinctly different hue (e.g. red `#ef4444`).
   - Navigate to Tasks → verify "New Task" button uses the new color.
   - Create/edit a task → verify "Create"/"Save" button uses the new color.
   - Open research/implementation tabs → verify "Start Research"/"Start Implementation" buttons use the new color.

2. **Tab indicator color:**
   - On the task detail view, switch between Description / Research / Implementation tabs.
   - Verify the active tab underline and label text match the custom accent color.

3. **Secondary accent:**
   - Set a secondary accent color in Settings.
   - Verify badge backgrounds, status bar indicators, and conversation list highlights change accordingly.

4. **Theme switching:**
   - Switch between Castle Dark, Midnight, AMOLED, and Castle Light.
   - Verify both accent colors reset to preset defaults and buttons/tabs follow the new preset primary.

5. **Regression:**
   - Verify form field focus outlines, progress spinners, selection highlights, and snackbar buttons still honor the accent (these already use `var(--theme-primary)` so should be unaffected).
