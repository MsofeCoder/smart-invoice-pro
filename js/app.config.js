/**
 * ============================================================================
 *  APPLICATION CONFIGURATION
 * ============================================================================
 *
 *  The single source of truth for every default, white-labelable setting.
 *  Rebranding the whole product for a new client means editing this file — no
 *  component should ever hard-code an app name, currency, tax rate or plan
 *  limit again.
 *
 *  ---------------------------------------------------------------------------
 *  WHY A CLASSIC SCRIPT AND NOT `settings.config.json`
 *  ---------------------------------------------------------------------------
 *  A JSON file would have to be fetched, and fetch() is blocked by CORS when
 *  the app is opened straight from disk (file://), which this project
 *  explicitly supports. It would also be asynchronous, and `brand-boot.js` is
 *  render-blocking by design — it must have the palette and the app name in
 *  hand *before* the first paint or the user sees a flash of the wrong brand.
 *
 *  So the config is a plain classic script that publishes two frozen globals:
 *
 *    window.APP_CONFIG  — the data
 *    window.AppConfig   — small helpers over that data (storage keys etc.)
 *
 *  ES modules should import from `js/config.js` instead of touching the globals
 *  directly; that module re-exports these values and fails loudly if this file
 *  was not loaded first.
 *
 *  ---------------------------------------------------------------------------
 *  PRECEDENCE
 *  ---------------------------------------------------------------------------
 *    saved Business Settings (IndexedDB)
 *      > this file
 *        > defensive fallbacks inside the modules
 *
 *  Anything a business owner edits in Settings always wins. This file only
 *  decides what a *fresh* install looks like.
 * ============================================================================
 */
(function () {
  'use strict';

  var CONFIG = {
    /* ======================================================================
       Identity — the defaults a brand-new install starts from.
       ====================================================================== */
    appName: 'Smart Invoice Pro',
    shortName: 'Smart Invoice',
    tagline: 'Business Invoicing & Management',
    description:
      'Professional offline invoicing and business management. Create, manage and ' +
      'export invoices, customers, products and reports — 100% offline.',

    /** Slug used for the PWA id, cache prefix and export filenames. */
    slug: 'smart-invoice-pro',

    /** Shown wherever a business has not entered its own name yet. */
    fallbackBusinessName: 'Your Business Name',

    /* ======================================================================
       Financial defaults
       ====================================================================== */
    defaultCurrency: 'TZS',
    /** Tanzanian VAT. A business can override this in Settings. */
    defaultTaxRate: 18,
    defaultLanguage: 'en',

    /* ======================================================================
       White-label
       ====================================================================== */
    /** When false the Brand & Appearance panel is hidden and locked. */
    allowWhiteLabel: true,
    /** Custom logo uploads (vs. the initials fallback). */
    allowCustomLogo: true,

    /* ======================================================================
       Storage
       ====================================================================== */
    dbName: 'smart-invoice-pro',
    /**
     * Databases to migrate FROM on first boot. Renaming dbName would otherwise
     * strand every existing user's invoices in an orphaned database.
     */
    legacyDbNames: ['crown-invoice-pro'],

    /** Prefix for localStorage keys (theme + brand cache). */
    storagePrefix: 'sip_',
    /** Prefixes to migrate away from, read-only, on first boot. */
    legacyStoragePrefixes: ['crown_'],

    /* ======================================================================
       Cloud sync — see js/storageService.js
       'local' keeps everything on-device. The cloud adapters are stubs with a
       documented contract so a backend can be dropped in without touching any
       feature module.
       ====================================================================== */
    sync: {
      adapter: 'local', // 'local' | 'supabase' | 'firebase' | 'rest'
      endpoint: '',
      apiKey: '',
      autoSync: false,
      /** Milliseconds between background pushes when autoSync is on. */
      intervalMs: 30000,
    },

    /* ======================================================================
       Monetization — see js/licenseService.js
       ====================================================================== */
    defaultPlan: 'free',

    plans: {
      free: {
        id: 'free',
        name: 'Free',
        price: 0,
        currency: 'TZS',
        /** Hard ceiling on invoices created per calendar month. */
        invoiceLimitPerMonth: 10,
        maxCustomers: 25,
        maxProducts: 25,
        features: [
          'invoices',
          'customers',
          'products',
          'reports',
          'pdf-export',
          'csv-export',
          'whatsapp-share',
        ],
      },
      pro: {
        id: 'pro',
        name: 'Pro',
        price: 29000,
        currency: 'TZS',
        period: 'month',
        invoiceLimitPerMonth: null, // null = unlimited
        maxCustomers: null,
        maxProducts: null,
        features: [
          'invoices',
          'customers',
          'products',
          'reports',
          'pdf-export',
          'csv-export',
          'whatsapp-share',
          'brand-customisation',
          'no-watermark',
          'priority-support',
        ],
      },
      enterprise: {
        id: 'enterprise',
        name: 'Enterprise',
        price: null, // "contact us"
        currency: 'TZS',
        invoiceLimitPerMonth: null,
        maxCustomers: null,
        maxProducts: null,
        features: [
          'invoices',
          'customers',
          'products',
          'reports',
          'pdf-export',
          'csv-export',
          'whatsapp-share',
          'brand-customisation',
          'no-watermark',
          'priority-support',
          'cloud-sync',
          'multi-user',
          'multi-branch',
          'api-access',
        ],
      },
    },

    /** Features gated behind a paid plan, for quick lookup. */
    paidFeatures: [
      'brand-customisation',
      'no-watermark',
      'cloud-sync',
      'multi-user',
      'multi-branch',
      'api-access',
    ],

    /* ======================================================================
       Payment gateways — local Tanzanian processors.
       UI placeholders only: nothing here charges anyone. `enabled` stays false
       until real credentials are configured and a server-side callback exists.
       ====================================================================== */
    paymentGateways: [
      {
        id: 'azampay',
        name: 'AzamPay',
        tagline: 'Collections via mobile money and cards',
        methods: ['M-Pesa', 'Tigo Pesa', 'Airtel Money', 'HaloPesa', 'Card'],
        enabled: false,
        mode: 'sandbox', // 'sandbox' | 'production'
        docs: 'https://developers.azampay.co.tz/',
        endpoints: { sandbox: '', production: '' },
      },
      {
        id: 'selcom',
        name: 'Selcom',
        tagline: 'Mobile money collections and disbursements',
        methods: ['M-Pesa', 'Tigo Pesa', 'Airtel Money', 'HaloPesa', 'Mixx by Yas'],
        enabled: false,
        mode: 'sandbox',
        docs: 'https://developers.selcommobile.com/',
        endpoints: { sandbox: '', production: '' },
      },
    ],

    /* ======================================================================
       Sharing
       ====================================================================== */
    whatsapp: {
      /** Default dialling code, so a locally-formatted number still works. */
      countryCode: '255',
      /** {business} {number} {total} {currency} {due} are substituted. */
      defaultMessage:
        'Hello {customer}, please find invoice {number} from {business} for ' +
        '{currency} {total}. Due {due}. Thank you.',
    },

    /* ======================================================================
       PDF layout — one geometry for every device.
       jsPDF lays out in millimetres against a fixed A4 page, so output is
       already device-independent; these values are the single place that
       geometry is defined.
       ====================================================================== */
    pdf: {
      pageSize: 'a4',
      orientation: 'portrait',
      unit: 'mm',
      margin: 14,
      logoSize: 22,
    },
  };

  /* ========================================================================
     Helpers — shared by classic scripts (brand-boot.js) and modules.
     ======================================================================== */

  /** Resolve a logical storage name to its prefixed key. */
  function storageKey(name) {
    return CONFIG.storagePrefix + name;
  }

  /**
   * Read a value from localStorage, falling back to any legacy prefix.
   * A user who installed under the old brand keeps their theme and palette.
   */
  function readStorage(name) {
    try {
      if (typeof localStorage === 'undefined') return null;
      var current = localStorage.getItem(storageKey(name));
      if (current !== null) return current;
      for (var i = 0; i < CONFIG.legacyStoragePrefixes.length; i++) {
        var legacy = localStorage.getItem(CONFIG.legacyStoragePrefixes[i] + name);
        if (legacy !== null) return legacy;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  function writeStorage(name, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey(name), value);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Remove both the current and any legacy key. */
  function removeStorage(name) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.removeItem(storageKey(name));
      CONFIG.legacyStoragePrefixes.forEach(function (prefix) {
        localStorage.removeItem(prefix + name);
      });
    } catch (err) {
      /* storage blocked — nothing to clean up */
    }
  }

  /** Look up a plan definition, falling back to the default plan. */
  function getPlan(id) {
    return CONFIG.plans[id] || CONFIG.plans[CONFIG.defaultPlan];
  }

  /** True when the named feature is included in the given plan. */
  function planHasFeature(planId, feature) {
    return getPlan(planId).features.indexOf(feature) !== -1;
  }

  window.APP_CONFIG = Object.freeze(CONFIG);

  window.AppConfig = Object.freeze({
    get: function () {
      return CONFIG;
    },
    storageKey: storageKey,
    readStorage: readStorage,
    writeStorage: writeStorage,
    removeStorage: removeStorage,
    getPlan: getPlan,
    planHasFeature: planHasFeature,
  });
})();
