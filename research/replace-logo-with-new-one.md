# Research: Replace Logo with New One

## Executive Summary

The Castle app currently uses the **castle emoji (🏰)** as its logo in 4 locations across the UI, plus uses a generic `favicon.ico` for the browser tab. A new logo image has been added at `src/assets/logo.png`. This task replaces all emoji-based logo instances with `<img>` tags pointing to the new PNG, updates the favicon, and generates Electron app icons if needed.

This is a **low-complexity, low-risk** task — purely presentational changes across a handful of template and SCSS files.

---

## Current Logo Locations

### 1. Sidebar — Top-Left Home Button (Castle Logo)

**File:** `src/app/features/sidebar/sidebar.component.html` (Line 8)
```html
<span class="castle-logo">🏰</span>
```

**Styling:** `src/app/features/sidebar/sidebar.component.scss` (Line 25)
```scss
.castle-logo {
  font-size: 24px;
}
```

**Context:** This is the main app icon in the top-left corner of the sidebar, inside a `mat-fab` button. It acts as the home/tasks navigation button. This is the most prominent logo in the app.

---

### 2. Welcome/Landing Screen

**File:** `src/app/layout/main-layout.component.html` (Line 40)
```html
<span class="landing-logo">🏰</span>
```

**Styling:** `src/app/layout/main-layout.component.scss` (Lines 298-301)
```scss
.landing-logo {
  font-size: 80px;
  line-height: 1;
}
```

**Context:** Large logo shown on the welcome screen before the user selects a project folder. Displayed at 80px — the largest logo instance.

---

### 3. About Dialog

**File:** `src/app/shared/components/about-dialog/about-dialog.component.html` (Line 3)
```html
<span class="app-logo">🏰</span>
```

**Styling:** `src/app/shared/components/about-dialog/about-dialog.component.scss` (Lines 12-15)
```scss
.app-logo {
  font-size: 48px;
  margin-bottom: 8px;
}
```

**Context:** Centered logo in the About dialog, shown at 48px.

---

### 4. Settings Page — About Section

**File:** `src/app/features/settings/settings-page.component.html` (Line 391)
```html
<span class="app-logo">🏰</span>
```

**Styling:** `src/app/features/settings/settings-page.component.scss` (Lines 510-513)
```scss
.app-logo {
  font-size: 36px;
  line-height: 1;
}
```

**Context:** Small logo in the About card at the bottom of the settings page, displayed at 36px.

---

### 5. Favicon (Browser Tab Icon)

**File:** `src/index.html` (Line 8)
```html
<link rel="icon" type="image/x-icon" href="favicon.ico">
```

**Asset:** `src/favicon.ico` — Currently a generic favicon (not the castle emoji). Should be replaced with a favicon derived from the new logo.

**Angular config:** `angular.json` (Line 34) includes `src/favicon.ico` in the assets array.

---

### 6. Electron App Icons (Build-Time)

**File:** `package.json` (Lines 79-90)
```json
"win": { "target": "nsis", "icon": "resources/icons/icon.ico" },
"mac": { "target": "dmg", "icon": "resources/icons/icon.icns" },
"linux": { "target": "AppImage", "icon": "resources/icons" }
```

**Status:** The `resources/icons/` directory **does not exist yet**. These paths are referenced in the electron-builder config but haven't been created. When building distributables, these icons would be used for the .exe/.dmg/.AppImage.

---

### 7. README

**File:** `README.md` (Line 1)
```markdown
# Castle
```

The README title does not currently include a logo image. However, the task description says "Don't forget to look at the readme!" — suggesting the new logo should be added to the README as well, likely at the top.

---

## New Logo Asset

**Path:** `src/assets/logo.png`

This file already exists and is included in the Angular build via:
```json
// angular.json assets array:
"src/assets"
```

At runtime, the logo will be accessible at the path `assets/logo.png` (relative to the app root).

---

## Proposed Approach

### Step 1: Replace Sidebar Logo (Home Button)

**File:** `src/app/features/sidebar/sidebar.component.html` (Line 8)

```html
<!-- Before -->
<span class="castle-logo">🏰</span>

<!-- After -->
<img class="castle-logo" src="assets/logo.png" alt="Castle" />
```

**File:** `src/app/features/sidebar/sidebar.component.scss` (Line 25-27)

```scss
/* Before */
.castle-logo {
  font-size: 24px;
}

/* After */
.castle-logo {
  width: 24px;
  height: 24px;
  object-fit: contain;
}
```

---

### Step 2: Replace Welcome Screen Logo

**File:** `src/app/layout/main-layout.component.html` (Line 40)

```html
<!-- Before -->
<span class="landing-logo">🏰</span>

<!-- After -->
<img class="landing-logo" src="assets/logo.png" alt="Castle" />
```

**File:** `src/app/layout/main-layout.component.scss` (Lines 298-301)

```scss
/* Before */
.landing-logo {
  font-size: 80px;
  line-height: 1;
}

/* After */
.landing-logo {
  width: 80px;
  height: 80px;
  object-fit: contain;
}
```

---

### Step 3: Replace About Dialog Logo

**File:** `src/app/shared/components/about-dialog/about-dialog.component.html` (Line 3)

```html
<!-- Before -->
<span class="app-logo">🏰</span>

<!-- After -->
<img class="app-logo" src="assets/logo.png" alt="Castle" />
```

**File:** `src/app/shared/components/about-dialog/about-dialog.component.scss` (Lines 12-15)

```scss
/* Before */
.app-logo {
  font-size: 48px;
  margin-bottom: 8px;
}

/* After */
.app-logo {
  width: 48px;
  height: 48px;
  object-fit: contain;
  margin-bottom: 8px;
}
```

---

### Step 4: Replace Settings Page Logo

**File:** `src/app/features/settings/settings-page.component.html` (Line 391)

```html
<!-- Before -->
<span class="app-logo">🏰</span>

<!-- After -->
<img class="app-logo" src="assets/logo.png" alt="Castle" />
```

**File:** `src/app/features/settings/settings-page.component.scss` (Lines 510-513)

```scss
/* Before */
.app-logo {
  font-size: 36px;
  line-height: 1;
}

/* After */
.app-logo {
  width: 36px;
  height: 36px;
  object-fit: contain;
}
```

---

### Step 5: Replace Favicon

Generate a `favicon.ico` from `src/assets/logo.png` and replace `src/favicon.ico`.

Tools to generate:
- Online: [favicon.io](https://favicon.io/favicon-converter/) or [realfavicongenerator.net](https://realfavicongenerator.net/)
- CLI: `npx png-to-ico src/assets/logo.png > src/favicon.ico`
- Or use ImageMagick: `convert src/assets/logo.png -resize 32x32 src/favicon.ico`

No code changes needed beyond replacing the file — `index.html` and `angular.json` already reference it.

---

### Step 6: Add Logo to README

**File:** `README.md` (Line 1)

```markdown
<!-- Before -->
# Castle

<!-- After -->
<p align="center">
  <img src="src/assets/logo.png" alt="Castle" width="128" />
</p>

# Castle
```

---

### Step 7: Generate Electron App Icons (Optional — Build Infra)

The `package.json` references `resources/icons/icon.ico` and `resources/icons/icon.icns`, but the directory doesn't exist. To support Electron builds:

1. Create `resources/icons/` directory
2. Generate platform-specific icons from `logo.png`:
   - `icon.ico` — Windows (256x256, 128x128, 64x64, 48x48, 32x32, 16x16)
   - `icon.icns` — macOS (1024x1024 down to 16x16)
   - `icon.png` — Linux (512x512 or 1024x1024)

Tools:
- [electron-icon-builder](https://github.com/nicedoc/electron-icon-builder): `npx electron-icon-builder --input=src/assets/logo.png --output=resources/icons`
- Or use [iconutil](https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html) on macOS for .icns

---

## Key Considerations

### 1. Image Path in Electron vs Browser

In the Angular dev server, `src="assets/logo.png"` works because assets are served from the root. In an Electron build, the built app serves files from the `dist/` directory, where Angular copies assets. The path `assets/logo.png` works in both contexts because Angular's asset pipeline handles it.

### 2. `<span>` to `<img>` Element Change

Replacing `<span>🏰</span>` with `<img>` changes the element type. This affects:
- **Sizing:** Emoji uses `font-size`; images use `width`/`height` — SCSS must be updated
- **Alignment:** `<img>` is inline-replaced, may need `vertical-align: middle` or flexbox adjustments
- **Color inheritance:** Emoji inherits text color adjustments; `<img>` does not — irrelevant for a PNG logo

### 3. Logo Aspect Ratio

Using `object-fit: contain` ensures the logo scales correctly regardless of aspect ratio. If the logo is square, `width` and `height` can be equal. If not, consider using only `width` or `height` and letting the other dimension auto-scale.

### 4. Sidebar Button Sizing

The sidebar home button uses `mat-fab` (a 56px circular Material button). The 24px logo inside it should be fine, but verify it looks centered after the change. The `mat-fab` flexbox centering should handle `<img>` the same as `<span>`.

### 5. Dark/Light Theme Compatibility

If the new logo has transparency (PNG with alpha), ensure it looks good on both dark and light themes. If the logo has a dark background or hard edges, it may need a subtle background or border-radius in light mode.

---

## Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Logo fails to load | Add `alt="Castle"` for accessibility fallback text |
| Non-square logo | `object-fit: contain` preserves aspect ratio |
| High-DPI displays | PNG should be large enough (ideally 256px+ source) for crisp rendering at all sizes |
| Electron offline mode | Logo is bundled as an asset — always available |
| Web/Tailscale mode | Same Angular build serves assets; path works |

---

## File Summary

### Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `src/app/features/sidebar/sidebar.component.html` | `🏰` → `<img>` | 1 |
| `src/app/features/sidebar/sidebar.component.scss` | `font-size` → `width/height` | 3 |
| `src/app/layout/main-layout.component.html` | `🏰` → `<img>` | 1 |
| `src/app/layout/main-layout.component.scss` | `font-size` → `width/height` | 3 |
| `src/app/shared/components/about-dialog/about-dialog.component.html` | `🏰` → `<img>` | 1 |
| `src/app/shared/components/about-dialog/about-dialog.component.scss` | `font-size` → `width/height` | 3 |
| `src/app/features/settings/settings-page.component.html` | `🏰` → `<img>` | 1 |
| `src/app/features/settings/settings-page.component.scss` | `font-size` → `width/height` | 3 |
| `src/favicon.ico` | Replace with new logo-derived favicon | Binary |
| `README.md` | Add logo image at top | 4 |

### Files to Create (Optional — Electron Build Icons)

| File | Purpose |
|------|---------|
| `resources/icons/icon.ico` | Windows app icon |
| `resources/icons/icon.icns` | macOS app icon |
| `resources/icons/icon.png` | Linux app icon |

### Existing Asset

| File | Status |
|------|--------|
| `src/assets/logo.png` | ✅ Already exists — the new logo |

---

## Complexity Estimate

| Item | Effort |
|------|--------|
| 4 HTML template changes | ~5 min |
| 4 SCSS style updates | ~10 min |
| README update | ~2 min |
| Favicon generation | ~5 min |
| Electron icons (optional) | ~15 min |
| Visual testing | ~10 min |
| **Total** | **~45 min** |

**Risk:** Very low. All changes are presentational with no logic impact.

---

## Recommended Implementation Order

1. Replace sidebar logo (`sidebar.component.html` + `.scss`)
2. Replace welcome screen logo (`main-layout.component.html` + `.scss`)
3. Replace about dialog logo (`about-dialog.component.html` + `.scss`)
4. Replace settings page logo (`settings-page.component.html` + `.scss`)
5. Add logo to README
6. Replace `src/favicon.ico` with logo-derived favicon
7. Generate Electron app icons in `resources/icons/` (optional, for builds)
8. Visual test all 4 logo locations + favicon in browser tab
