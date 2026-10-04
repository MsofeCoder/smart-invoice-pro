-- Operational monitoring only: no invoice/customer/payment tables are exposed.
create schema if not exists invoice_private;
revoke all on schema invoice_private from public, anon;
grant usage on schema invoice_private to authenticated;

create table invoice_private.owner_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true
);
alter table invoice_private.owner_admins enable row level security;
revoke all on invoice_private.owner_admins from public, anon, authenticated;

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);
create table public.business_memberships (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','staff')),
  active boolean not null default true,
  primary key (business_id, user_id)
);
create index membership_user on public.business_memberships(user_id, business_id);
create table public.business_licenses (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  plan_id text not null default 'free' check (plan_id in ('free','pro','business')),
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.client_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  role text not null default 'owner' check (role in ('owner','staff')),
  expires_at timestamptz not null default now() + interval '7 days',
  claimed_by uuid references auth.users(id),
  unique (business_id, email)
);
create table public.client_devices (
  business_id uuid not null references public.businesses(id) on delete cascade,
  device_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_operation_id uuid not null,
  app_version text not null,
  page text not null,
  pending_count integer not null check (pending_count between 0 and 10000),
  sync_state text not null check (sync_state = 'local_only'),
  error_codes text[] not null default '{}',
  last_contact_at timestamptz not null default now(),
  consent_version integer not null default 1 check (consent_version = 1),
  primary key (business_id, device_id)
);
create index devices_by_user on public.client_devices(user_id, business_id);
create table public.client_feedback (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);
create table public.owner_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null,
  business_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);

-- SECURITY DEFINER is confined to a private, non-API schema. Each entry
-- validates the authenticated user; no caller-provided identity is trusted.
create function invoice_private.admin_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (auth.jwt()->>'aal') = 'aal2'
    and exists (select 1 from invoice_private.owner_admins a where a.user_id = auth.uid() and a.active)
    and exists (select 1 from auth.sessions s where s.id::text = auth.jwt()->>'session_id' and s.user_id = auth.uid());
$$;
create function invoice_private.member_allowed(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.business_memberships m where m.business_id = target
      and m.user_id = auth.uid() and m.active
  );
$$;
revoke all on function invoice_private.admin_allowed() from public, anon;
revoke all on function invoice_private.member_allowed(uuid) from public, anon;
grant execute on function invoice_private.admin_allowed(), invoice_private.member_allowed(uuid) to authenticated;

alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;
alter table public.business_licenses enable row level security;
alter table public.client_invitations enable row level security;
alter table public.client_devices enable row level security;
alter table public.client_feedback enable row level security;
alter table public.owner_audit enable row level security;
revoke all on public.businesses, public.business_memberships, public.business_licenses,
  public.client_invitations, public.client_devices, public.client_feedback, public.owner_audit from public, anon, authenticated;
grant select on public.businesses, public.business_memberships, public.business_licenses,
  public.client_invitations, public.client_devices, public.client_feedback, public.owner_audit to authenticated;

create policy business_read on public.businesses for select to authenticated
using (invoice_private.member_allowed(id) or invoice_private.admin_allowed());
create policy membership_read on public.business_memberships for select to authenticated
using ((user_id = auth.uid() and active) or invoice_private.admin_allowed());
create policy license_read on public.business_licenses for select to authenticated
using (invoice_private.member_allowed(business_id) or invoice_private.admin_allowed());
create policy invitations_owner_read on public.client_invitations for select to authenticated
using (invoice_private.admin_allowed());
create policy devices_read on public.client_devices for select to authenticated
using ((user_id = auth.uid() and invoice_private.member_allowed(business_id)) or invoice_private.admin_allowed());
create policy feedback_read on public.client_feedback for select to authenticated
using ((user_id = auth.uid() and invoice_private.member_allowed(business_id)) or invoice_private.admin_allowed());
create policy audit_owner_read on public.owner_audit for select to authenticated
using (invoice_private.admin_allowed());

create function invoice_private.claim_invitation() returns integer
language plpgsql security definer set search_path = '' as $$
declare person uuid := auth.uid(); verified_email text; item record; claimed integer := 0;
begin
  if person is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select lower(email) into verified_email from auth.users where id = person and email_confirmed_at is not null;
  if verified_email is null then raise exception 'Verified identity required' using errcode = '42501'; end if;
  for item in select i.* from public.client_invitations i join public.businesses b on b.id = i.business_id
      where i.email = verified_email and i.expires_at > now() and i.claimed_by is null and b.status = 'active'
      for update of i loop
    insert into public.business_memberships(business_id, user_id, role) values(item.business_id, person, item.role)
      on conflict do nothing;
    update public.client_invitations set claimed_by = person where id = item.id;
    claimed := claimed + 1;
  end loop;
  return claimed;
end;
$$;

create function invoice_private.record_status(target uuid, device uuid, operation uuid, payload jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare person uuid := auth.uid(); previous public.client_devices%rowtype; contacted timestamptz := clock_timestamp(); codes text[];
begin
  if not invoice_private.member_allowed(target) or not exists(select 1 from public.businesses where id = target and status = 'active') then
    raise exception 'Active business membership required' using errcode = '42501';
  end if;
  if device is null or operation is null or jsonb_typeof(payload) <> 'object' or
      exists(select 1 from jsonb_object_keys(payload) k where k not in ('app_version','page','pending_count','sync_state','error_codes')) or
      not (payload ?& array['app_version','page','pending_count','sync_state','error_codes']) or
      not ((payload->>'app_version') ~ '^[a-zA-Z0-9._-]{1,32}$') or
      (payload->>'page') not in ('dashboard','invoice','customers','products','reports','settings') or
      (payload->>'sync_state') <> 'local_only' or
      jsonb_typeof(payload->'pending_count') <> 'number' or
      not ((payload->>'pending_count') ~ '^[0-9]{1,5}$') or (payload->>'pending_count')::integer > 10000 or
      jsonb_typeof(payload->'error_codes') <> 'array' then
    raise exception 'Invalid status payload' using errcode = '22023';
  end if;
  select array_agg(distinct c) into codes from jsonb_array_elements_text(payload->'error_codes') c;
  if coalesce(array_length(codes, 1), 0) > 4 or exists(select 1 from unnest(codes) c where c not in ('APP_ERROR','STORAGE_ERROR','PDF_ERROR','NETWORK_ERROR')) then
    raise exception 'Invalid error codes' using errcode = '22023';
  end if;
  -- Serializes concurrent device creation for this user; rate and device caps
  -- cannot be bypassed with parallel requests from multiple tabs.
  perform pg_advisory_xact_lock(hashtextextended(person::text, 0));
  select * into previous from public.client_devices where business_id = target and device_id = device;
  if found then
    if previous.user_id <> person then raise exception 'Device belongs to another user' using errcode = '42501'; end if;
    if previous.last_operation_id = operation then return previous.last_contact_at; end if;
    if previous.last_contact_at > contacted - interval '30 seconds' then return null; end if;
  else
    if (select count(*) from public.client_devices where user_id = person) >= 10 then
      raise exception 'Device limit reached' using errcode = '54000';
    end if;
  end if;
  insert into public.client_devices(business_id,device_id,user_id,last_operation_id,app_version,page,pending_count,sync_state,error_codes,last_contact_at)
    values(target,device,person,operation,payload->>'app_version',payload->>'page',(payload->>'pending_count')::integer,'local_only',coalesce(codes,'{}'),contacted)
    on conflict(business_id,device_id) do update set last_operation_id = excluded.last_operation_id,
      app_version = excluded.app_version, page = excluded.page, pending_count = excluded.pending_count,
      error_codes = excluded.error_codes, last_contact_at = excluded.last_contact_at;
  return contacted;
end;
$$;

create function invoice_private.submit_feedback(target uuid, operation uuid, message text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare person uuid := auth.uid(); existing public.client_feedback%rowtype;
begin
  if not invoice_private.member_allowed(target) then raise exception 'Business membership required' using errcode = '42501'; end if;
  if operation is null or message is null or char_length(btrim(message)) not between 1 and 2000 then raise exception 'Invalid feedback' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(person::text, 0));
  select * into existing from public.client_feedback where id = operation;
  if found then
    if existing.user_id <> person or existing.business_id <> target then raise exception 'Operation belongs to another user' using errcode = '42501'; end if;
    return existing.id;
  end if;
  if (select count(*) from public.client_feedback where user_id = person and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Daily feedback limit reached' using errcode = '54000';
  end if;
  insert into public.client_feedback(id,business_id,user_id,message) values(operation,target,person,btrim(message));
  return operation;
end;
$$;

create function invoice_private.enroll_business(business_name text, invite_email text, operation uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare created uuid; email text := lower(btrim(invite_email));
begin
  if not invoice_private.admin_allowed() then raise exception 'Owner MFA required' using errcode = '42501'; end if;
  if operation is null or business_name is null or char_length(btrim(business_name)) not between 1 and 120 or email is null or
    char_length(email) > 254 or email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid business or email' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(operation::text, 0));
  if exists(select 1 from public.businesses where id = operation) then
    if not exists(select 1 from public.businesses b join public.client_invitations i on i.business_id = b.id
        where b.id = operation and b.name = btrim(business_name) and i.email = email) then
      raise exception 'Enrollment operation conflicts' using errcode = '22023';
    end if;
    return operation;
  end if;
  insert into public.businesses(id,name) values(operation,btrim(business_name)) returning id into created;
  insert into public.business_licenses(business_id) values(created);
  insert into public.client_invitations(business_id,email) values(created,email);
  insert into public.owner_audit(actor_id,business_id,action) values(auth.uid(),created,'business_enrolled');
  return created;
end;
$$;

-- Safe, explicitly exposed API wrappers. Private implementations are not
-- callable by anon/PUBLIC and reject unauthorized identities internally.
create function public.is_owner_admin() returns boolean language sql stable security invoker set search_path = '' as $$ select invoice_private.admin_allowed(); $$;
create function public.claim_client_invitation() returns integer language sql security invoker set search_path = '' as $$ select invoice_private.claim_invitation(); $$;
create function public.record_client_status(target uuid, device uuid, operation uuid, payload jsonb) returns timestamptz language sql security invoker set search_path = '' as $$ select invoice_private.record_status(target,device,operation,payload); $$;
create function public.submit_client_feedback(target uuid, operation uuid, message text) returns uuid language sql security invoker set search_path = '' as $$ select invoice_private.submit_feedback(target,operation,message); $$;
create function public.enroll_client_business(business_name text, invite_email text, operation uuid) returns uuid language sql security invoker set search_path = '' as $$ select invoice_private.enroll_business(business_name,invite_email,operation); $$;

revoke all on function invoice_private.claim_invitation(), invoice_private.record_status(uuid,uuid,uuid,jsonb),
 invoice_private.submit_feedback(uuid,uuid,text), invoice_private.enroll_business(text,text,uuid) from public, anon;
grant execute on function invoice_private.claim_invitation(), invoice_private.record_status(uuid,uuid,uuid,jsonb),
 invoice_private.submit_feedback(uuid,uuid,text), invoice_private.enroll_business(text,text,uuid) to authenticated;
revoke all on function public.is_owner_admin(), public.claim_client_invitation(), public.record_client_status(uuid,uuid,uuid,jsonb),
 public.submit_client_feedback(uuid,uuid,text), public.enroll_client_business(text,text,uuid) from public, anon;
grant execute on function public.is_owner_admin(), public.claim_client_invitation(), public.record_client_status(uuid,uuid,uuid,jsonb),
 public.submit_client_feedback(uuid,uuid,text), public.enroll_client_business(text,text,uuid) to authenticated;
