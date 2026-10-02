/**
 * ============================================================================
 *  FEEDBACK & RATING
 * ============================================================================
 *
 *  A review prompt that works with no backend and no network.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THE REVIEW IS STORED ON THE DEVICE
 *  ---------------------------------------------------------------------------
 *  This app ships as a static site on GitHub Pages with no server, and it is
 *  contract-locked to zero cross-origin requests — it has to run offline and
 *  from `file://`. So there is nowhere to POST a review to.
 *
 *  Instead the review is written to the same IndexedDB the invoices live in,
 *  and the user is handed a one-tap way to actually send it (WhatsApp or email)
 *  with the text already composed. WhatsApp is not a consolation prize here: it
 *  is how a Tanzanian SME contacts a supplier anyway, and it needs no account,
 *  no form and no connectivity beyond the phone.
 *
 *  The local copy is not wasted either — `js/admin.js` reads it as the Feedback
 *  inbox, so a review left on a customer's phone shows up in the vendor's admin
 *  console as soon as that device is in hand.
 *
 *  ---------------------------------------------------------------------------
 *  WHEN IT ASKS
 *  ---------------------------------------------------------------------------
 *  Never on a fresh install, and never while the guided tour is still unread —
 *  a review request that competes with the walkthrough is how you get a one-star
 *  review instead of a five-star one. `maybeShowNudge()` therefore waits for the
 *  onboarding-seen flag AND for `promptAfterInvoices` invoices to exist, and
 *  records that it asked even if the user ignores it, so it asks exactly once.
 */

import { $, $$, escapeHTML, sanitizeString, sanitizeMultiline, toast, openModal, uid } from './utils.js';
import { getSetting, setSetting, getInvoices } from './storageService.js';
import { feedbackConfig, appName } from './config.js';
import { currentPlanId, currentPlan } from './licenseService.js';
import { whatsappUrl } from './share.js';

const FEEDBACK_KEY = 'feedback';
const NUDGE_KEY = 'feedbackAsked';
const MAX_MESSAGE = 2000;

/** Words for the number of stars, so the rating is never just a number. */
export const RATING_LABELS = {
  1: 'Very poor',
  2: 'Poor',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent',
};

const STAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 2.6l2.95 5.98 6.6.96-4.77 4.65 1.12 6.57L12 17.66l-5.9 3.1 1.12-6.57L2.45 9.54l6.6-.96L12 2.6z"/></svg>';

/* ==========================================================================
   Pure helpers — exported so they can be unit-tested without a browser
   ========================================================================== */

/** Coerce anything into a 1–5 rating, or 0 for "not rated". */
export function normaliseRating(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 0;
}

/** A short device string for a bug report. Truncated — user agents are huge. */
export function describeDevice(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav) return '';
  const ua = String(nav.userAgent || '');
  return sanitizeString(ua, 200);
}

/** Aggregate a stored list for the admin inbox and the review list. */
export function summariseFeedback(records) {
  const list = Array.isArray(records) ? records : [];
  const rated = list.map((r) => normaliseRating(r?.rating)).filter((n) => n > 0);
  const total = rated.reduce((sum, n) => sum + n, 0);
  return {
    count: list.length,
    rated: rated.length,
    average: rated.length ? Math.round((total / rated.length) * 10) / 10 : 0,
    lastAt: list.length ? list[list.length - 1].createdAt || null : null,
  };
}

/**
 * The message a user actually sends.
 *
 * Written to be read by a human on WhatsApp with no context: it leads with the
 * verdict, then the words, then the diagnostic tail that makes a bug report
 * actionable. `meta` carries the parts that are not on the record itself.
 */
export function buildFeedbackMessage(record, meta = {}) {
  const rating = normaliseRating(record?.rating);
  const stars = rating ? `${rating}/5 — ${RATING_LABELS[rating]}` : 'No rating';
  const lines = [`${meta.appName || appName()} review: ${stars}`];

  if (record?.category) lines.push(`Topic: ${record.category}`);
  if (record?.message) lines.push('', String(record.message).trim());
  lines.push('', '—');
  if (meta.planName) lines.push(`Plan: ${meta.planName}`);
  if (record?.device) lines.push(`Device: ${record.device}`);

  return lines.join('\n');
}

/** `mailto:` for a review. With no configured address the user picks. */
export function feedbackMailtoUrl(record, meta = {}) {
  const to = sanitizeString(meta.email || '', 200);
  const subject = `${meta.appName || appName()} — ${normaliseRating(record?.rating) || '?'}/5 review`;
  const body = buildFeedbackMessage(record, meta);
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** WhatsApp link for a review, reusing the app's own number normalisation. */
export function feedbackWhatsappUrl(record, meta = {}) {
  return whatsappUrl(meta.whatsapp || '', buildFeedbackMessage(record, meta));
}

/* ==========================================================================
   Storage
   ========================================================================== */

/** Every review stored on this device, oldest first. Never throws. */
export async function getFeedback() {
  try {
    const stored = await getSetting(FEEDBACK_KEY, []);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Append a review. Returns the stored record. */
export async function addFeedback(entry) {
  const record = {
    id: uid('fb'),
    rating: normaliseRating(entry?.rating),
    category: sanitizeString(entry?.category || 'General', 60),
    message: sanitizeMultiline(entry?.message || '', MAX_MESSAGE),
    device: describeDevice(),
    plan: currentPlanId(),
    createdAt: new Date().toISOString(),
    sentVia: null,
  };
  const list = await getFeedback();
  list.push(record);
  await setSetting(FEEDBACK_KEY, list);
  return record;
}

/** Record how a review left the device, so the inbox can show it was answered. */
export async function markFeedbackSent(id, via) {
  const list = await getFeedback();
  const target = list.find((r) => r.id === id);
  if (!target) return null;
  target.sentVia = sanitizeString(via || '', 20) || null;
  target.sentAt = new Date().toISOString();
  await setSetting(FEEDBACK_KEY, list);
  return target;
}

export async function clearFeedback() {
  await setSetting(FEEDBACK_KEY, []);
}

/* ==========================================================================
   The review form
   ========================================================================== */

/** The footer buttons, kept in one place so both stages agree. */
function footerFor(stage) {
  if (stage === 'form') {
    return `
      <button class="btn btn-outline" data-fb="cancel">Cancel</button>
      <button class="btn btn-primary" data-fb="save">Save review</button>`;
  }
  return `<button class="btn btn-primary" data-fb="done">Done</button>`;
}

function formBody() {
  const cfg = feedbackConfig();
  const categories = Array.isArray(cfg.categories) && cfg.categories.length
    ? cfg.categories
    : ['General', 'Other'];

  return `
    <p class="text-muted" style="margin-bottom:14px">
      Tell us how ${escapeHTML(appName())} is working for you. A sentence is plenty —
      what works, what does not, and what you wish it did.
    </p>

    <div class="field">
      <span class="field-label" id="fbStarsLabel">Your rating</span>
      <div class="star-rating" id="fbStars" role="radiogroup" aria-labelledby="fbStarsLabel">
        ${[1, 2, 3, 4, 5].map((n) => `
          <button type="button" class="star-btn" data-star="${n}" role="radio" aria-checked="false"
            aria-label="${n} star${n === 1 ? '' : 's'} — ${RATING_LABELS[n]}" tabindex="${n === 1 ? '0' : '-1'}">${STAR_SVG}</button>`).join('')}
      </div>
      <span class="hint" id="fbRatingWord">Tap a star</span>
    </div>

    <div class="field">
      <label for="fbCategory">What is this about?</label>
      <select class="select" id="fbCategory">
        ${categories.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('')}
      </select>
    </div>

    <div class="field">
      <label for="fbMessage">Your feedback</label>
      <textarea class="textarea" id="fbMessage" rows="5" maxlength="${MAX_MESSAGE}"
        placeholder="What should we know?"></textarea>
      <span class="hint">Saved on this device. You choose whether to send it.</span>
    </div>

    <div id="fbRecent"></div>`;
}

/** The thank-you stage: the review is safe, now offer to actually send it. */
function sentBody(record, meta) {
  const rating = normaliseRating(record.rating);
  return `
    <div class="fb-thanks">
      <div class="fb-thanks-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </div>
      <h4>Thank you${rating ? ` — ${escapeHTML(RATING_LABELS[rating])}` : ''}</h4>
      <p class="text-muted">Your review is saved on this device.</p>
    </div>

    <div class="field">
      <span class="field-label">Send it to the developer (optional)</span>
      <div class="flex gap-3" style="flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" data-fb="whatsapp">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          WhatsApp
        </button>
        <button class="btn btn-outline btn-sm" data-fb="email">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          Email
        </button>
        <button class="btn btn-outline btn-sm" data-fb="copy">Copy text</button>
      </div>
      <span class="hint">${meta.email || meta.whatsapp
        ? 'Goes straight to the support channel configured for this build.'
        : 'Opens your own WhatsApp or mail app — pick who to send it to.'}</span>
    </div>`;
}

/* ==========================================================================
   Copying, with a fallback
   ========================================================================== */

/**
 * Put `text` on the clipboard. Resolves to true only if it actually landed.
 *
 * `navigator.clipboard` is undefined outside a secure context, and even where
 * it exists `writeText` rejects with NotAllowedError when the document is not
 * focused or the permission was refused. This app is explicitly supported from
 * `file://` as well as from Pages, so "the modern API is there" is not a safe
 * assumption — and on the Android browsers this is built for, a Copy button
 * that silently does nothing is worse than no button at all.
 *
 * So: try the real API, and fall back to the legacy textarea + execCommand
 * trick. That is deprecated, and it is also the only thing that works in a
 * non-secure context. The caller is told the truth either way, so it can say
 * so instead of claiming a copy that never happened.
 */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Off-screen but still focusable and selectable — `display:none` would
    // break `select()` on some engines.
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * Render the stored reviews under the form.
 *
 * Shown so a user can see they were heard, and so a second review does not
 * silently look like the first one vanished.
 */
async function renderRecent(overlay) {
  const box = $('#fbRecent', overlay);
  if (!box) return;
  const list = await getFeedback();
  if (!list.length) { box.innerHTML = ''; return; }
  const recent = list.slice(-3).reverse();
  box.innerHTML = `
    <div class="field">
      <span class="field-label">Your previous reviews</span>
      <div class="feedback-list">
        ${recent.map((r) => `
          <div class="feedback-item">
            <div class="fb-stars-static" aria-label="${normaliseRating(r.rating)} out of 5">
              ${[1, 2, 3, 4, 5].map((n) => `<span class="${n <= normaliseRating(r.rating) ? 'on' : ''}">${STAR_SVG}</span>`).join('')}
            </div>
            <div class="fb-item-body">
              <strong>${escapeHTML(r.category || 'General')}</strong>
              ${r.message ? `<div class="text-muted">${escapeHTML(r.message.slice(0, 140))}</div>` : ''}
              <div class="text-faint text-xs">${escapeHTML(new Date(r.createdAt).toLocaleDateString())}${r.sentVia ? ` · sent by ${escapeHTML(r.sentVia)}` : ' · not sent'}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

/**
 * Wire the star group.
 *
 * Same WAI-ARIA radio pattern the brand picker uses: arrows move and select,
 * and only the checked star holds the tab stop — a five-button group where
 * every button is tabbable is five extra presses to get past.
 */
function bindStars(overlay, onPick) {
  const wrap = $('#fbStars', overlay);
  if (!wrap) return;
  const buttons = $$('[data-star]', wrap);

  const select = (n, { focus = false } = {}) => {
    const rating = normaliseRating(n);
    buttons.forEach((b) => {
      const on = Number(b.dataset.star) <= rating;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(Number(b.dataset.star) === rating));
      b.tabIndex = Number(b.dataset.star) === rating ? 0 : -1;
    });
    const word = $('#fbRatingWord', overlay);
    if (word) word.textContent = rating ? `${rating}/5 — ${RATING_LABELS[rating]}` : 'Tap a star';
    onPick(rating);
    if (focus) buttons[rating - 1]?.focus();
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => select(Number(btn.dataset.star)));
    btn.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const cur = normaliseRating(btn.dataset.star);
      select(((cur - 1 + dir + 5) % 5) + 1, { focus: true });
    });
  });

  select(0);
}

/** Open the review form. Resolves when the modal closes. */
export async function openFeedbackModal({ presetRating = 0 } = {}) {
  const cfg = feedbackConfig();
  const meta = {
    appName: appName(),
    planName: currentPlan()?.name || currentPlanId(),
    email: cfg.email || '',
    whatsapp: cfg.whatsapp || '',
  };

  let rating = normaliseRating(presetRating);
  let record = null;

  const { overlay } = openModal({
    title: 'Feedback & rating',
    size: 'modal-lg',
    body: formBody(),
    footer: footerFor('form'),
    onOpen: async (ov) => {
      bindStars(ov, (n) => { rating = n; });

      const goStageTwo = async () => {
        record = await addFeedback({
          rating,
          category: $('#fbCategory', ov)?.value,
          message: $('#fbMessage', ov)?.value,
        });
        $('.modal-body', ov).innerHTML = sentBody(record, meta);
        $('.modal-footer', ov).innerHTML = footerFor('sent');
        bindStageTwo(ov);
      };

      const bindStageTwo = (root) => {
        const send = async (via, url) => {
          if (url) window.open(url, '_blank', 'noopener');
          else {
            // Pop-up blocked or no URL — the text is still worth handing over.
            const copied = await copyText(buildFeedbackMessage(record, meta));
            toast(copied
              ? 'Review copied — paste it anywhere'
              : 'Could not open that app — select the text and copy it manually', copied ? 'info' : 'error', 5000);
          }
          await markFeedbackSent(record.id, via);
        };

        $('[data-fb="whatsapp"]', root)?.addEventListener('click', () => send('whatsapp', feedbackWhatsappUrl(record, meta)));
        $('[data-fb="email"]', root)?.addEventListener('click', () => send('email', feedbackMailtoUrl(record, meta)));
        $('[data-fb="copy"]', root)?.addEventListener('click', async () => {
          const copied = await copyText(buildFeedbackMessage(record, meta));
          if (!copied) {
            // Do NOT record this as sent. Marking a review "sent" when the text
            // never left the device is the one lie this feature must not tell —
            // the whole point of the local copy is that the user is told the
            // truth about where their words are.
            toast('This browser will not copy automatically — select the text above', 'error', 5000);
            return;
          }
          await markFeedbackSent(record.id, 'clipboard');
          toast('Review copied to the clipboard', 'success');
        });
        $('[data-fb="done"]', root)?.addEventListener('click', () => {
          ov.remove();
          toast('Thanks for the feedback', 'success');
        });
      };

      $('[data-fb="cancel"]', ov)?.addEventListener('click', () => ov.remove());
      $('[data-fb="save"]', ov)?.addEventListener('click', async () => {
        const message = sanitizeMultiline($('#fbMessage', ov)?.value || '', MAX_MESSAGE);
        if (!rating && !message) {
          toast('Pick a rating or write a few words first', 'error');
          return;
        }
        await goStageTwo();
      });

      await renderRecent(ov);
    },
  });

  return overlay;
}

/* ==========================================================================
   The one-time nudge
   ==========================================================================
   Rendered at the END of the dashboard's content column, deliberately. An
   earlier draft put it at the top, which pushed the dashboard's primary action
   below the fold — the exact failure `test-polish.js` was written to catch. An
   element appended last cannot move anything above it.

   It is a card, not an auto-opening modal: this app already opens the guided
   tour on a fresh install, and a second modal fighting it for the same moment
   is how a first impression turns into an uninstall. */

async function maybeShowNudge() {
  if (document.body.dataset.page !== 'dashboard') return;
  if (await getSetting(NUDGE_KEY, false)) return;
  // Never compete with the walkthrough.
  if (!(await getSetting('onboardingSeen', false))) return;

  const cfg = feedbackConfig();
  const threshold = Number(cfg.promptAfterInvoices) || 0;
  let invoices = [];
  try {
    invoices = await getInvoices();
  } catch {
    return;
  }
  if (invoices.length < threshold) return;

  // One shot, recorded now: if the user ignores the card it never returns.
  await setSetting(NUDGE_KEY, true);

  const content = $('#content');
  if (!content) return;

  const card = document.createElement('div');
  card.className = 'feedback-nudge no-print';
  card.id = 'feedbackNudge';
  card.innerHTML = `
    <div class="fn-mark" aria-hidden="true">${STAR_SVG}</div>
    <div class="fn-body">
      <strong>How is ${escapeHTML(appName())} working out?</strong>
      <span>You have raised ${invoices.length} invoices with it. A quick rating helps us fix what gets in your way.</span>
    </div>
    <div class="fn-actions">
      <button type="button" class="btn btn-sm btn-gold" data-action="feedback" id="nudgeRate">Rate the app</button>
      <button type="button" class="icon-btn" id="nudgeDismiss" aria-label="Dismiss">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  content.appendChild(card);

  card.querySelector('#nudgeRate').addEventListener('click', () => openFeedbackModal());
  card.querySelector('#nudgeDismiss').addEventListener('click', () => card.remove());
}

/* ==========================================================================
   Wiring
   ========================================================================== */

/**
 * Bind every feedback entry point on the page and, on the dashboard, decide
 * whether to offer the one-time nudge.
 *
 * Called from `initShell()`, so the entry point works on all seven pages
 * without each one having to import this module.
 */
export async function initFeedback() {
  document.addEventListener('click', (e) => {
    const trigger = e.target instanceof Element ? e.target.closest('[data-action="feedback"]') : null;
    if (!trigger) return;
    e.preventDefault();
    openFeedbackModal();
  });

  try {
    await maybeShowNudge();
  } catch {
    /* a missing nudge must never take the page down */
  }
}
