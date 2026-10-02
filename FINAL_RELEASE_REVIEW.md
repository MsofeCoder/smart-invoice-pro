# Final release review - 2 October 2026

Verdict: the confirmed release blockers are fixed. The application-only package is ready for deployment for a local, offline invoicing workflow. No known blocker remains in the tested workflows. Final verification of a hosted release must use the exact deployed HTTPS URL; this review does not claim that uncommitted local changes are already deployed.

## Fixes completed

- **Correct quantities and money:** canonical decimal strings and scientific notation are parsed before locale formatting. `0.125 × 1000` now displays and persists as `125.00`, with quantity `0.125` preserved. Malformed grouping and inner text are rejected by the parser. Invoice, payment, product and settings save handlers validate native numeric fields before persisting.
- **Safe restore:** all five business-data stores are validated before replacement. Missing stores, unsupported versions, invalid app IDs, invalid primary keys and duplicate keys are rejected. One IndexedDB transaction replaces the complete dataset and clears obsolete sync operations. Both synchronous write failures and asynchronous transaction aborts preserve all original stores and the pending queue.
- **Clean client data:** opening an empty dashboard never inserts demo invoices, customers or products. Browser tests explicitly create their own disposable fixtures. Existing user records are retained.
- **Mobile notifications:** wrapping, minimum widths and vertical animation prevent long notifications from extending beyond a 320px viewport.
- **Release protection:** CI gates deployment on static tests, all ten browser suites, the packaged-site smoke test and a dependency audit. Chrome setup uses the action's documented installed-binary output. Only `dist/site` is published.
- **Reliable deployment checks:** expected cache version is derived from `sw.js`, now v18. Custom HTTPS URLs are forwarded to the live test. Local directory indexes work for subdirectory smoke testing; traversal protection remains intact.
- **Client package:** `npm run package:site` creates a clean artifact containing only runtime HTML, JS, CSS, libraries, icons and assets. Source matching was verified before creating the ZIP and SHA-256 checksum.

The earlier CSV injection protection, quota month-boundary correction, numeric input modes and form autocomplete remain in the tested release.

## Final verification

| Check | Result |
|---|---|
| Clean locked install (`npm ci`) | PASS, exit 0 |
| Static checks (`npm test`), including after clean install | 1,041 passed, 0 failed |
| Full browser run (`npm run test:e2e`) | 10/10 suites PASS; 739/739 assertions; exit 0 |
| New release-safety suite | 33/33 passed, included above |
| Packaged-site smoke (`npm run test:staging`) | 50/50 passed, exit 0 |
| Dependency audit | 0 known vulnerabilities, exit 0 |
| Package-to-source comparison | PASS |
| Directory-index / traversal checks | 200 / 403 as expected |
| JavaScript syntax and patch whitespace | PASS |

Browser suite totals: E2E 136, accessibility 25, polish 26, responsive 102, platform 125, charts 68, preview 14, onboarding 66, features 144, release safety 33. The previously failing 320px dashboard check now passes.

Release-safety checks cover actual invoice display and storage, empty-ledger reloads, preservation of records using former demo IDs, rejected malformed restores, rollback after clone failures and asynchronous aborts, complete valid restore round-trips, stale queue cleanup, and notification bounds during animation. The package smoke covers subdirectory assets, v18 activation, old-cache cleanup, offline reload, themes, charts, reports and PDF preview. Phone and desktop onboarding screenshots were visually reviewed.

Tests ran with Windows, Node v26.7.0, npm 11.19.0 and headless Chrome in disposable profiles. CI is configured for Node 22; the updated workflow has not been executed remotely in this session. Safari/iOS and the final deployed HTTPS origin have not been independently verified.

## Client delivery

- Application directory: `dist/site/`
- Client ZIP: `dist/smart-invoice-pro-client.zip`
- ZIP checksum: `dist/smart-invoice-pro-client.sha256`
- Publish the contents of `dist/site/` to the client's HTTPS site (or use the updated Pages workflow).
- After publication: `npm run test:live -- https://the-exact-client-url.example/app/`
- Configure the client's business identity, currency and payment details before issuing invoices. Retain exported backups. Review any sample records left by an older installation before real business use; this update deliberately preserves existing data.

This package provides local/offline invoicing. Cloud sync and payment gateway adapters remain stubs; browser-side licensing and the admin passcode remain convenience controls. Those server-backed capabilities are not part of this delivery's readiness claim.

This report records local release verification before publication. Hosted deployment status is tracked by the GitHub Actions workflow. No client browser-data reset was performed. Local evidence is in `.fix-clean-unit.log`, `.fix-e2e.log`, `.fix-release.log`, `.fix-staging.log`, `.fix-install.log` and `.diag-fixed-audit.json`.
