create index feedback_business on public.client_feedback(business_id);
create index feedback_user_created on public.client_feedback(user_id,created_at);
create index invitations_claimed_by on public.client_invitations(claimed_by);
create index invitations_email_open on public.client_invitations(email,expires_at) where claimed_by is null;

alter policy membership_read on public.business_memberships using
 ((user_id = (select auth.uid()) and active) or (select invoice_private.admin_allowed()));
alter policy devices_read on public.client_devices using
 ((user_id = (select auth.uid()) and invoice_private.member_allowed(business_id)) or (select invoice_private.admin_allowed()));
alter policy feedback_read on public.client_feedback using
 ((user_id = (select auth.uid()) and invoice_private.member_allowed(business_id)) or (select invoice_private.admin_allowed()));

-- Explicit deny policy documents that only the checked private functions,
-- running as the database owner, may read administrator identities.
create policy owner_identities_deny on invoice_private.owner_admins for all to authenticated using (false) with check (false);
