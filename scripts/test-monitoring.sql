-- Run with ON_ERROR_STOP when using psql. All fixture writes roll back.
begin;
create function pg_temp.assert_true(value boolean, label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAIL: %', label; end if; raise notice 'PASS: %', label; end; $$;

insert into auth.users(id,email,email_confirmed_at) values
 ('10000000-0000-4000-8000-000000000001','client-a@example.test',now()),
 ('10000000-0000-4000-8000-000000000002','client-b@example.test',now()),
 ('10000000-0000-4000-8000-000000000003','owner@example.test',now()),
 ('10000000-0000-4000-8000-000000000004','outsider@example.test',now());
insert into auth.sessions(id,user_id) values('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003');
insert into invoice_private.owner_admins(user_id) values('10000000-0000-4000-8000-000000000003');
insert into public.businesses(id,name) values
 ('30000000-0000-4000-8000-000000000001','Business A'),('30000000-0000-4000-8000-000000000002','Business B');
insert into public.business_memberships(business_id,user_id,role) values
 ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner'),
 ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','owner');
insert into public.business_licenses(business_id) select id from public.businesses;
insert into public.client_invitations(business_id,email) values('30000000-0000-4000-8000-000000000001','client-a@example.test');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
select pg_temp.assert_true((select count(*) = 1 from public.businesses),'client sees only own business');
select pg_temp.assert_true((select count(*) = 1 from public.business_memberships),'client sees only own membership');
select pg_temp.assert_true((select count(*) = 1 from public.business_licenses),'client sees only own license');
select pg_temp.assert_true((select count(*) = 0 from public.client_invitations),'client cannot read invitation emails');
select pg_temp.assert_true(not public.is_owner_admin(),'client cannot impersonate owner');
select pg_temp.assert_true(public.claim_client_invitation() = 1,'verified email claims its own invitation');
select pg_temp.assert_true(public.claim_client_invitation() = 0,'claim is idempotent');
select pg_temp.assert_true(public.record_client_status('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
 '{"app_version":"2.1.0","page":"dashboard","pending_count":0,"sync_state":"local_only","error_codes":["APP_ERROR"]}') is not null,'member can report own device');
select pg_temp.assert_true(public.record_client_status('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
 '{"app_version":"2.1.0","page":"dashboard","pending_count":0,"sync_state":"local_only","error_codes":[]}') is not null,'status retry acknowledges same operation');
select pg_temp.assert_true((select count(*) = 1 from public.client_devices),'duplicate status does not duplicate device');
select pg_temp.assert_true(public.record_client_status('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002',
 '{"app_version":"2.1.0","page":"dashboard","pending_count":0,"sync_state":"local_only","error_codes":[]}') is null,'rapid new status is deferred instead of falsely acknowledged');
select public.submit_client_feedback('30000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','Please help');
select public.submit_client_feedback('30000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','Please help');
select pg_temp.assert_true((select count(*) = 1 from public.client_feedback),'feedback retries do not duplicate');
do $$ begin
  begin perform public.record_client_status('30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002',
    '{"app_version":"2.1.0","page":"dashboard","pending_count":0,"sync_state":"local_only","error_codes":[]}'); raise exception 'FAIL: cross business write';
  exception when insufficient_privilege then raise notice 'PASS: cross business status denied'; end;
  begin insert into public.business_memberships values('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','owner',true); raise exception 'FAIL: self enrollment';
  exception when insufficient_privilege then raise notice 'PASS: self enrollment denied'; end;
  begin perform public.enroll_client_business('Hacked','evil@example.test','30000000-0000-4000-8000-000000000003'); raise exception 'FAIL: client admin operation';
  exception when insufficient_privilege then raise notice 'PASS: client admin operation denied'; end;
  begin perform public.record_client_status('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002',
    '{"app_version":"2.1.0","page":"dashboard","pending_count":0,"sync_state":"local_only","error_codes":[],"customer":"private"}'); raise exception 'FAIL: private payload';
  exception when invalid_parameter_value then raise notice 'PASS: private payload fields rejected'; end;
end $$;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","app_metadata":{"admin":true},"user_metadata":{"admin":true}}',true);
select pg_temp.assert_true((select count(*) = 0 from public.client_devices),'other tenant cannot read device');
select pg_temp.assert_true((select count(*) = 0 from public.client_feedback),'other tenant cannot read feedback');
select pg_temp.assert_true(not public.is_owner_admin(),'metadata and MFA do not grant owner role');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"20000000-0000-4000-8000-000000000003"}',true);
select pg_temp.assert_true(not public.is_owner_admin(),'owner without MFA denied');
select pg_temp.assert_true((select count(*) = 0 from public.businesses),'owner cannot read clients before MFA');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2","session_id":"20000000-0000-4000-8000-000000000003"}',true);
select pg_temp.assert_true(public.is_owner_admin(),'owner with MFA and live session allowed');
select pg_temp.assert_true((select count(*) = 2 from public.businesses),'owner can read all pilot clients');
select public.enroll_client_business('New business','new-client@example.test','30000000-0000-4000-8000-000000000003');
select public.enroll_client_business('New business','new-client@example.test','30000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*) = 3 from public.businesses),'owner can create invited business');
select pg_temp.assert_true((select count(*) = 2 from public.client_invitations),'enrollment retries do not duplicate invitations');
select pg_temp.assert_true((select count(*) = 1 from public.owner_audit),'owner action is audited');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2","session_id":"20000000-0000-4000-8000-000000000099"}',true);
select pg_temp.assert_true(not public.is_owner_admin(),'revoked/nonexistent session denied');
set local role anon;
do $$ begin
  begin perform public.is_owner_admin(); raise exception 'FAIL: anonymous API';
  exception when insufficient_privilege then raise notice 'PASS: anonymous RPC denied'; end;
end $$;
reset role;
select pg_temp.assert_true((select bool_and(relrowsecurity) from pg_class where oid in ('public.businesses'::regclass,'public.business_memberships'::regclass,'public.business_licenses'::regclass,'public.client_devices'::regclass,'public.client_feedback'::regclass)),'all exposed tenant tables use RLS');
rollback;
