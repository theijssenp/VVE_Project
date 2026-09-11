-- 0011 — Actieve VvE op de apparaat-sessie (spec §7.5 stap 2, blok V02).
--
-- V02 is het eerste blok met tenant-scoped endpoints. De TenantGuard bepaalt
-- de actieve VvE uit het access-token (claim `vve_id`, "de client kiest
-- niets"). Die claim moet ergens vandaan komen en na elke token-rotatie
-- blijven bestaan: daarom staat de actieve VvE op de sessie-rij zelf.
--
-- Stroom: inloggen (geen claim) → `POST /auth/actieve-vve` → de service
-- controleert een lopende `rol_toewijzing` in die VvE, zet de kolom en tekent
-- een nieuw access-token mét `vve_id`. `verfris` erft de claim van de rij.
-- Een vve_id dat de client opgeeft wordt dus nooit klakkeloos overgenomen:
-- er hoort een lopende rol bij, gecontroleerd tegen de database van het moment.

ALTER TABLE apparaat_sessie
  ADD COLUMN actieve_vve_id bigint REFERENCES vve(id);