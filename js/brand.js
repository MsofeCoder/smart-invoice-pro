/**
 * Brand theming engine.
 *
 * Turns two brand colours (+ a few style choices) into a complete, contrast-safe
 * design token set for both light and dark themes, then applies it as inline CSS
 * custom properties on <html>.
 *
 * Why inline custom properties? They beat both `:root` and `[data-theme="dark"]`
 * on specificity, so the stylesheet keeps sensible defaults while the live brand
 * wins.
 *
 * Persistence is two-tier:
 *   - localStorage  `sip_brand`    → synchronous, read by brand-boot.js before first paint
 *   - IndexedDB     settings.brand → authoritative, included in backup/restore
 *
 * The storage-key prefix and the default app name both come from
 * js/app.config.js; this module holds no product identity of its own.
 */

import { readStorage, writeStorage, appName, appTagline } from './config.js';

/* ==========================================================================
   1. Color math
   ========================================================================== */

export function hexToRgb(hex) {
  if (!hex) return null;
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function isValidHex(hex) {
  return hexToRgb(hex) !== null;
}

export function rgbToHex({ r, g, b }) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** [r, g, b] — the shape jsPDF wants for setFillColor/setTextColor. */
export function hexToRgbArray(hex) {
  const c = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
  return [c.r, c.g, c.b];
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}

function hslToRgb({ h, s, l }) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3) * 255,
    g: hue2rgb(p, q, h) * 255,
    b: hue2rgb(p, q, h - 1 / 3) * 255,
  };
}

export function lighten(hex, amount) {
  const hsl = rgbToHsl(hexToRgb(hex) || { r: 0, g: 0, b: 0 });
  hsl.l = Math.min(1, Math.max(0, hsl.l + amount));
  return rgbToHex(hslToRgb(hsl));
}

export function darken(hex, amount) {
  const hsl = rgbToHsl(hexToRgb(hex) || { r: 0, g: 0, b: 0 });
  hsl.l = Math.min(1, Math.max(0, hsl.l - amount));
  return rgbToHex(hslToRgb(hsl));
}

/** Blend two colors. `weight` is how much of `b` to use (0..1). */
export function mix(a, b, weight = 0.5) {
  const A = hexToRgb(a) || { r: 0, g: 0, b: 0 };
  const B = hexToRgb(b) || { r: 0, g: 0, b: 0 };
  const w = Math.max(0, Math.min(1, weight));
  return rgbToHex({
    r: A.r + (B.r - A.r) * w,
    g: A.g + (B.g - A.g) * w,
    b: A.b + (B.b - A.b) * w,
  });
}

export function withAlpha(hex, alpha) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/* ---------- WCAG contrast ---------- */

export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pick black or white text for a given background, whichever reads better. */
export function readableOn(bg) {
  return contrastRatio(bg, '#FFFFFF') >= contrastRatio(bg, '#1A1A1A') ? '#FFFFFF' : '#1A1A1A';
}

/**
 * Nudge a color along the lightness axis until it meets `min` contrast against `against`.
 * Used so a pale brand color still produces readable link text on white.
 */
export function ensureContrast(hex, against, min = 4.5) {
  if (contrastRatio(hex, against) >= min) return hex;
  const goDarker = relativeLuminance(against) > 0.5;
  for (let i = 1; i <= 25; i++) {
    const out = goDarker ? darken(hex, i * 0.035) : lighten(hex, i * 0.035);
    if (contrastRatio(out, against) >= min) return out;
  }
  return goDarker ? '#000000' : '#FFFFFF';
}

/** The best contrast achievable with either white or near-black text on `bg`. */
export function bestTextContrast(bg) {
  return Math.max(contrastRatio('#FFFFFF', bg), contrastRatio('#1A1A1A', bg));
}

/**
 * Guarantee that SOME text color reads on this fill.
 *
 * Mid-tone colors (think a rose or slate at ~50% lightness) sit in a dead zone
 * where neither white nor black text reaches 4.5:1 — the worst case was 4.19:1.
 * A brand color must never produce an unreadable button, so the fill is nudged
 * along the lightness axis in small steps until one side qualifies. The shift is
 * minimal and only ever happens when the client's pick genuinely cannot work.
 */
export function ensureFillContrast(hex, min = 4.5) {
  if (bestTextContrast(hex) >= min) return hex;
  const goLighter = contrastRatio('#1A1A1A', hex) > contrastRatio('#FFFFFF', hex);
  let out = hex;
  for (let i = 1; i <= 40; i++) {
    out = goLighter ? lighten(hex, i * 0.015) : darken(hex, i * 0.015);
    if (bestTextContrast(out) >= min) return out;
  }
  return out;
}

/** WCAG grade for a text/background pair — used by the settings UI readout. */
export function contrastGrade(ratio) {
  if (ratio >= 7) return { label: 'AAA', level: 'pass' };
  if (ratio >= 4.5) return { label: 'AA', level: 'pass' };
  if (ratio >= 3) return { label: 'AA Large', level: 'warn' };
  return { label: 'Fail', level: 'fail' };
}

/* ==========================================================================
   2. Brand definition
   ========================================================================== */

export const DEFAULT_BRAND = Object.freeze({
  preset: 'signature',
  primary: '#2E7D32',
  accent: '#F9A825',
  radius: 12,
  sidebar: 'gradient',
  appName: '',
  appTagline: '',
});

/** Curated, contrast-checked palettes. Every one pairs a deep primary with a bright accent. */
export const PRESETS = [
  { id: 'signature', name: 'Signature Green', primary: '#2E7D32', accent: '#F9A825' },
  { id: 'ocean',    name: 'Ocean Blue',      primary: '#1565C0', accent: '#00ACC1' },
  { id: 'midnight', name: 'Midnight Navy',   primary: '#0D47A1', accent: '#FFC107' },
  { id: 'royal',    name: 'Royal Purple',    primary: '#6A1B9A', accent: '#EC407A' },
  { id: 'indigo',   name: 'Indigo',          primary: '#283593', accent: '#FFA000' },
  { id: 'teal',     name: 'Deep Teal',       primary: '#00695C', accent: '#FFB300' },
  { id: 'emerald',  name: 'Emerald',         primary: '#00796B', accent: '#F4511E' },
  { id: 'forest',   name: 'Forest Amber',    primary: '#33691E', accent: '#FF8F00' },
  { id: 'crimson',  name: 'Crimson',         primary: '#C62828', accent: '#FB8C00' },
  { id: 'rose',     name: 'Rose Gold',       primary: '#AD1457', accent: '#FFB74D' },
  { id: 'sunset',   name: 'Sunset Orange',   primary: '#E65100', accent: '#FDD835' },
  { id: 'slate',    name: 'Corporate Slate', primary: '#37474F', accent: '#00B0FF' },
];

export const SIDEBAR_STYLES = [
  { id: 'gradient', name: 'Gradient', hint: 'Brand gradient' },
  { id: 'solid',    name: 'Solid',    hint: 'Flat brand' },
  { id: 'deep',     name: 'Deep',     hint: 'Near-black' },
  { id: 'light',    name: 'Light',    hint: 'Light surface' },
];

export const RADIUS_MIN = 0;
export const RADIUS_MAX = 24;

/**
 * Preset ids renamed when the product became a white-label template. Applied on
 * read so a palette saved under an older id still highlights the correct swatch
 * in Settings instead of silently falling back to "custom".
 */
export const PRESET_ALIASES = { crown: 'signature' };

/** Coerce anything into a valid brand object. Never throws. */
export function normalizeBrand(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const primary = isValidHex(raw.primary) ? String(raw.primary).toUpperCase() : DEFAULT_BRAND.primary;
  const accent = isValidHex(raw.accent) ? String(raw.accent).toUpperCase() : DEFAULT_BRAND.accent;
  const radiusNum = Number(raw.radius);
  const radius = Number.isFinite(radiusNum)
    ? Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Math.round(radiusNum)))
    : DEFAULT_BRAND.radius;
  const sidebar = SIDEBAR_STYLES.some((s) => s.id === raw.sidebar) ? raw.sidebar : DEFAULT_BRAND.sidebar;
  let preset = typeof raw.preset === 'string' && raw.preset ? raw.preset.slice(0, 40) : 'custom';
  if (PRESET_ALIASES[preset]) preset = PRESET_ALIASES[preset];
  const appName = typeof raw.appName === 'string' ? raw.appName.trim().slice(0, 60) : '';
  const appTagline = typeof raw.appTagline === 'string' ? raw.appTagline.trim().slice(0, 60) : '';
  return { preset, primary, accent, radius, sidebar, appName, appTagline };
}

/** Which preset (if any) matches these two colors. */
export function matchPreset(primary, accent) {
  const p = String(primary || '').toUpperCase();
  const a = String(accent || '').toUpperCase();
  const hit = PRESETS.find((x) => x.primary.toUpperCase() === p && x.accent.toUpperCase() === a);
  return hit ? hit.id : 'custom';
}

/* ==========================================================================
   3. Palette builder
   ========================================================================== */

const SIDEBAR_IDS = SIDEBAR_STYLES.map((s) => s.id);

/* Dark surfaces. `--surface` (#1B211B) is lighter than `--bg` (#121612), so it is
   the stricter backdrop and the one text has to clear. */
const DARK_SURFACE = '#1B211B';
const LIGHT_SURFACE = '#FFFFFF';

function sidebarVars(brand, theme, brandFill, accentFill) {
  const primary = brand.primary;
  const style = SIDEBAR_IDS.includes(brand.sidebar) ? brand.sidebar : 'gradient';
  const dark = theme === 'dark';

  if (style === 'light') {
    const bg = dark ? DARK_SURFACE : LIGHT_SURFACE;
    return {
      '--sidebar-bg': bg,
      '--sidebar-fg': dark ? '#ECEFEC' : '#2B2B2B',
      '--sidebar-fg-soft': dark ? 'rgba(236,239,236,0.60)' : 'rgba(43,43,43,0.55)',
      '--sidebar-hover': dark ? 'rgba(255,255,255,0.06)' : mix(primary, '#FFFFFF', 0.90),
      '--sidebar-border': dark ? '#2C362C' : '#E4E7E4',
      '--sidebar-active-bg': brandFill,
      '--sidebar-active-fg': readableOn(brandFill),
      '--sidebar-logo-bg': dark ? '#222A22' : '#FFFFFF',
      '--sidebar-logo-border': dark ? '#2C362C' : '#E4E7E4',
      '--sidebar-card-bg': dark ? 'rgba(255,255,255,0.05)' : mix(primary, '#FFFFFF', 0.94),
    };
  }

  let bg;
  if (style === 'solid') {
    bg = darken(primary, 0.10);
  } else if (style === 'deep') {
    bg = `linear-gradient(180deg, ${mix(primary, '#000000', 0.80)} 0%, ${mix(primary, '#000000', 0.66)} 100%)`;
  } else {
    bg = `linear-gradient(180deg, ${darken(primary, 0.18)} 0%, ${darken(primary, 0.10)} 60%, ${primary} 100%)`;
  }

  return {
    '--sidebar-bg': bg,
    '--sidebar-fg': '#FFFFFF',
    '--sidebar-fg-soft': 'rgba(255, 255, 255, 0.55)',
    '--sidebar-hover': 'rgba(255, 255, 255, 0.10)',
    '--sidebar-border': 'rgba(255, 255, 255, 0.12)',
    '--sidebar-active-bg': accentFill,
    '--sidebar-active-fg': readableOn(accentFill),
    '--sidebar-logo-bg': '#FFFFFF',
    '--sidebar-logo-border': 'transparent',
    '--sidebar-card-bg': 'rgba(255, 255, 255, 0.10)',
  };
}

/**
 * Build the full token map for a brand + theme.
 * @returns {Object<string,string>} CSS custom property name → value
 */
export function buildPalette(input, theme = 'light') {
  const brand = normalizeBrand(input);
  const dark = theme === 'dark';
  const { primary, accent, radius } = brand;
  const vars = {};

  // Fills that carry text on top must be legible no matter what the client picked.
  const brandFill = ensureFillContrast(dark ? lighten(primary, 0.16) : primary);
  const accentFill = ensureFillContrast(dark ? lighten(accent, 0.10) : accent);
  const surface = dark ? DARK_SURFACE : LIGHT_SURFACE;

  if (dark) {
    // On dark surfaces the brand has to move *up* in lightness to stay visible.
    vars['--brand'] = brandFill;
    vars['--brand-dark'] = primary;
    vars['--brand-darker'] = darken(primary, 0.10);
    vars['--brand-light'] = lighten(primary, 0.30);
    vars['--brand-soft'] = withAlpha(brandFill, 0.16);
    vars['--brand-ink'] = ensureContrast(brandFill, surface, 4.5);
    vars['--brand-contrast'] = readableOn(brandFill);
    vars['--shadow-brand'] = withAlpha(brandFill, 0.25);

    vars['--gold'] = accentFill;
    vars['--gold-light'] = lighten(accent, 0.26);
    vars['--gold-soft'] = withAlpha(accentFill, 0.14);
    vars['--gold-ink'] = ensureContrast(accentFill, surface, 4.5);
    vars['--gold-contrast'] = readableOn(accentFill);
  } else {
    vars['--brand'] = brandFill;
    vars['--brand-dark'] = darken(primary, 0.10);
    vars['--brand-darker'] = darken(primary, 0.18);
    vars['--brand-light'] = lighten(primary, 0.10);
    vars['--brand-soft'] = mix(primary, '#FFFFFF', 0.92);
    // Links and .text-brand need to stay readable even for a pale brand color.
    vars['--brand-ink'] = ensureContrast(primary, surface, 4.5);
    vars['--brand-contrast'] = readableOn(brandFill);
    vars['--shadow-brand'] = withAlpha(primary, 0.28);

    vars['--gold'] = accentFill;
    vars['--gold-light'] = lighten(accent, 0.12);
    vars['--gold-soft'] = mix(accent, '#FFFFFF', 0.88);
    vars['--gold-ink'] = ensureContrast(accent, surface, 3.0);
    vars['--gold-contrast'] = readableOn(accentFill);
  }

  // Radius scale derived from the single base value.
  vars['--radius-sm'] = `${Math.max(3, Math.round(radius * 0.66))}px`;
  vars['--radius'] = `${radius}px`;
  vars['--radius-lg'] = `${Math.round(radius * 1.5)}px`;
  vars['--radius-xl'] = `${Math.round(radius * 2)}px`;

  Object.assign(vars, sidebarVars(brand, theme, brandFill, accentFill));

  return vars;
}

/** Serialize a palette as a `:root { ... }` block — for print windows and PDF HTML. */
export function paletteToCss(input, theme = 'light') {
  const vars = buildPalette(input, theme);
  const body = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `:root {\n${body}\n}`;
}

/* ==========================================================================
   4. Applying to the document
   ========================================================================== */

export function currentTheme() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Write the palette onto <html> as inline custom properties. */
export function applyPalette(input, theme = currentTheme()) {
  if (typeof document === 'undefined') return null;
  const brand = normalizeBrand(input);
  const vars = buildPalette(brand, theme);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);

  // Keep the browser/PWA chrome in step with the brand.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const c = hexToRgb(vars['--brand-darker']) ? vars['--brand-darker'] : vars['--brand'];
    meta.setAttribute('content', c);
  }
  return vars;
}

/* ==========================================================================
   5. Persistence
   ========================================================================== */

/**
 * Logical localStorage name. The physical key is prefixed by js/app.config.js
 * (`storagePrefix`), which is what lets the template be re-skinned without
 * stranding a user's saved palette.
 */
export const BRAND_LS_NAME = 'brand';
export const BRAND_SETTING_KEY = 'brand';

/** Synchronous read — the only thing brand-boot.js can rely on. */
export function loadBrandSync() {
  try {
    const raw = readStorage(BRAND_LS_NAME);
    if (!raw) return { ...DEFAULT_BRAND };
    return normalizeBrand(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BRAND };
  }
}

export function cacheBrand(input) {
  const brand = normalizeBrand(input);
  // Never throws: a full or blocked localStorage still leaves IndexedDB as the
  // source of truth.
  writeStorage(BRAND_LS_NAME, JSON.stringify(brand));
  return brand;
}

/** Authoritative read: IndexedDB first, localStorage as the fallback. */
export async function loadBrand() {
  try {
    const { getSetting } = await import('./storageService.js');
    const stored = await getSetting(BRAND_SETTING_KEY, null);
    if (stored) {
      const brand = normalizeBrand(stored);
      cacheBrand(brand);
      return brand;
    }
  } catch {
    /* fall through to localStorage */
  }
  return loadBrandSync();
}

/** Persist to both tiers and return the normalized brand. */
export async function saveBrand(input) {
  const brand = cacheBrand(input);
  try {
    const { setSetting } = await import('./storageService.js');
    await setSetting(BRAND_SETTING_KEY, brand);
  } catch {
    /* IndexedDB unavailable — localStorage cache still applied the theme */
  }
  return brand;
}

export async function resetBrand() {
  return saveBrand(DEFAULT_BRAND);
}

/**
 * Resolve the display name for the app/sidebar.
 * Falls back to the business name, then to the product default.
 */
export function resolveAppName(brand, company) {
  const b = normalizeBrand(brand);
  if (b.appName) return b.appName;
  if (company && company.businessName) return String(company.businessName).slice(0, 60);
  return appName();
}

export function resolveAppTagline(brand) {
  const b = normalizeBrand(brand);
  return b.appTagline || appTagline();
}

/** Brand colors as [r,g,b] arrays for jsPDF. */
export function pdfColors(input, theme = 'light') {
  const vars = buildPalette(input, theme);
  return {
    brand: hexToRgbArray(vars['--brand']),
    brandDark: hexToRgbArray(vars['--brand-darker']),
    accent: hexToRgbArray(vars['--gold']),
    // Text-safe variants — a pale brand needs a darker ink to stay readable on paper.
    brandInk: hexToRgbArray(vars['--brand-ink']),
    accentInk: hexToRgbArray(vars['--gold-ink']),
    brandContrast: hexToRgbArray(vars['--brand-contrast']),
    accentContrast: hexToRgbArray(vars['--gold-contrast']),
    vars,
  };
}
