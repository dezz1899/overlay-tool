create extension if not exists pgcrypto;

create type public.profile_role as enum ('admin','streamer','moderator','roleless');
create type public.overlay_version_kind as enum ('draft','published');

create table public.profiles (
  id text primary key,
  name text not null,
  password_hash text not null,
  view_key text not null,
  active_overlay_id uuid null,
  pending_active_overlay_id uuid null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profile_members (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  role public.profile_role not null default 'roleless',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, user_id)
);

create table public.overlays (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  name text not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.overlay_versions (
  id uuid primary key default gen_random_uuid(),
  overlay_id uuid not null references public.overlays(id) on delete cascade,
  kind public.overlay_version_kind not null,
  data jsonb not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.overlay_version_pointers (
  overlay_id uuid primary key references public.overlays(id) on delete cascade,
  current_draft_version_id uuid not null references public.overlay_versions(id),
  current_published_version_id uuid not null references public.overlay_versions(id),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_active_overlay_fk foreign key (active_overlay_id) references public.overlays(id),
  add constraint profiles_pending_overlay_fk foreign key (pending_active_overlay_id) references public.overlays(id);

create table public.profile_presence (
  profile_id text not null references public.profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  last_seen_at timestamptz not null default now(),
  primary key (profile_id, user_id)
);

create or replace function public.get_profile_role(p_profile_id text)
returns public.profile_role
language sql
stable
as $$
  select role from public.profile_members where profile_id = p_profile_id and user_id = auth.uid();
$$;

create or replace function public.assert_live_permission(p_profile_id text)
returns void language plpgsql as $$
declare r public.profile_role;
begin
  r := public.get_profile_role(p_profile_id);
  if r not in ('admin','streamer') then
    raise exception 'permission denied';
  end if;
end; $$;

create or replace function public.save_draft(p_overlay_id uuid, p_data jsonb)
returns void language plpgsql security definer as $$
declare p_profile_id text;
declare r public.profile_role;
declare v_id uuid;
begin
  select profile_id into p_profile_id from public.overlays where id = p_overlay_id and is_deleted = false;
  r := public.get_profile_role(p_profile_id);
  if r not in ('admin','streamer','moderator') then raise exception 'permission denied'; end if;
  insert into public.overlay_versions (overlay_id, kind, data, created_by) values (p_overlay_id, 'draft', p_data, auth.uid()) returning id into v_id;
  update public.overlay_version_pointers set current_draft_version_id = v_id, updated_at = now() where overlay_id = p_overlay_id;
end; $$;

create view public.overlay_view as
select o.id as overlay_id, o.profile_id, o.name,
  dv.data as draft_data,
  pv.data as published_data
from public.overlays o
join public.overlay_version_pointers ovp on ovp.overlay_id = o.id
join public.overlay_versions dv on dv.id = ovp.current_draft_version_id
join public.overlay_versions pv on pv.id = ovp.current_published_version_id
where not o.is_deleted;

alter table public.profiles enable row level security;
alter table public.profile_members enable row level security;
alter table public.overlays enable row level security;
alter table public.overlay_versions enable row level security;
alter table public.overlay_version_pointers enable row level security;
alter table public.profile_presence enable row level security;

create policy members_read_profiles on public.profiles for select using (
  exists(select 1 from public.profile_members pm where pm.profile_id = profiles.id and pm.user_id = auth.uid())
);
create policy members_update_profiles on public.profiles for update using (
  public.get_profile_role(id) in ('admin','streamer')
) with check (public.get_profile_role(id) in ('admin','streamer'));

create policy members_read_members on public.profile_members for select using (
  exists(select 1 from public.profile_members pm where pm.profile_id = profile_members.profile_id and pm.user_id = auth.uid())
);

create policy members_manage_overlays on public.overlays for all using (
  public.get_profile_role(profile_id) in ('admin','streamer')
);

create policy read_overlay_versions on public.overlay_versions for select using (
  exists(select 1 from public.overlays o join public.profile_members pm on pm.profile_id = o.profile_id where o.id = overlay_versions.overlay_id and pm.user_id = auth.uid())
);
create policy manage_draft_versions on public.overlay_versions for insert with check (
  kind = 'draft' and exists(select 1 from public.overlays o where o.id = overlay_id and public.get_profile_role(o.profile_id) in ('admin','streamer','moderator'))
);

create policy read_overlay_pointers on public.overlay_version_pointers for select using (
  exists(select 1 from public.overlays o where o.id = overlay_id and public.get_profile_role(o.profile_id) is not null)
);

create policy presence_select on public.profile_presence for select using (
  public.get_profile_role(profile_id) is not null
);
create policy presence_upsert on public.profile_presence for insert with check (
  user_id = auth.uid() and public.get_profile_role(profile_id) is not null
);
create policy presence_update on public.profile_presence for update using (
  user_id = auth.uid() and public.get_profile_role(profile_id) is not null
);
