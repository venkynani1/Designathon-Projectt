-- Organizer can choose the desk PIN (changing it signs every distributor out).
create or replace function admin_desk_set_pin(p_event uuid, p_pin text, p_actor uuid) returns jsonb language plpgsql as $$
declare d distribution_desk; v_pin text := btrim(coalesce(p_pin, ''));
begin
  if v_pin !~ '^[0-9]{4,8}$' then perform dx_raise('INVALID_INPUT', 'PIN must be 4–8 digits'); end if;
  perform admin_desk_get(p_event);
  update distribution_desk set pin = v_pin, pin_version = pin_version + 1, updated_at = now()
   where event_id = p_event returning * into d;
  perform dx_audit(p_event, 'admin', p_actor::text, 'desk.pin_changed', 'desk', p_event::text, null, null);
  return jsonb_build_object('pin', d.pin, 'version', d.pin_version);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
