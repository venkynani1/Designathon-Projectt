-- Example event + arena content. Adjust before go-live.
insert into events (code, name, tagline, venue, problems_qr_url, goodies_qr_url, allowed_email_domains)
values ('designathon-x', 'Gen AI Designathon', 'Design. Build. Delight.', 'Main Auditorium',
        'https://designathon-x.vercel.app/arena/problems', 'https://designathon-x.vercel.app/arena/goodies', null)
on conflict (code) do nothing;

insert into problem_statements (event_id, code, title, summary, capacity, sort_order)
select e.id, v.code, v.title, v.summary, v.capacity, v.sort_order
from events e, (values
  ('PS-01', 'Inclusive onboarding', 'Redesign first-day onboarding for neurodiverse employees.', 5, 1),
  ('PS-02', 'Frictionless expenses', 'Make expense claims a 60-second mobile task.', 5, 2),
  ('PS-03', 'Meeting-free Fridays', 'Design async collaboration rituals that actually stick.', 5, 3)
) as v(code, title, summary, capacity, sort_order)
where e.code = 'designathon-x'
on conflict (event_id, code) do nothing;

insert into goodies (event_id, name, description, stock, sort_order)
select e.id, v.name, v.description, v.stock, v.sort_order
from events e, (values
  ('Hoodie', 'Gen AI Designathon hoodie (size chosen at pickup)', 60, 1),
  ('Water bottle', 'Insulated steel bottle', 80, 2),
  ('Sketchbook kit', 'Dot-grid sketchbook + fineliners', 60, 3)
) as v(name, description, stock, sort_order)
where e.code = 'designathon-x' and not exists (select 1 from goodies g where g.event_id = e.id and g.name = v.name);

-- Create the first organizer account with:
--   DATABASE_URL=... node scripts/create-admin.mjs you@company.com superadmin "Your Name" --issuer
-- Problem statement documents: set problem_statements.document_url to a https:// link (Drive, SharePoint, ...).
