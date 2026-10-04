# Free client-monitoring pilot setup

The existing public invoice app remains usable and has no Admin navigation. This monitoring release is separate and must pass its account tests before activation. Business data stays local; monitoring is not cloud backup or cross-device invoice synchronization.

## Accounts and free resources

Use the existing GitHub account, the provisioned Supabase Free project, a Cloudflare Free account and Google Auth Platform basic OAuth. Use provider subdomains, a free TOTP authenticator and the existing local computer for tests. No paid plan, purchased domain, SMTP, SMS, Realtime subscription or payment service is needed. See [the resource plan](CLIENT_MONITORING_PLAN.md) for allowances and later milestones.

## Configure Google sign-in

1. In Google Auth Platform create a Web application OAuth client with `openid`, `email` and `profile` identity scopes. Configure the consent audience for your pilot accounts.
2. Add this Google authorized redirect URI: `https://afugvyrgkvbsbbglfbms.supabase.co/auth/v1/callback`.
3. Enter the Google client ID and secret directly in the Supabase Google provider settings. Do not commit or send the secret in chat.
4. Enable TOTP enrollment and verification in Supabase Auth MFA settings.
5. After the Cloudflare sites exist, set Supabase's Site URL to the client origin and allow only the exact client `/settings.html` and owner `/owner/index.html` OAuth redirects. Use the owner origin for its callback. Do not allow wildcard production redirects.
6. Test Google login with the owner and one invited client. Local automated tests use disposable email/password identities to exercise sessions and real TOTP; they do not prove production Google consent/callback configuration.

## Authorize and publish the separate sites

Use official `npm exec -- wrangler login --scopes account:read user:read pages:write`. Authorization requires the account owner to approve in their browser. No API secret is needed in chat. Create two Cloudflare Pages projects on the Free account: one client project and one owner project.

Run `npm ci`, `npm run test:all`, `npm run test:staging`, and the disposable-backend checks. Only then build the configured artifact using these public values in your shell environment:

```text
SUPABASE_URL=https://afugvyrgkvbsbbglfbms.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_USwClH5ZUmGmLyT9qDvVOg_oVzQJeCd
```

Run `npm run configure:cloud` followed by `npm run package:site`. This generates `dist/site` and `dist/owner`. Publish each directory to its own Pages project with Wrangler. These values are public configuration; a service-role/secret key is rejected. Keep the source default disabled until the release is verified. Never upload the repository root.

For repeatable CI deployment, use the manual Cloudflare workflow with a least-privilege Cloudflare Pages token in GitHub Actions secret `CLOUDFLARE_API_TOKEN` and repository variables `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_CLIENT_PROJECT`, `CLOUDFLARE_OWNER_PROJECT`, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Do not store a token in source. Run it only after hosted Google callbacks and owner enrollment are verified. The workflow tests both client and backend before publishing either artifact.

## Bootstrap the owner

The owner must first sign in through Google so that Supabase creates a verified identity. Verify the requested owner email and `auth.users.id` in the project dashboard. From the trusted Supabase SQL editor, grant that exact UUID:

```sql
insert into invoice_private.owner_admins(user_id, active)
values ('REPLACE_WITH_VERIFIED_OWNER_USER_UUID'::uuid, true);
```

Never use a client-controlled metadata field to assign the role. Finish authenticator setup on the owner site. Owner access requires the role, verified MFA and an existing backend session. Test denied access with a normal client account. After sign-out, client details must disappear immediately.

Create each pilot business invitation from the owner dashboard and share the client link manually. Invitations last seven days. The client signs in with that verified Google email, selects its business and explicitly agrees to operational status sharing. No automatic invitation email is sent.

## Preserve existing offline records

Export a backup from the old client URL before opening the Cloudflare URL. Browser databases do not transfer across origins. Connecting a business also opens a separate empty local workspace. Import the backup into the selected workspace and compare invoice/customer/product counts and financial totals. Retain the original export and old browser records until verified. Signing out returns to the original unconnected local workspace; business databases remain on that trusted device.

Local account separation prevents accidental mixing, not a person with access to the browser profile from inspecting IndexedDB. Avoid sharing one browser profile between unrelated clients. Offline work and exports remain available when the backend is unreachable. Monitoring only runs while the app is open and can connect; last contact is not proof that the client is online now.

## Verification and pilot operations

Local backend: start Supabase using the checked-in config (API 55431, Postgres 55432) with TOTP enabled. After changing Auth configuration, restart only this project's local services. Run `npm run test:monitoring:backend` and `npm run test:monitoring:online`; the latter needs local `supabase start --output-format json` output saved to `.ci-monitoring-backend.log`. Never run these fixtures against the hosted pilot. Database fixtures roll back or remove only their generated IDs.

Before inviting real clients, verify actual Google callbacks, owner MFA, cross-business denial, offline invoicing/retry, consent withdrawal, separate deployment URLs, and export/import recovery. Begin with two or three businesses.

During the pilot, inspect Supabase storage/egress weekly, prune resolved feedback, and export the database daily and before migrations to an encrypted off-device backup. Free Supabase has no automatic backup or uptime SLA. A backup/restore drill and hosted Google-login test remain release requirements. Never enable a paid upgrade automatically.

## Later work

Signed server-managed licenses and optional financial-data synchronization are separate milestones. The owner license column currently displays backend state; it does not replace the existing local license enforcement. No invoice/customer cloud upload endpoint is provided in this release.
