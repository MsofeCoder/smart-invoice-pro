/**
 * Brand boot (classic script, runs before first paint).
 *
 * This is a deliberately self-contained copy of the palette algorithm in `brand.js`.
 * It cannot `import` because ES modules are deferred, which would let the default
 * green theme paint for a frame before the custom brand applied — a visible flash on
 * every page load for any client who isn't on the default palette.
 *
 * It also stamps the white-label identity (document title, sidebar name and
 * tagline, logo initials) before the first paint, for the same reason: the
 * markup ships those nodes empty, so whoever fills them first wins the frame.
 *
 * Depends on `js/app.config.js`, which must be loaded first and publishes the
 * `AppConfig` storage helpers and the default app name.
 *
 * Keep the palette maths in sync with brand.js. `scripts/test-brand.js` asserts
 * the two produce byte-identical palettes across a matrix of colours, so drift
 * fails the tests.
 *
 * Exposes `window.BrandBoot` for that parity test.
 */
(function () {
  'use strict';

  var DEFAULT_BRAND = {
    preset: 'signature',
    primary: '#2E7D32',
    accent: '#F9A825',
    radius: 12,
    sidebar: 'gradient',
    appName: '',
    appTagline: '',
  };

  var SIDEBAR_IDS = ['gradient', 'solid', 'deep', 'light'];
  /* Preset ids renamed for white-labelling. Applied on read so a palette saved
     under the old id still highlights the correct swatch in Settings. */
  var PRESET_ALIASES = { crown: 'signature' };
  // --surface (#1B211B) is lighter than --bg (#121612), so it is the stricter backdrop.
  var DARK_SURFACE = '#1B211B';
  var LIGHT_SURFACE = '#FFFFFF';
  var RADIUS_MIN = 0;
  var RADIUS_MAX = 24;

  /* ---------- color math ---------- */

  function hexToRgb(hex) {
    if (!hex) return null;
    var h = String(hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgbToHex(c) {
    function p(n) {
      return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    }
    return ('#' + p(c.r) + p(c.g) + p(c.b)).toUpperCase();
  }

  function rgbToHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, d = max - min, h = 0, s = 0;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h * 360, s: s, l: l };
  }

  function hslToRgb(c) {
    var h = (((c.h % 360) + 360) % 360) / 360;
    if (c.s === 0) {
      var v = c.l * 255;
      return { r: v, g: v, b: v };
    }
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = c.l < 0.5 ? c.l * (1 + c.s) : c.l + c.s - c.l * c.s;
    var p = 2 * c.l - q;
    return {
      r: hue2rgb(p, q, h + 1 / 3) * 255,
      g: hue2rgb(p, q, h) * 255,
      b: hue2rgb(p, q, h - 1 / 3) * 255,
    };
  }

  function lighten(hex, amount) {
    var c = rgbToHsl(hexToRgb(hex) || { r: 0, g: 0, b: 0 });
    c.l = Math.min(1, Math.max(0, c.l + amount));
    return rgbToHex(hslToRgb(c));
  }

  function darken(hex, amount) {
    var c = rgbToHsl(hexToRgb(hex) || { r: 0, g: 0, b: 0 });
    c.l = Math.min(1, Math.max(0, c.l - amount));
    return rgbToHex(hslToRgb(c));
  }

  function mix(a, b, weight) {
    var A = hexToRgb(a) || { r: 0, g: 0, b: 0 };
    var B = hexToRgb(b) || { r: 0, g: 0, b: 0 };
    var w = Math.max(0, Math.min(1, weight === undefined ? 0.5 : weight));
    return rgbToHex({
      r: A.r + (B.r - A.r) * w,
      g: A.g + (B.g - A.g) * w,
      b: A.b + (B.b - A.b) * w,
    });
  }

  function withAlpha(hex, alpha) {
    var c = hexToRgb(hex);
    if (!c) return hex;
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + Math.max(0, Math.min(1, alpha)) + ')';
  }

  function relativeLuminance(hex) {
    var c = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
    function f(v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function contrastRatio(a, b) {
    var l1 = relativeLuminance(a), l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function readableOn(bg) {
    return contrastRatio(bg, '#FFFFFF') >= contrastRatio(bg, '#1A1A1A') ? '#FFFFFF' : '#1A1A1A';
  }

  function ensureContrast(hex, against, min) {
    if (contrastRatio(hex, against) >= min) return hex;
    var goDarker = relativeLuminance(against) > 0.5;
    for (var i = 1; i <= 25; i++) {
      var out = goDarker ? darken(hex, i * 0.035) : lighten(hex, i * 0.035);
      if (contrastRatio(out, against) >= min) return out;
    }
    return goDarker ? '#000000' : '#FFFFFF';
  }

  function bestTextContrast(bg) {
    return Math.max(contrastRatio('#FFFFFF', bg), contrastRatio('#1A1A1A', bg));
  }

  function ensureFillContrast(hex, min) {
    min = min === undefined ? 4.5 : min;
    if (bestTextContrast(hex) >= min) return hex;
    var goLighter = contrastRatio('#1A1A1A', hex) > contrastRatio('#FFFFFF', hex);
    var out = hex;
    for (var i = 1; i <= 40; i++) {
      out = goLighter ? lighten(hex, i * 0.015) : darken(hex, i * 0.015);
      if (bestTextContrast(out) >= min) return out;
    }
    return out;
  }

  /* ---------- normalization ---------- */

  function isValidHex(hex) {
    return hexToRgb(hex) !== null;
  }

  function normalizeBrand(input) {
    var raw = input && typeof input === 'object' ? input : {};
    var radiusNum = Number(raw.radius);
    var preset = typeof raw.preset === 'string' && raw.preset ? raw.preset.slice(0, 40) : 'custom';
    // A palette saved under the pre-white-label id must still highlight the
    // right swatch in Settings.
    if (PRESET_ALIASES[preset]) preset = PRESET_ALIASES[preset];
    return {
      preset: preset,
      primary: isValidHex(raw.primary) ? String(raw.primary).toUpperCase() : DEFAULT_BRAND.primary,
      accent: isValidHex(raw.accent) ? String(raw.accent).toUpperCase() : DEFAULT_BRAND.accent,
      radius: isFinite(radiusNum)
        ? Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Math.round(radiusNum)))
        : DEFAULT_BRAND.radius,
      sidebar: SIDEBAR_IDS.indexOf(raw.sidebar) !== -1 ? raw.sidebar : DEFAULT_BRAND.sidebar,
      appName: typeof raw.appName === 'string' ? raw.appName.trim().slice(0, 60) : '',
      appTagline: typeof raw.appTagline === 'string' ? raw.appTagline.trim().slice(0, 60) : '',
    };
  }

  /* ---------- palette ---------- */

  function sidebarVars(brand, theme, brandFill, accentFill) {
    var primary = brand.primary;
    var accent = brand.accent;
    var style = SIDEBAR_IDS.indexOf(brand.sidebar) !== -1 ? brand.sidebar : 'gradient';
    var dark = theme === 'dark';

    if (style === 'light') {
      return {
        '--sidebar-bg': dark ? '#1B211B' : '#FFFFFF',
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

    var bg;
    if (style === 'solid') {
      bg = darken(primary, 0.10);
    } else if (style === 'deep') {
      bg = 'linear-gradient(180deg, ' + mix(primary, '#000000', 0.80) + ' 0%, ' + mix(primary, '#000000', 0.66) + ' 100%)';
    } else {
      bg = 'linear-gradient(180deg, ' + darken(primary, 0.18) + ' 0%, ' + darken(primary, 0.10) + ' 60%, ' + primary + ' 100%)';
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

  function buildPalette(input, theme) {
    var brand = normalizeBrand(input);
    var dark = theme === 'dark';
    var primary = brand.primary;
    var accent = brand.accent;
    var radius = brand.radius;
    var vars = {};

    var brandFill = ensureFillContrast(dark ? lighten(primary, 0.16) : primary);
    var accentFill = ensureFillContrast(dark ? lighten(accent, 0.10) : accent);
    var surface = dark ? DARK_SURFACE : LIGHT_SURFACE;

    if (dark) {
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
      vars['--brand-ink'] = ensureContrast(primary, surface, 4.5);
      vars['--brand-contrast'] = readableOn(brandFill);
      vars['--shadow-brand'] = withAlpha(primary, 0.28);

      vars['--gold'] = accentFill;
      vars['--gold-light'] = lighten(accent, 0.12);
      vars['--gold-soft'] = mix(accent, '#FFFFFF', 0.88);
      vars['--gold-ink'] = ensureContrast(accent, surface, 3.0);
      vars['--gold-contrast'] = readableOn(accentFill);
    }

    vars['--radius-sm'] = Math.max(3, Math.round(radius * 0.66)) + 'px';
    vars['--radius'] = radius + 'px';
    vars['--radius-lg'] = Math.round(radius * 1.5) + 'px';
    vars['--radius-xl'] = Math.round(radius * 2) + 'px';

    var sb = sidebarVars(brand, theme, brandFill, accentFill);
    for (var k in sb) {
      if (Object.prototype.hasOwnProperty.call(sb, k)) vars[k] = sb[k];
    }
    return vars;
  }

  function applyPalette(input, theme) {
    var vars = buildPalette(input, theme);
    var root = document.documentElement;
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) root.style.setProperty(k, vars[k]);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', vars['--brand-darker'] || vars['--brand']);
    }
    return vars;
  }

  function loadBrandSync() {
    try {
      // readStorage falls back to pre-white-label keys, so an existing install
      // keeps the palette it already chose.
      var raw = CFG.readStorage('brand');
      if (!raw) return null;
      return normalizeBrand(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  /* ---------- identity ----------
     The markup ships the app name, tagline and logo initials empty so that no
     product name is baked into the HTML. Filling them here (rather than in
     shell.js) means the first painted frame is already correct. */

  function initialsOf(name) {
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function applyIdentity(brand) {
    var name = (brand && brand.appName) || CFG.appName || 'Invoice App';
    var tagline = (brand && brand.appTagline) || CFG.tagline || 'Business Invoicing';

    var nameEl = document.getElementById('sidebarBrandName');
    if (nameEl) nameEl.textContent = name;

    var subEl = document.getElementById('sidebarBrandSub');
    if (subEl) subEl.textContent = tagline;

    var logoEl = document.querySelector('#sidebarLogo .logo-fallback');
    if (logoEl) logoEl.textContent = initialsOf(name);

    // "Dashboard" → "Dashboard — <app name>". Idempotent, so the shell can
    // re-run it after the business name loads from IndexedDB.
    var title = document.title || '';
    var sep = title.indexOf(' \u2014 ');
    var page = sep === -1 ? title : title.slice(0, sep);
    if (page && name) document.title = page + ' \u2014 ' + name;

    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', CFG.description || name);
  }

  /* ---------- boot ---------- */

  function boot() {
    var theme = 'light';
    try {
      if (CFG.readStorage('theme') === 'dark') theme = 'dark';
    } catch (e) { /* storage blocked */ }

    // Set the theme before paint so dark-mode users never see a white flash.
    document.documentElement.setAttribute('data-theme', theme);

    var brand = loadBrandSync();
    if (brand) applyPalette(brand, theme);
    applyIdentity(brand);
  }

  var CFG = window.AppConfig || {
    // Defensive fallback: if app.config.js is missing the app still boots with
    // neutral defaults rather than throwing before first paint.
    appName: 'Invoice App',
    tagline: 'Business Invoicing',
    description: 'Offline invoicing and business management.',
    readStorage: function (n) {
      try { return localStorage.getItem('sip_' + n); } catch (e) { return null; }
    },
  };

  window.BrandBoot = {
    DEFAULT_BRAND: DEFAULT_BRAND,
    buildPalette: buildPalette,
    applyPalette: applyPalette,
    applyIdentity: applyIdentity,
    normalizeBrand: normalizeBrand,
    loadBrandSync: loadBrandSync,
    boot: boot,
  };

  boot();
})();
