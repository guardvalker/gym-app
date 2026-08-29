-- ============================================================================
-- gym-app — schema Supabase para sync entre dispositivos de UN solo usuario
-- (sin concepto de "rutina compartida" ni código de invitación: cada cuenta
-- ve únicamente sus propios datos). Ejecutar completo en el SQL Editor del
-- dashboard del proyecto compartido `bonapps` (Database > SQL Editor > New
-- query > pegar todo > Run).
--
-- A diferencia de lista-super (varias tablas granulares para poder mergear
-- cambios concurrentes de distintos miembros), acá alcanza con un solo
-- registro por usuario que guarda el mismo JSON que ya arma el botón
-- "Exportar" de la app (templates + logs) — un solo dueño de los datos no
-- necesita diff por fila, y esto es mucho menos código de mantener.
-- ============================================================================

create table if not exists gy_data (
  usuario_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table gy_data enable row level security;

-- RLS por sí sola no alcanza si el rol `authenticated` no tiene ni el
-- permiso base (mismo motivo que en lista-super/schema.sql).
grant select, insert, update, delete on gy_data to authenticated;

-- Cada cuenta puede leer/escribir únicamente su propia fila.
create policy "gy_data_all" on gy_data
  for all using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());
