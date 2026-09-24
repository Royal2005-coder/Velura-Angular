-- Public catalog images uploaded from the admin product screen.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and policyname = 'Allow public uploads to product-images'
  ) then
    create policy "Allow public uploads to product-images"
    on storage.objects
    for insert
    to anon, authenticated
    with check (bucket_id = 'product-images');
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and policyname = 'Allow public reads from product-images'
  ) then
    create policy "Allow public reads from product-images"
    on storage.objects
    for select
    to anon, authenticated
    using (bucket_id = 'product-images');
  end if;
end $$;
