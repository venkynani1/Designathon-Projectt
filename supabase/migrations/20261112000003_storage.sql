-- Private bucket for problem statement documents. Files are served only through
-- short-lived signed URLs minted server-side for verified team sessions.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('problem-docs', 'problem-docs', false, 20971520,
        array['application/pdf', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('goodie-images', 'goodie-images', true)
on conflict (id) do nothing;
