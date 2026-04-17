create table if not exists public.dashboard_state (
  workspace_id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.dashboard_state enable row level security;

create or replace function public.set_dashboard_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_dashboard_state_updated_at on public.dashboard_state;

create trigger trg_dashboard_state_updated_at
before update on public.dashboard_state
for each row
execute function public.set_dashboard_state_updated_at();

drop policy if exists "dashboard_state_select_anon" on public.dashboard_state;
create policy "dashboard_state_select_anon"
on public.dashboard_state
for select
to anon
using (true);

drop policy if exists "dashboard_state_insert_anon" on public.dashboard_state;
create policy "dashboard_state_insert_anon"
on public.dashboard_state
for insert
to anon
with check (true);

drop policy if exists "dashboard_state_update_anon" on public.dashboard_state;
create policy "dashboard_state_update_anon"
on public.dashboard_state
for update
to anon
using (true)
with check (true);
