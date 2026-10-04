create or replace function invoice_private.enroll_business(business_name text, invite_email text, operation uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare created uuid; normalized_email text := lower(btrim(invite_email));
begin
  if not invoice_private.admin_allowed() then raise exception 'Owner MFA required' using errcode = '42501'; end if;
  if operation is null or business_name is null or char_length(btrim(business_name)) not between 1 and 120 or normalized_email is null or
    char_length(normalized_email) > 254 or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid business or email' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(operation::text, 0));
  if exists(select 1 from public.businesses where id = operation) then
    if not exists(select 1 from public.businesses b join public.client_invitations i on i.business_id = b.id
        where b.id = operation and b.name = btrim(business_name) and i.email = normalized_email) then
      raise exception 'Enrollment operation conflicts' using errcode = '22023';
    end if;
    return operation;
  end if;
  insert into public.businesses(id,name) values(operation,btrim(business_name)) returning id into created;
  insert into public.business_licenses(business_id) values(created);
  insert into public.client_invitations(business_id,email) values(created,normalized_email);
  insert into public.owner_audit(actor_id,business_id,action) values(auth.uid(),created,'business_enrolled');
  return created;
end;
$$;
