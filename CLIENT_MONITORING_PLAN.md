# Client monitoring implementation plan

Status: milestone 1 implementation and Free pilot database prepared. Monitoring remains disabled in the public client release until Google OAuth, owner enrollment, Cloudflare authorization and the release checks are complete. Server licensing and business synchronization remain later milestones.

Budget constraint: free resources only. Service allowances verified on 4 October 2026. Target recurring service cost is $0 while usage stays within free allowances; availability and future pricing are not guaranteed. Do not activate paid plans, billable add-ons or automatic paid upgrades.

## Free resources selected

| Resource | Purpose | Allowance or operating rule |
| --- | --- | --- |
| Cloudflare Pages Free | Separate client and owner dashboard sites, HTTPS and provider subdomains | Use `*.pages.dev`, without buying a domain. Free plan has 500 builds/month and 20,000 files/site. Deploy verified artifacts only after CI succeeds. |
| Supabase Free Postgres + Data API | Businesses, memberships, licenses, device status, feedback and compact application audit records | 500 MB database/project and 5 GB egress included. Two active free projects maximum, subject to available account slots: staging and pilot. |
| Supabase Auth Free | Account sessions and Google sign-in; owner TOTP MFA | 50,000 monthly active users; social OAuth and basic MFA included. Enforce business membership and RLS rather than trusting the browser. |
| Google Auth Platform OAuth client | Google account login without sending authentication emails | Configure basic identity scopes only. Initial clients need a Google account. Configure pilot audience, callbacks and consent screen; review publishing requirements before expanding. Do not enable billable Google Cloud products. |
| Supabase Edge Functions Free, later phase | License signing and additional privileged integrations | 500,000 invocations included. Milestone 1 uses authenticated Postgres RPCs for enrollment and monitoring; no Edge Function is deployed. Store signing keys and privileged API credentials as backend secrets only. |
| Supabase Storage Free, later phase | Optional private artwork/files associated with business sync | 1 GB storage included. Initially generate PDFs locally and avoid uploading invoices, signatures or stamps. |
| GitHub Free + standard Actions runners | Source control, existing tests, deployment quality gate | Standard runners are free for the existing public repository. Keep secrets in Actions secrets and use short artifact retention within storage allowances. No client data or backups in the repository. |
| Browser IndexedDB, service worker and Web Crypto | Offline records, transactional outbox and offline license verification | Existing browser capabilities; no additional service account or license. |
| Existing Node.js/npm, HTML/CSS/JavaScript, Chrome tests, jsPDF, AutoTable and QRCode | Build the client and dashboard and keep existing exports/tests | Reuse the project stack; preserve package licenses and notices. Supabase client SDK is the only planned new runtime SDK, pinned in the lockfile. |
| Supabase CLI/Postgres export tools and existing local computer storage | Database exports and recovery drills | Free tier has no included automatic backups. Export and encrypt database backups locally with Node's built-in crypto, retain at least one separate off-device encrypted copy on an available device, and back up optional Storage objects separately. No new paid storage subscription. |
| In-app monitoring dashboard and existing support channel | Errors, stale clients, license alerts and feedback | No separate paid analytics, logging, SMS or notification service. Display alerts when the owner opens the dashboard; manual support messages initially. |

Accounts needed: the existing GitHub account, a Cloudflare account, a Supabase account and a Google account with an OAuth configuration project. An authenticator supporting TOTP is needed for owner MFA. No purchased domain, VPS, SMS gateway, transactional email subscription or payment integration is required for the first monitoring release.

## Limits and cost controls

- Start with 2–3 pilot businesses. Capacity is determined by measured database/egress/function usage, not the authentication user allowance.
- Send one small latest-state update on app start/reconnect and at most every 15 minutes while active. Keep one pending status per user/workspace and latest device state on the server; do not accumulate telemetry history. Feedback is capped at ten submissions per user/day; review and prune resolved messages during the pilot. Keep license and administrative audit records separately.
- Poll the dashboard only while visible, at most once per minute; do not require Realtime connections for the first release.
- Review usage weekly and flag 70% and 85% consumption. Reduce telemetry/history or stop optional uploads at limits; retain local invoicing. Never silently purchase capacity.
- Supabase can pause free projects after a week of inactivity. Owner must handle pause/restore manually; do not manufacture traffic to evade pausing. The app remains usable locally during backend unavailability.
- Free service has no included uptime SLA, point-in-time recovery or automatic database backups. Perform daily local exports during the pilot and before migrations, with a tested restore procedure. This creates operational work rather than a managed-backup guarantee.
- Use Google login initially because Supabase's default email sender is restricted to team addresses and is not suitable for client authentication emails. Email/password recovery, magic links and automated invitations require a separately evaluated SMTP setup later.

## Intended behavior

Clients keep using the app offline. When they reconnect and open the app, approved device and usage updates reach a secure backend. The owner uses a separate authenticated dashboard to manage businesses, licenses and support. Client navigation never includes Admin.

First release scope: client enrollment, server license display, app version, last server contact, local pending operation count, general error codes and explicit feedback. There is no last successful business sync because business sync is not enabled. Invoice contents, customer details, signatures and payment information are excluded from monitoring by default. Full business backup and synchronization are a later, explicitly enabled capability. The current local license engine is not yet replaced by signed server entitlements.

## Architecture

Client PWA -> local IndexedDB -> durable outbox -> authenticated API -> database.

Separate owner dashboard -> authenticated admin API -> permitted client records.

Use Supabase Auth, Postgres with explicit API grants, business-scoped row-level security and authenticated RPCs. Edge Functions are reserved for the later signing milestone. Deploy client and owner dashboard to separate Cloudflare Pages sites. A separate dashboard URL is not an authorization boundary: the backend must check identity, role and business membership on every request.

Provisioned pilot: `smart-invoice-pro-pilot` (`afugvyrgkvbsbbglfbms`), Supabase Free, region `ap-south-1`, organization `SalafyDeveloper`. Local Docker/Postgres/Auth provide disposable staging tests; the second hosted free project slot is currently reserved. Owner roles have not been granted yet.

Move the authenticated commercial app off GitHub Pages: its documented usage restrictions exclude commercial SaaS hosting. Keep GitHub for source and CI. Changing the client origin does not transfer IndexedDB automatically: provide export from the existing site, explicit import into the new site, and record/total verification before retiring the old client URL. Do not clear existing device data.

## Milestone 1: accounts and monitoring

- Enroll invited Google identities into a business account with a stable business ID; support owner and staff memberships. Google sign-in alone never grants access to another business.
- Create owner admin accounts with MFA and server-enforced roles. Never ship privileged credentials in the client bundle.
- Partition local storage by business/account and protect unsynced work during account switching. Existing local records are assigned to an account only through an explicit migration flow with a backup.
- Add a Settings screen explaining what is collected, cloud features enabled and last contact time.
- Send minimal, versioned monitoring events with unique IDs, bounded local retention, retry backoff and server receipt timestamps. Sanitize error details to remove personal information and secrets.
- Build a dashboard listing client, license, app version, last contact, reported queue state and support alerts. Label stale information honestly; last contact does not prove the client is currently online.
- Monitor on app start, return to foreground and reconnect. Do not promise monitoring while the browser is closed: background sync support varies.

Acceptance: two test businesses cannot read or modify each other's records; non-admin users cannot access admin APIs; offline use continues; reconnect delivers queued monitoring events without duplicates; logout/account switching does not expose another business's local records.

## Milestone 2: server-managed licensing

- Store license entitlement and renewal history on the server. Replace client-generated entitlement authority with signed, expiring offline entitlement documents; signing secrets remain server-side.
- Define and display an offline grace period. Refresh entitlement on reconnect and apply suspension/expiry predictably without destroying client records or preventing backup export.
- Record license and membership changes in an audit log. Use authenticated, expiring device enrollment and provide lost-device revocation.

Acceptance: modified client settings do not grant server access; grace-period behavior is tested; revocation applies on reconnect. Browser-only offline enforcement remains bypassable by a determined user and cannot provide immediate remote suspension.

## Milestone 3: optional business backup and sync

The current storage service needs substantive changes, not simply an endpoint configuration:

- Commit each business write and its outbox entry in one IndexedDB transaction. Continue queuing offline and during authentication/network outages.
- Send stable operation IDs and acknowledge individual operations; retries must not duplicate invoices or payments. Coordinate concurrent browser tabs.
- Replace destructive whole-store pulls with incremental, versioned merges, deletion markers and a server-issued cursor. Never overwrite pending local changes.
- Define conflict handling for concurrent edits. Preserve conflicting invoice/payment changes for review rather than silently applying last-write-wins.
- Define restore/import behavior for a synced account; test bulk writes, deletion and recovery explicitly.
- Add visible sync status, manual retry and actionable conflict/error messages.
- Implement business-scoped access controls, backup retention and verified restore procedures. Owner access to invoice/customer contents requires explicit permissions and an audited support workflow.

Acceptance: disconnect/reconnect, duplicate requests, partial acknowledgments, expired sessions, concurrent tabs/devices, conflicting edits, deletions, migration and restore all preserve expected records and totals.

## Milestone 4: pilot and release gate

Use the two available free Supabase project slots for staging and the client pilot, with separate credentials. If those slots are already occupied, use local testing until a staging slot is available; never mix test data into the pilot. Add authorization and tenant-isolation tests, migration rollback checks, API rate limits, dependency checks and dashboard alerting. Perform a database backup/restore drill. Keep the existing client regression gate and deploy to Cloudflare only after it succeeds.

Pilot with two or three invited businesses, confirm support workflow and data handling, then expand. Ship monitoring before optional full sync so clients gain visibility without a rushed financial-data migration. Rollback must preserve locally queued work.

## References

- Supabase current pricing and free allowances: https://supabase.com/pricing
- Supabase Google OAuth setup: https://supabase.com/docs/guides/auth/social-login/auth-google
- Supabase default email restrictions: https://supabase.com/docs/guides/auth/auth-smtp
- Supabase backup requirements: https://supabase.com/docs/guides/platform/backups
- Cloudflare Pages free limits: https://developers.cloudflare.com/pages/platform/limits/
- GitHub standard runner billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- GitHub Pages hosting restrictions: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- OWASP tenant isolation: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html
- MDN background sync support: https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API
