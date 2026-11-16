-- Organizer login IDs may be a simple ID like "admin.com" (not only a full email address).
create or replace function upsert_admin_user(p_email text, p_display_name text, p_role admin_role,
                                             p_can_issue boolean, p_password_hash text)
returns jsonb language plpgsql as $$
declare v_email text := lower(btrim(p_email)); v_id uuid;
begin
  if v_email !~ '^[a-z0-9._@+-]{3,200}$' then perform dx_raise('INVALID_INPUT', 'Invalid login ID'); end if;
  select user_id into v_id from admin_users where lower(email) = v_email;
  if v_id is null then
    insert into admin_users (email, display_name, role, can_issue_credentials, password_hash)
    values (v_email, p_display_name, p_role, coalesce(p_can_issue, false), p_password_hash) returning user_id into v_id;
  else
    update admin_users set display_name = coalesce(p_display_name, display_name), role = p_role,
           can_issue_credentials = coalesce(p_can_issue, can_issue_credentials),
           password_hash = coalesce(p_password_hash, password_hash), is_active = true
     where user_id = v_id;
    update admin_sessions set revoked_at = now() where user_id = v_id and revoked_at is null and p_password_hash is not null;
  end if;
  perform dx_audit(null, 'system', 'cli', 'admin.upserted', 'admin', v_id::text, null,
                   jsonb_build_object('email', v_email, 'role', p_role, 'can_issue', p_can_issue, 'password_set', p_password_hash is not null));
  return jsonb_build_object('user_id', v_id, 'email', v_email, 'role', p_role);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
