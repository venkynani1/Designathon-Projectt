-- Public live feed no longer includes who picked what (counts only).
create or replace function survey_feed(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'event', e.name,
    'open', e.goodies_open,
    'list_required', exists (select 1 from goodie_roster where event_id = e.id),
    'goodies', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', g.id, 'name', g.name, 'description', g.description, 'stock', g.stock,
                  'left', greatest(g.stock - dx_goodie_taken(g.id), 0), 'image', dx_goodie_image(g))
                order by g.sort_order, g.name)
                from goodies g where g.event_id = e.id and g.is_active), '[]'::jsonb),
    'chosen_total', (select count(*) from goodie_choices where event_id = e.id),
    'at', now())
  from events e where e.id = p_event;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
