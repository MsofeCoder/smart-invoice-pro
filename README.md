# Smart Invoice Pro — White-Label Offline Invoicing PWA

A **production-ready, 100% offline Progressive Web App** for professional invoicing and business management, built for **Tanzanian SMEs** (and usable worldwide). Create invoices for products and services — including agricultural products such as cashew nuts — that look as professional as Zoho, QuickBooks, Odoo, FreshBooks, Wave and Xero, without any backend, any build step, or any internet connection.

It is a **white-label template**: no product name, logo, colour or tagline is baked into the source. Everything a business owner needs to make the app *theirs* lives in one config file plus a Settings panel — no rebuild, no designer, no code.

---

## ✨ Features

### Core
- **Dashboard** — Today's sales, monthly sales, pending payments, paid invoices, revenue, outstanding balances, customer/product counts, quick actions, recent invoices, sales chart & status donut
- **Invoice Generator** — Company header, bill-to/ship-to, invoice number, issue & due dates, payment terms, status, line items, discounts (per-item & whole-invoice, % or fixed), tax (VAT / custom / withholding / none), shipping, grand total, **amount in words**, QR code, signature & stamp block, notes & footer
- **Customers** — Full database with name, phone, email, TIN, address, purchase history, outstanding balance, notes; search, filter, edit, delete, CSV export
- **Products** — Name, description, SKU, barcode, category, unit, cost price, selling price, tax, discount, stock, low-stock alerts, image, status; search, filter, edit, delete, CSV export
- **Reports** — Daily / weekly / monthly / yearly: revenue, profit, outstanding, top customers, top products, invoice status donut; Export PDF, Export CSV, Print

### White-label configuration
Every business can make the app *theirs* — no code, no rebuild, no designer.
- **12 one-click presets** — Signature Green, Ocean, Midnight, Royal, Indigo, Teal, Emerald, Forest, Crimson, Rose, Sunset, Slate
- **Custom brand colours** — pick any primary + accent with a colour picker or type a hex code (invalid input is rejected and reverted)
- **4 sidebar treatments** — gradient, solid, deep, light
- **Corner radius slider** (0–24px) that retunes the entire interface
- **White-label identity** — set the app name and tagline; they flow into the sidebar, the browser tab, the logo initials and the live preview. Leave them blank to fall back to the business name.
- **Live preview + contrast checker** — see the palette applied instantly, with WCAG AA/AAA ratings for brand text, button fills and sidebar navigation
- **Automatic contrast correction** — mid-tone brand colours that would fail AA against both white and black text are nudged to the nearest passing shade, so a client can pick *any* colour and never end up with unreadable text
- **Theme-aware** — the palette is re-derived for light and dark mode, so a brand colour works in both
- **Enterprise dark theme** — a Linear/Stripe-inspired slate layer: near-black canvas, two raised surfaces, hairline white borders, a three-step text ramp, translucent status pills and a brand-matched focus glow. Light mode is provably untouched (see [Design tokens & the dark theme](#-design-tokens--the-dark-theme))
- **Flash-free** — applied before first paint by a render-blocking script, so there is no default-colour flicker on load
- **Carries through everything** — PDF invoices, printed reports, QR codes and the app icons all use the business's colours

### Subscription tiers & payments
- **Three plans** (`free` / `pro` / `enterprise`) defined in config, with per-plan feature lists and limits
- **Free tier cap** — 10 invoices per calendar month, counted from the invoice records themselves rather than a stored counter (a counter drifts on retry, restore or clock change)
- **Upgrade modal** that fires the moment a limit is reached, showing exactly what the plan allows and what Pro adds
- **Licence keys** — `SIP-<PLAN>-<YYYYMMDD>-<CHECKSUM>`, verified offline
- **Payment gateway hooks** — AzamPay and Selcom stubbed with M-Pesa / Tigo Pesa / Airtel Money / HaloPesa method lists, sandbox mode, and a clear warning never to place live API secrets in a browser

> **Honest by design.** The free-tier gate is a client-side business nudge, not a security boundary — anyone can edit local storage. The licence checksum catches typos, not forgery. Gate something that matters on a server.

### Financial engine
- Exact **2-decimal decimal arithmetic** using integer-based rounding — floating-point errors are eliminated
- Formulas: `Subtotal = Σ(Qty × Unit Price)`; `Tax = Subtotal × TaxRate`; `Grand Total = Subtotal + Tax + Shipping − Discount`; `Balance = Grand Total − Amount Paid`
- Partial payments automatically recompute status (unpaid / partial / paid)
- **Currency engine**: TZS, USD, EUR, KES, GBP + unlimited custom currencies; editable offline exchange rates; instant currency switching
- **Number-to-words** in English *and* Kiswahili (e.g. *"One Hundred Twenty Thousand Tanzanian Shillings Only"*)

### Export, print & share
- **Professional A4 PDF** (jsPDF + AutoTable): logo stacked beneath the business name, digital signature & company stamp block, QR code, automatic pagination, branded header/footer, selectable text, print-ready
- **Uniform layout across devices** — the PDF is built from fixed millimetre geometry, not screen pixels, so a 320px phone and a 4K desktop produce byte-identical output
- **WhatsApp sharing** — one button on the invoice preview. Prefers the native share sheet with the PDF attached; falls back to a `wa.me` deep link that works on WhatsApp Web, Desktop and mobile; falls back again to copying the message. Phone numbers are normalised (`+255…`, `00255…`, `0712345678` and bare national numbers all work).
- **Print** from a clean invoice view (no browser chrome)
- **CSV export** for invoices, customers, products & reports
- **QR Code** containing: invoice number, business name, grand total, currency, payment reference, website, WhatsApp

### Mobile-first & responsive
- **Mobile-first CSS** — the base stylesheet targets the phone; `min-width` blocks add capability as the viewport grows, so nothing is ever "un-done" by an override
- **Works from 320px up** — no horizontal scrolling, no clipped figures, no crushed cards on any page at any width
- **Phone chrome** — off-canvas sidebar drawer with backdrop, bottom tab bar, FAB that clears the bar
- **Tablet chrome** — bottom bar retires, hamburger drawer takes over, 2–3 up grids
- **Desktop chrome** — sidebar docks, 12-column grid with real spans, full navigation
- **Charts adapt** — bar charts own their own overflow: the columns get a density-driven width (normal → dense → ultra) and the track scrolls internally rather than crushing its labels or pushing the page sideways. The donut legend wraps below the chart

### Offline & PWA
- **Service worker** precaches the entire app shell — works **100% offline** after the first visit
- **Clean updates, no cache locks** — `sw.js` is never cached, `updateViaCache: 'none'` bypasses the HTTP cache for the worker itself, `skipWaiting()` + `clients.claim()` activate a new version immediately, and the page reloads exactly once on `controllerchange` (guarded by a flag, so there is no reload loop)
- **Owned-cache sweep** — `activate` deletes only caches matching this app's prefixes, so two apps on the same origin cannot wipe each other
- **manifest.json** with splash screen, app icons (192/512 + maskable), install button, home-screen shortcut, standalone full-screen mode
- Works on **Windows, Linux, macOS, Android, iPhone, tablets** and desktop browsers

### Storage & sync
- **`storageService.js`** — one pluggable adapter interface over IndexedDB
- **Local-first** — every read comes from the on-device cache, so the app is fully functional with no network
- **Writes are local-first, then queued** — `pushPending()` is the single point where data leaves the device
- **Adapter stubs** for Supabase, Firebase and a generic REST backend, each with a documented contract, so a backend can be dropped in without touching a single feature module
- **Migration-safe** — renaming the database would have stranded existing users' invoices, so first boot detects the old database and old `localStorage` prefix and migrates them

### Security & accessibility
- **XSS-safe**: all output is HTML-escaped; all input sanitized
- **IndexedDB** used safely with transactional, promise-based wrappers
- WCAG AA-friendly: every form control has an accessible name, keyboard navigation throughout, ARIA radio-group semantics on the brand pickers, contrast-checked palettes, `prefers-reduced-motion` support
- **Responsive down to 320px** — no page ever scrolls sideways, and no figure, label or card is ever clipped or crushed (verified across 10 widths × 6 pages)

---

## 📁 Project structure

```
invoice-generator/
├── index.html              # Dashboard
├── invoice.html            # Invoice list + editor + preview
├── customers.html          # Customer management
├── products.html           # Product & inventory management
├── reports.html            # Business reports
├── settings.html           # Business profile, brand, plans, data tools
├── css/
│   └── styles.css          # Complete design system (utilities, dark mode, mobile-first)
├── js/
│   ├── app.config.js       # ★ ALL defaults: identity, plans, gateways, sync, PDF  (classic script)
│   ├── config.js           # ES-module surface over app.config.js (resilient)
│   ├── brand-boot.js       # Pre-paint brand + identity applier (classic script, no flash)
│   ├── brand.js            # Brand engine (colour math, presets, palettes, contrast)
│   ├── storageService.js   # ★ Pluggable storage: local / Supabase / Firebase / REST
│   ├── licenseService.js   # ★ Plans, quota, licence keys, upgrade modal
│   ├── share.js            # ★ WhatsApp deep links, native share, phone normalisation
│   ├── db.js               # IndexedDB layer + legacy-database migration
│   ├── shell.js            # Shared shell (theme, nav, PWA, identity, currency)
│   ├── app.js              # Dashboard logic
│   ├── invoice.js          # Invoice module
│   ├── customer.js         # Customer module
│   ├── product.js          # Product module
│   ├── report.js           # Report module
│   ├── settings.js         # Settings module (brand, subscription, gateways)
│   ├── currency.js         # Currency + number-to-words engine
│   ├── calculations.js     # Exact financial math engine
│   ├── export.js           # PDF / print / QR / CSV engine
│   └── utils.js            # Shared utilities (sanitize, escape, modal, toast)
├── assets/
│   ├── logo.png            # Neutral default mark (replaceable in Settings)
│   └── icons/              # PWA icons (192, 512, maskable, apple-touch, favicon)
├── libs/                   # Vendored libraries (offline)
│   ├── jspdf.umd.min.js
│   ├── jspdf.plugin.autotable.min.js
│   └── qrcode.min.js
├── scripts/
│   ├── serve.js            # Zero-dependency static server
│   ├── e2e.js              # E2E launcher (boots server + browser)
│   ├── generate-icons.js   # Icon generator (Node built-ins only)
│   ├── test-core.js        # Financial engine
│   ├── test-utils.js       # Utilities
│   ├── test-brand.js       # Theming engine, contrast, brand-boot parity
│   ├── test-config.js      # Config shape, storage keys, white-label guard
│   ├── test-license.js     # Plans, quota, licence keys, phone/message helpers
│   ├── test-assets.js      # Icon decoding, alpha coverage, palette
│   ├── test-markup.js      # Markup / CSS / SW / a11y contracts
│   ├── test-e2e.js         # Browser end-to-end (CDP)
│   ├── test-a11y.js        # Keyboard + screen-reader (CDP)
│   ├── test-polish.js      # Interaction polish + reduced-motion (CDP)
│   ├── test-responsive.js  # Mobile-first sweep across pages × widths (CDP)
│   ├── screenshots.js      # Brand showcase screenshots
│   └── lib/cdp.js          # Shared DevTools Protocol client
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (offline cache)
└── README.md
```

---

## 🚀 Getting started

### Option A — No install needed

Open **`index.html`** directly in any modern browser (Chrome, Edge, Firefox, Safari). All data is stored locally in IndexedDB.

> ⚠️ For the **best PWA experience (install + offline)**, serve the folder over HTTP — see Option B. Service workers require a server context.

### Option B — Run locally with a static server

```bash
# Zero-dependency server (no install required)
npm run serve

# or specify a port
node scripts/serve.js 3000
```

Then open `http://127.0.0.1:8080`.

> The bundled server uses only Node built-ins, so it works offline and never needs a network install. `sw.js` is served `no-cache` so clients always pick up new versions.

### Install as an app

1. Open the app in Chrome / Edge / Android Chrome.
2. Click the **Install App** card in the sidebar (or the browser's install icon).
3. The app installs as a standalone, full-screen, offline-first app on desktop and mobile.

> On Android, Chrome will prompt "Add to Home screen". On iOS Safari, use **Share → Add to Home Screen**.

---

## 🧰 How to use

1. **Settings** → enter your business info, upload your logo, digital signature and company stamp, set your currency, tax rate and invoice numbering.
2. **Products** → add the products/services you sell (prices, tax, stock).
3. **Customers** → add your customers.
4. **Invoices** → click **New Invoice**, select a customer, add line items, adjust discounts/tax/shipping, save, preview, print, download the PDF or send it on WhatsApp.
5. **Record Payment** → against any saved invoice via the editor or the invoice row (M-Pesa, Bank, Cash, etc.).
6. **Reports** → switch Daily/Weekly/Monthly/Yearly, then Export PDF/CSV or Print.
7. **Settings → Backup Data** → download a JSON backup regularly. **Restore Backup** brings it back.

### Keyboard shortcuts
- `Ctrl/Cmd + N` → New Invoice
- `←` `→` → move between brand presets / sidebar styles once focused

---

## 🎨 White-labelling the app

### In the app (no code)

Everything lives in **Settings → Brand & Appearance** and saves automatically.

1. **Pick a starting point** — click any of the 12 presets, or set **Primary** and **Accent** yourself with the pickers (or type a hex code).
2. **Choose a sidebar style** — gradient, solid, deep or light.
3. **Set the corner radius** — drag from sharp (0px) to soft (24px).
4. **Rename the app** — set **App Name** and **App Tagline**; leave them blank to fall back to your business name.
5. **Check the contrast readout** — four WCAG ratings update live.
6. **Reset to Default** restores the shipped palette at any time.

Your palette is stored in IndexedDB and mirrored to `localStorage`, and a small pre-paint script applies it before the first frame — so the app never flashes the default colours on load. Invoices, PDFs, printed reports and QR codes all inherit the brand automatically.

### In the source (rebranding the template for a client)

Edit **`js/app.config.js`** — it is the single source of every default a fresh install starts from. Nothing else needs to change.

```js
appName: 'Acme Invoicing',                    // shown in the sidebar and <title>
shortName: 'Acme',                            // home-screen label
tagline: 'Business Invoicing & Management',
slug: 'acme-invoicing',                       // PWA id, cache prefix, backup filenames
defaultCurrency: 'TZS',
defaultTaxRate: 18,
allowWhiteLabel: true,                        // false hides and locks the brand panel
storagePrefix: 'acme_',                       // localStorage key prefix
dbName: 'acme-invoicing',
legacyDbNames: ['crown-invoice-pro'],         // databases to migrate FROM on first boot
legacyStoragePrefixes: ['crown_'],            // key prefixes to migrate away from
plans: { /* free / pro / enterprise */ },
paymentGateways: [ /* azampay, selcom */ ],
whatsapp: { countryCode: '255', defaultMessage: '…' },
pdf: { pageSize: 'a4', orientation: 'portrait', unit: 'mm', margin: 14, logoSize: 22 },
```

Then:

```bash
# Rebrand the app icons for the client's colours/mark
node scripts/generate-icons.js     # or edit drawMarkIcon() first

# Prove no vendor branding survived
npm run test:config
```

**Why a classic script and not JSON?** `brand-boot.js` has to run *before first paint* to avoid a colour flash, and a `fetch()` of a JSON file is asynchronous — and blocked entirely under `file://`. A classic script is synchronous, so the defaults are available immediately. `js/config.js` is the ES-module surface over it, and it is deliberately resilient: if `app.config.js` is missing, modules fall back to neutral defaults instead of white-screening an offline app. `test-config.js` asserts the script tag is present and ordered correctly on every page.

**Precedence:** anything a business owner saves in Settings always wins. `app.config.js` only decides what a *fresh* install looks like.

**What is still hardcoded, and why:** the old database name and `localStorage` prefix survive as `legacyDbNames` / `legacyStoragePrefixes`, and the old preset id survives in `PRESET_ALIASES`. These are migration aliases, not branding — removing them would strand every existing user's invoices and theme. `test-config.js` enforces that these are the *only* places the old name may appear.

---

## 🎨 Brand and design system

Smart Invoice Pro ships with its own identity, and it is deliberately **separate from your business's brand**. The app's mark (the green tile, the folded gold corner, the check) never appears on an invoice in place of your logo — see [Two brands, one invoice](#two-brands-one-invoice) below.

### The mark

**"The Check-Invoice mark"** — a document with a folded gold corner and a bold check, on a green tile. The master is `assets/brand/logo-mark.svg` (viewBox `0 0 96 96`), and every raster icon in `assets/icons/` is generated from the same geometry by `scripts/generate-icons.js` (Node built-ins only — no image library, no build step).

| File | Purpose |
|---|---|
| `assets/brand/logo-mark.svg` | The mark alone — square, for icons and avatars |
| `assets/brand/logo-horizontal.svg` | Mark + "Smart Invoice" wordmark + gold `PRO` pill |
| `assets/brand/logo-horizontal-dark.svg` | Same lockup with the wordmark in `#EAF3EC` for dark surfaces |
| `assets/brand/logo-mono.svg` | Single-colour via `currentColor` + a mask — inherits whatever it is placed on |
| `assets/brand/favicon.svg` (and root `favicon.svg`) | Mark minus the two hairline rules, heavier check, for 16px |

Regenerate every PNG/ICO after editing the mark or the palette:

```bash
npm run icons
```

### The palette

The identity ramp is fixed and **not** affected by the white-label setting — a client's palette re-themes the *interface*, but the app logo always keeps these greens.

```css
--brand-900:#0F3D14;  --brand-700:#1B5E20;  --brand-500:#43A047;
--brand-200:#A5D6A7;  --brand-100:#C8E6C9;  --brand-50:#E8F5E9;
--spark:#FFC107;      --spark-100:#FFECB3;  --spark-900:#5D4300;
--ink:#0F1F14;  --ink-2:#4C5F52;  --line:#D5E2D6;  --surface:#FFFFFF;  --bg:#F4F8F4;
--danger:#B3261E;  --danger-100:#FFCDD2;  --danger-900:#7A1414;
--radius-sm:8px;  --radius:12px;  --radius-lg:16px;
--shadow-1:0 1px 2px rgba(15,31,20,.06);  --shadow-2:0 4px 16px rgba(15,31,20,.08);
```

The white-label brand tokens (`--brand`, `--gold`, `--sidebar-*`) are computed from the client's two colours by `js/brand.js` and written **inline on `<html>`** before first paint. `:root` carries the same values as a fallback for the (rare) case where the engine never runs; `scripts/test-brand.js` asserts the stylesheet and the engine agree, so the two can never drift.

In dark mode the `--brand-700` step lifts to `#43A047` so it still reads as a link colour on the deep canvas; the mark and the icon backgrounds keep the true `#1B5E20`.

### Typography

Two self-hosted **variable** woff2 files, Latin-subset, declared with `@font-face` at the top of `css/styles.css`:

| Face | Role | Weights |
|---|---|---|
| Plus Jakarta Sans | Headings, brand lockup, big numbers, page titles | 200–800 |
| Inter | Body, tables, forms | 100–900 |

One file per family covers every weight, so a cold load costs two requests and nothing is fetched from a third-party origin — the app stays fully offline-capable. `font-display: swap` paints text immediately in the fallback stack and re-renders when the face arrives, so a slow first load never shows invisible text. Both families fall back to the platform UI stack (`Segoe UI, system-ui, …`) if the woff2 fails to load.

All money figures and numeric table columns are set with `font-variant-numeric: tabular-nums`, so a column of totals aligns on the decimal and a value does not jitter as it updates.

### Two brands, one invoice

This is the one rule that must never be broken:

- **The app brand** (the Check-Invoice mark) lives in the app chrome — the sidebar lockup, the favicon, the PWA icon, the splash.
- **Your business brand** (your logo, name, TIN, signature and stamp) lives on the invoice and the PDF.

`js/invoice.js` / `js/export.js` render *your* logo and *your* signature/stamp. Replacing either with the app mark would put Smart Invoice Pro's branding on a document you send to your customer, which is exactly what the white-label setting exists to prevent. The optional "Made with Smart Invoice Pro" footer is **off by default** and is the only place the app name may appear on a printed invoice.

### Contrast

Every preset is checked for WCAG AA on both themes before it ships — `scripts/test-brand.js` sweeps all 12 presets × 2 themes and fails on any text/fill pair below 4.5:1, including the sidebar's active row. A brand colour that cannot carry readable text is nudged along the lightness axis until it can (`ensureFillContrast`), so a client can never pick a palette that produces an unreadable button.

---

## 🌗 Design tokens & the dark theme

Dark mode is a **deep-forest layer** on top of the same stylesheet, not a second theme: a green-tinted near-black canvas that sits in the same colour family as the light neutrals. It is built in two tiers, both in `css/styles.css`.

### Tier 1 — the token blocks (section 1)

`:root` declares an enterprise scale; `[data-theme="dark"]` re-points it and then **aliases the legacy tokens onto it**:

```css
/* :root — light values reproduce the legacy tokens exactly */
--bg-canvas: #F4F8F4;  --bg-surface: #FFFFFF;  --bg-elevated: #FFFFFF;  --bg-hover: #EDF3EE;
--border-subtle: #D5E2D6;  --border-medium: #B9CDBB;
--text-primary: #0F1F14;  --text-secondary: #4C5F52;  --text-tertiary: #7C8F82;

/* [data-theme="dark"] — a deep canvas, two raised surfaces, quiet green hairlines */
--bg-canvas: #0B1610;  --bg-surface: #12231A;  --bg-elevated: #182C20;  --bg-hover: #22382A;
--border-subtle: #233A2B;  --border-medium: #2F4A38;
--text-primary: #EAF3EC;  --text-secondary: #9DB2A3;  --text-tertiary: #6E8474;

/* …then the one block that makes ~1200 lines of component CSS adopt it */
--bg: var(--bg-canvas);      --surface: var(--bg-surface);  --surface-2: var(--bg-elevated);
--border: var(--border-subtle);  --border-strong: var(--border-medium);
--ink: var(--text-primary);  --ink-soft: var(--text-secondary);  --ink-faint: var(--text-tertiary);
```

Because the legacy names survive as aliases, **no component rule had to change** to adopt the new palette — and any component written later keeps working either way. `--surface-2` intentionally maps to `--bg-elevated` (not `--bg-hover`): a panel that reads as *recessed* on white has to step *up* to be visible on a near-black canvas.

The canonical neutral names `--ink-2` and `--line` are declared alongside `--ink-soft` and `--border` and carry the same values, so a component may use either name. `--line` is re-pointed to `#233A2B` in dark.

Two tokens are **derived from the brand** rather than hardcoded, so a client's palette drives them:

```css
--border-focus: color-mix(in srgb, var(--brand) 60%, transparent);
--accent-glow:  color-mix(in srgb, var(--brand) 25%, transparent);
```

The reference spec calls for a fixed indigo (`rgba(99,102,241,.6)`). If a deployment wants that exact look rather than a brand-matched ring, replace those two lines — that is the whole change.

### Tier 2 — component treatments (section 25)

Everything that needed a *different material* in dark, scoped so it cannot touch light mode:

| Component | Dark treatment |
|---|---|
| Topbar / bottom nav | `backdrop-filter: blur(12px)` over `rgba(18,35,26,.75)` with a hairline bottom/top seam |
| Sidebar | Blur + a `--border-subtle` right seam (its fill stays brand-owned — see below) |
| Cards | 12px corners, `--border-subtle` seam, `--bg-surface` |
| Tables | Hairline rows, a raised `--bg-elevated` head, neutral `--bg-hover` row hover |
| Primary buttons | `inset 0 1px 0 rgba(255,255,255,.2)` sheen + a `--accent-glow` ring on hover/focus |
| Badges | Translucent status pills (Paid/Unpaid/Partial/Overdue) instead of solid pale fills |
| Inputs | Recessed well on `--bg-elevated`, `--border-focus` + `--accent-glow` focus ring |
| Modal / toast / menu | `--bg-elevated` so they clear the canvas, plus a hairline |

**Why the sidebar keeps its brand fill:** `js/brand.js` writes `--sidebar-bg` *inline* on `<html>` for all four sidebar styles, and an inline custom property outranks every selector. A dark rule therefore cannot repaint it — and overriding the `background` *property* instead would silently discard the client's Gradient / Solid / Deep / Light choice. So the dark theme adds only the glass material (blur, seam, top highlight) and leaves the fill to the brand engine. The **Light** sidebar style already resolves to a raised surface in dark mode.

**Want an opaque sidebar anyway?** Override the property, not the token — and accept that it discards the client's sidebar choice while dark mode is active:

```css
[data-theme="dark"] .sidebar {
  background: rgba(18, 35, 26, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
```

**Status pills** are driven by nine tokens so the two themes can differ in kind, not just in shade:

| Token pair | Light | Dark |
|---|---|---|
| `--badge-paid-*` | `--success-soft` solid | `rgba(16,185,129,.12)` + `#34D399` + a `25%` ring |
| `--badge-unpaid-*` | `--warning-soft` solid | `rgba(245,158,11,.12)` + `#FBBF24` |
| `--badge-partial-*` | `--gold-soft` solid | `rgba(56,189,248,.12)` + `#38BDF8` |
| `--badge-overdue-*` | `--danger-soft` solid | `rgba(244,63,94,.12)` + `#FB7185` |

### Printing from dark mode

Printing is paper, so dark mode is forced back to the light palette for the duration of a print job. It takes two halves, because the two token families live in different places:

1. **Structural tokens** (`--bg-*`, `--text-*`, `--border-*`, and the legacy aliases) are reset to their light values by a `:root` block inside `@media print`. That block sits after `[data-theme="dark"]` at equal specificity, so it wins for the print media only.
2. **Brand tokens** cannot be reached from CSS at all — `js/brand.js` writes `--brand*` / `--gold*` **inline on `<html>`**, and an inline custom property outranks every selector. So `js/shell.js` listens for `beforeprint` / `afterprint` and re-derives the light palette, then restores the on-screen one. Without this, the dark theme's lightened brand (chosen to stay visible on a near-black canvas) would print too pale to read on white.

> **Bug this fixed:** before the refactor, printing an invoice from dark mode produced `#F8FAFC` text on a `#1B211B` block on a white page — the invoice body was unprintable. The PDF/print *export* path (`js/export.js` → `printInvoice`) was already safe, because it opens its own window with `paletteToCss(…, 'light')` forced; only the `window.print()` fallback and Ctrl/Cmd+P on a page were affected.

### Guarantees

Light mode is **provably unchanged**. A computed-style capture of 6 pages × 52 tokens × 29 selectors was taken before and after the refactor and diffed: the only differences are the 21 new tokens going from unset to a value — **zero** changes to any element property or legacy token.

`test-markup.js` locks the contract statically (19 checks):

- all 24 enterprise tokens are declared in **both** blocks
- all 8 legacy tokens are re-declared in dark, each as an **alias** (`var(--…)`) and never a literal
- the light block keeps **literal** legacy values — it must not alias
- the light scale **mirrors the legacy values exactly** (so adding it changed nothing)
- every `var()` in the dark block resolves to a declared token
- enterprise tokens are **consumed only** under `[data-theme="dark"]` — an unscoped consumer would leak slate into light mode
- the 16 component treatments and 6 status pills are present, and the pill fills are translucent
- the print block resets the structural scale, does **not** pin the brand, and `shell.js` wires the `beforeprint` swap

`test-e2e.js` adds the runtime half: it emulates print media in dark mode and asserts a white invoice background with dark text, then fires `beforeprint` / `afterprint` and asserts the brand palette swaps to `#1B5E20` and back.

---

## 🔌 Storage & cloud sync

`js/storageService.js` is the single storage interface for the whole app. Feature modules never touch IndexedDB directly.

```js
import { initStorage, getInvoices, saveInvoice, configure } from './storageService.js';

await initStorage();                       // local-only by default
await saveInvoice(invoice);                // writes to the local cache, then queues
await configure({ adapter: 'supabase', endpoint, apiKey });
```

| Adapter | Status | Notes |
|---|---|---|
| `local` | **Production** | IndexedDB via `db.js`. Works offline, forever. The default. |
| `rest` | Stub, contract documented | `GET/PUT/POST/DELETE {endpoint}/{store}[/{key}]`, `GET/PATCH {endpoint}/settings` |
| `supabase` | Stub | Row-per-record mirror of the same contract |
| `firebase` | Stub | Collection-per-store mirror |

**Design rules**

- Reads always come from the local cache, so the UI never waits on a network.
- Writes are local-first, then appended to a `syncQueue` store.
- `pushPending()` is the only function that talks to a remote, which keeps conflict handling in one place.
- `configure()` falls back to `local` and emits an `adapter-fallback` event if a cloud adapter throws — a bad endpoint must not brick the app.

---

## 💳 Plans & payment gateways

Plans, limits and gateway metadata all live in `js/app.config.js`; the behaviour lives in `js/licenseService.js`.

- **Free** — 10 invoices/month, 25 customers, 25 products
- **Pro** — unlimited invoices, brand customisation, no watermark
- **Enterprise** — multi-user, multi-branch, cloud sync, API access

The quota is **derived**, not stored: `evaluateQuota()` counts invoice records in the current calendar month. A stored counter drifts the moment a save is retried, a backup is restored, or the device clock moves.

Payment gateways (**AzamPay**, **Selcom**) are declared with their mobile-money method lists, sandbox mode and docs links, and rendered in **Settings → Payments**. They ship disabled — wire them to a server-side endpoint before enabling.

> ⚠️ **Never put live gateway API secrets in this app.** Everything here runs in the browser, where any user can read it. Gateway credentials belong on a server that your app calls.

---

## 📱 Responsive & mobile-first

The stylesheet is written **mobile-first**: the base layer is the phone layout, and every larger viewport is served by a `min-width` block that *adds* capability. There are no `max-width` overrides that un-do desktop work, so the two layers can never fight each other.

| Breakpoint | Layout |
|---|---|
| `< 481px` | phone — single column, off-canvas sidebar, bottom tab bar |
| `≥ 481px` | large phone — 2-up stat grids, roomier padding |
| `≥ 769px` | tablet — bottom bar retires, hamburger drawer, 2–3 up grids |
| `≥ 1024px` | desktop — sidebar docks, 12-column grid with real spans |
| `≥ 1280px` | wide desktop — 4- and 6-up grids (the sidebar costs 264px, so they wait) |
| `≥ 1441px` | large desktop — wider gutters |

Three rules make it hold:

1. **Every grid collapses at base.** `.grid-cols-12` and friends resolve to a single column until a `min-width` block turns them on, and every `.col-span-N` is `grid-column: auto` until then. Leaving a 12-column grid un-collapsed was the worst bug this app shipped: each child carries `col-span-N`, which resolved to `span 1` of 12 and crushed a chart card to **9px** on a 320px phone.
2. **Every flexible track is `minmax(0, 1fr)`.** Bare `1fr` means `minmax(auto, 1fr)`, and that *auto* minimum is min-content — so one wide child (a 640px table) forces the track, and the page, wider than the screen.
3. **Flex children get `min-width: 0`.** Without it a toolbar's button cluster refuses to shrink below the sum of its buttons and pushes the page sideways.
4. **Grid items get `min-width: 0` too.** Collapsing the track to `minmax(0, 1fr)` is only half the contract: a grid item's automatic minimum is *its own* min-content size, so `.grid > * { min-width: 0 }` is what actually lets a chart card be narrower than its widest bar column. Without it the card stretches the track and drags the whole page right.

The dashboard's Sales Overview chart is the case that exposed rule 4. `.chart-bar` used to be `overflow-x: visible` above 768px, so 30 and 90 days of bars — each as wide as its `TZS 1,662,930.00` label — made the card's min-content width thousands of pixels. The card then overflowed its `col-span-8` column and overlapped the Invoice Status card beside it, and the page grew a horizontal scrollbar. The fix has two halves: the chart now owns its overflow at **every** width (`width/max-width: 100%`, `min-width: 0`, `overflow-x: auto`, `overscroll-behavior-x: contain`) with a `data-density` attribute driving the column width (`--bar-w`: unset → `40px` → `32px` for normal/dense/ultra, labels hidden once a column can no longer hold them), and `.content` gained `overflow-x: clip` — *clip*, not `hidden`, because `clip` does not create a scroll container and so cannot break `position: sticky` or scroll-into-view.

Column counts ramp with the width actually available, not just the viewport: docking the sidebar removes 264px, so the 4-up stat grid waits until 1280px rather than squeezing `TZS 1,662,930.00` below its own text width.

Verified by `scripts/test-responsive.js`, which sweeps **10 widths × 6 pages** and fails on page overflow, crushed grids, clipped text and chart-label collisions — then sweeps the dashboard's **7/30/90-day chart ranges × 4 widths (375/768/1024/1440px)**, asserting page overflow ≤ 1px, zero Sales-Overview/Invoice-Status overlap, no bar-label collisions, the right bar count and the right `data-density` — plus the static contract in `test-markup.js` that catches an un-collapsed grid without needing a browser.

---

## 🧪 Testing

Everything runs on Node built-ins plus a headless Chrome — no test framework to install.

```bash
npm test          # 708 static checks: engine, utils, theming, config, plans, icons, markup
npm run test:e2e  # 492 browser checks: journeys, a11y, polish, responsive sweep, platform, charts, preview
npm run test:all  # both — 1200 checks
```

| Command | What it covers |
|---|---|
| `npm test` | Financial math, XSS escaping, colour math, brand-boot parity across 242 brand configurations, WCAG AA across all presets, config shape, storage-key semantics, white-label guard, quota arithmetic, licence keys, phone normalisation, icon decoding, CSS/markup contracts, the mobile-first grid contract, the dark-theme token contract, service-worker precache integrity, accessible names |
| `npm run test:e2e` | Every page loads clean; brand apply/persist/reset; flash-free first paint; dark mode; customer & product CRUD; invoice creation with verified totals; the free-tier cap and upgrade modal; reports; PDF/CSV/QR export (asserts the `%PDF` magic bytes); **invoice branding — the business logo and name must reach the preview, the footer and the embedded PDF, and a non-PNG logo upload must be normalised**; **invoice layout regressions — line-item inputs must not clip, the logo must stack beneath the business name, the Bill To / Ship To panel must grow around its contents so the TIN never spills, and the uploaded signature and stamp must reach both the preview and the PDF**; WhatsApp link construction; backup/restore; currency switching; genuine offline mode |
| `npm run test:a11y` | Radio-group semantics, roving tabindex, arrow-key navigation (including wrap-around), accessible names for every control, keyboard reachability with a custom palette |
| `npm run test:polish` | Button shine sweep and hover lift, ripple creation + its stacking order, the loading-state contract, recessed switch, custom checkbox, tooltips, and that `prefers-reduced-motion` genuinely neutralises the motion |
| `npm run test:responsive` | Sweeps 10 widths (320→1600px) × 6 pages, failing on page overflow, crushed grids, clipped text and chart-label collisions — then the dashboard chart ranges (7/30/90 days × 375/768/1024/1440px) for overflow, card overlap, label collisions and `data-density` — then asserts the chrome contract (bottom nav → hamburger drawer → docked sidebar) |
| `npm run test:charts` | The donut and the bar chart. Geometry (the bar band, the gridline band and the y-axis band must be the *same* box — when they drift every bar is silently short by the x-axis label height); encoding (bar height == value / axis max, so a plausible-looking but non-proportional chart fails); the ledger (every bucket against an independently recomputed daily total, and the donut's per-status counts and amounts against the invoice records); the tallest bar's value label not being clipped by the scroll container; `role="img"` + a generated summary + a visually-hidden data table that matches what was drawn; the entrance animation (bars start collapsed, land at full scale, 60ms stagger) and that `prefers-reduced-motion` writes the final state with no animation armed; both empty states; and zero cross-origin requests, so a CDN chart library cannot creep back in |
| `npm run test:platform` | Storage adapter contract (including that a failed cloud switch falls back to local), the free-tier gate and upgrade modal, licence activation/persistence/reset, payment-gateway rendering, the WhatsApp share path and its popup-blocked fallback, runtime white-label identity, and the service-worker offline cache |
| `npm run test:config` | `app.config.js` shape, storage-key prefixing and legacy fallback, plan/gateway declarations, script load order, and the white-label guard |
| `npm run test:license` | Month keys, quota evaluation (free/pro/unknown plans), licence-key round-trip and rejection, phone normalisation, message templating, `wa.me` URLs |
| `npm run test:assets` | Decodes every generated PNG and asserts dimensions, alpha coverage, corner rounding, full-bleed maskable variants and palette, the maskable safe zone (the mark must stay inside the 80% circle), the five brand SVG sources, and the multi-resolution `favicon.ico` — this is the guard that caught every icon shipping fully transparent |
| `npm run test:unit` / `test:brand` / `test:markup` | Individual suites (`test:markup` owns the mobile-first grid contract, the dark-theme token contract, the PWA head wiring on all 6 pages, the self-hosted-font/offline contract, the identity ramp, and the service-worker precache list) |
| `npm run test:preview` | The preview panel's actions and the PDF's pagination. **Download PDF / Print / WhatsApp must work when the preview was opened from the list's eye icon** — they act on the invoice being shown, not on the editor form (which is untouched on that path, so re-collecting from it produced a nameless invoice and the click was a silent no-op); Print must render the real document; Edit must load *that* invoice into the form, while a preview opened **from** the editor must not throw unsaved edits away; and a normal invoice must stay on **one page** — a 5- and a 6-line invoice with a full letterhead, four payment lines, notes and logo/signature/stamp/QR artwork, while a 16-line invoice still paginates |
| `npm run test:live` | **Post-deploy check against the real Pages URL.** Charts render and animate in production, the service worker is on the expected cache version and reaps old caches, every asset resolves from the `/smart-invoice-pro/` sub-path (no 404s), the theme toggle works, the app still loads with the network cut, and the console is clean. Needs the network and a finished Pages build, so it is deliberately not part of `test:e2e`. Pass a URL to point it somewhere else: `npm run test:live -- https://example.com/` |
| `npm run shots` | Renders the brand showcase screenshots into `.workbuddy-ai/screenshots/` |
| `npm run test:e2e -- --suite=<file>` | Run any single script from `scripts/` against a freshly booted server + browser |

The E2E launcher finds Chrome or Edge automatically (override with `E2E_BROWSER`), starts its own server and browser on free ports, and tears them down afterwards. Use `npm run test:e2e -- --headed` to watch it run.

---

## 🔢 Calculation rules (never fail)

| Item | Formula |
|---|---|
| Line total | `Qty × Unit Price` |
| Item discount | `Line total × (Disc % / 100)` or fixed |
| Subtotal | `Σ (Line total − Item discount)` |
| Invoice discount | `Subtotal × (Disc % / 100)` or fixed |
| Tax | `(Subtotal − Invoice discount) × TaxRate%` |
| Grand total | `Subtotal − Invoice discount + Tax + Shipping` |
| Balance | `Grand total − Amount paid` |
| Status | `paid` if balance ≤ 0; `partial` if paid > 0; else `unpaid` |

All values are rounded to exactly 2 decimal places using safe integer math (`Math.round((n + ε) × 100) / 100`).

---

## 🌍 Currencies

Defaults included: **TZS, USD, EUR, KES, GBP**. Exchange rates are editable and stored offline. You can add unlimited custom currencies. Formatting uses thousands separators and 2 decimals, e.g. `TZS 120,000.00` and `USD 450.00`. Switch the active display currency from the top bar instantly.

---

## 🔒 Security notes

- HTML **escaped on output** everywhere (XSS-safe)
- All inputs sanitized (strip control chars, trim, max lengths)
- No `eval()`, no inline JavaScript, no third-party network requests at runtime
- IndexedDB used via transactional wrappers with full error handling
- **No secrets in the client.** Gateway credentials, licence issuance and any real access control belong on a server. The client-side plan gate is a nudge, not a lock.

---

## 🔮 Future expansion (architecture ready)

The modular codebase is designed to grow without rewrites:

- Inventory management, purchase orders, quotations, delivery notes, expense tracking, payroll
- Multi-user accounts, multi-branch, real cloud sync (implement the `SupabaseAdapter` / `FirebaseAdapter` contract — the `syncQueue` store and `pushPending()` entry point already exist)
- Barcode scanning, POS integration, Tanzania EFD receipt integration, AI sales analytics

---

## 🛠 Tech stack

HTML5 · CSS custom properties (design-token system) · Vanilla JavaScript (ES2023 modules) · IndexedDB · Service Workers · LocalStorage (theme + brand cache) · jsPDF · AutoTable · QRCode.js

No frameworks. No backend. No build step. No internet needed.

**How theming works:** `brand.js` derives a full design-token palette (brand, brand-dark/darker/light/soft, contrast-safe ink, accent, and 10 sidebar tokens) from just a primary colour, an accent colour, a sidebar style and a radius. It uses HSL maths plus WCAG relative-luminance contrast correction, then writes the result as inline custom properties on `<html>` — which outranks both `:root` and `[data-theme="dark"]`, so the brand wins without `!important`. A tiny duplicated copy in `brand-boot.js` runs as a render-blocking classic script so the palette *and* the app name are in place before the first paint; `test-brand.js` asserts the two implementations produce byte-identical palettes for 242 brand configurations.

**How the app name is applied:** every page ships an empty `#sidebarBrandName`, `#sidebarBrandSub` and logo-initials slot, and a `<title>` with no product name. `brand-boot.js` fills them from the saved brand (falling back to `app.config.js`) before first paint; `shell.js` re-applies them once the business name loads from IndexedDB. `test-config.js` asserts the slots stay empty in the markup, so no name can quietly get baked back in.

**How the invoice gets its branding:** the business name printed on an invoice resolves in this order — a name typed on the invoice itself (`invoice.companyName`, editable in the editor's *Business Name* field), then the Business Profile, then an explicitly set white-label App Name, then the configured fallback. The App Name step only fires when one was actually typed, so the template's own product name can never leak onto a client's invoice. The logo is stored once, as the `logoDataUrl` setting, and folded into the profile by `getCompanyProfile()` in `js/storageService.js` — the invoice preview, the PDF, the print sheet and the WhatsApp share all read `company.logoDataUrl` from that merged profile. Uploads are normalised to a size-bounded PNG (jsPDF cannot embed SVG, and a JPEG/WebP is re-encoded into a far larger file), and `js/export.js` still re-derives the image type from the data URL so a logo stored before that normalisation existed keeps working.

---

## 📄 License

Free for personal and business use.
