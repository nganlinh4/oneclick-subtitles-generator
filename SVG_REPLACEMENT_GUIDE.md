# Material Symbols Rounded SVG Replacement Guide

## Overview
This guide documents the process of replacing static inline SVGs and data:image/svg+xml background images with Material Symbols Rounded glyphs throughout the codebase. This provides consistent iconography, better performance, and centralized tuning capabilities.

## Current Status
- ✅ Centralized tuning in `src/styles/index.css`
- ✅ Replaced inline SVGs in JS/JSX components
- ✅ Replaced data:image/svg+xml in CSS files
- ✅ Excluded PlayPauseMorph components (animated SVGs)
- 🔄 Remaining: Additional SVG instances in node_modules, build outputs, and potentially undiscovered source files

## Centralized Tuning
All Material Symbols Rounded parameters are controlled in `src/styles/index.css`:

```css
@import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,GRAD@24,600,0&display=swap');

:root {
  --ms-font-family: 'Material Symbols Rounded', 'Material Symbols', 'Material Icons';
  --ms-wght: 600;  /* Weight: 100-900 */
  --ms-grad: 0;    /* Grade: -50 to 200 */
  --ms-opsz: 24;   /* Optical size: 20-48 */
  --ms-size-default: 20px;
}

.material-symbols-rounded {
  font-family: var(--ms-font-family) !important;
  font-variation-settings: "wght" var(--ms-wght), "GRAD" var(--ms-grad), "opsz" var(--ms-opsz);
  font-weight: var(--ms-wght);
  display: inline-block;
  vertical-align: middle;
  line-height: 1;
}
```

To change appearance globally, modify the CSS variables in `:root`.

## Replacement Patterns

### 1. Inline SVGs in JS/JSX Components
**Find:** `<svg>...</svg>` elements
**Replace with:**
```jsx
<span className="material-symbols-rounded" style={{ fontSize: XX, color: YY }}>glyph_name</span>
```

**Example:**
```jsx
// Before
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
</svg>

// After
<span className="material-symbols-rounded" style={{ fontSize: 20, color: 'currentColor' }}>star</span>
```

### 2. CSS Background Images (data:image/svg+xml)
**Find:** `background-image: url("data:image/svg+xml,...");`
**Replace with:**
```css
/* Remove background-image lines */
select::after {
  content: 'expand_more';
  font-family: var(--ms-font-family);
  font-variation-settings: "wght" var(--ms-wght), "GRAD" var(--ms-grad), "opsz" var(--ms-opsz);
  font-size: 16px;
  color: #99a1a8;
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
}
```

## Finding Remaining SVGs

### Search Commands
```bash
# Find inline SVGs in source files
grep -r "<svg" src/ --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx"

# Find data:image/svg+xml in CSS files
grep -r "data:image/svg+xml" src/styles/

# Find background-image with SVG data
grep -r "background-image.*data:image/svg+xml" src/styles/
```

### Files to Check
- All JS/JSX/TS/TSX files in `src/components/`
- All CSS files in `src/styles/`
- Exclude `node_modules/`, `build/`, and `dist/` directories
- Exclude files containing "PlayPauseMorph" (animated components)

## Steps for Future Replacements

1. **Search for SVGs:**
   - Use grep to find `<svg>` tags in component files
   - Use grep to find `data:image/svg+xml` in CSS files

2. **Identify Glyph Names:**
   - Visit https://fonts.google.com/icons
   - Search for equivalent Material Symbols Rounded glyphs
   - Note the glyph name (e.g., "expand_more", "star", "close")

3. **Replace Inline SVGs:**
   - Convert `<svg>` to `<span className="material-symbols-rounded">`
   - Preserve size with `style={{ fontSize: XX }}`
   - Preserve color with `style={{ color: YY }}`
   - Use glyph name as text content

4. **Replace CSS Background SVGs:**
   - Remove `background-image` property
   - Add `::after` or `::before` pseudo-element
   - Set `content: 'glyph_name'`
   - Apply Material Symbols font properties
   - Position appropriately (usually absolute positioning)

5. **Test Changes:**
   - Run `npm run dev`
   - Verify icons display correctly
   - Check responsive behavior
   - Ensure accessibility (screen readers)

## Exclusions
- **PlayPauseMorph components:** These use animated SVGs for morphing effects
- **node_modules:** Third-party dependencies (handled by package managers)
- **Build outputs:** Generated files in `build/` or `dist/`
- **src/components/common/CustomDropdown.js:** Dropdown arrows
- **src/components/common/MaterialSwitch.js:** Check/close icons
- **Split icon in LyricsHeader.js and icons in NarrationMethodSelection.js:** Custom SVGs

## Material Symbols Reference
- **Font Family:** 'Material Symbols Rounded'
- **Weight (wght):** 100-900 (default: 600)
- **Grade (GRAD):** -50 to 200 (default: 0)
- **Optical Size (opsz):** 20-48 (default: 24)
- **Documentation:** https://fonts.google.com/icons
- **Glyph Search:** Use the search bar to find specific icons

## Troubleshooting
- **Icons not showing:** Check font import in `index.css`
- **Wrong appearance:** Verify CSS variables in `:root`
- **Positioning issues:** Adjust pseudo-element positioning
- **Color inheritance:** Use explicit color styles if needed

## Performance Benefits
- Reduced bundle size (no inline SVG data)
- Better caching (shared font vs individual SVGs)
- Consistent rendering across browsers
- Centralized theming capabilities