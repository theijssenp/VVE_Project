/**
 * Drizzle-schema — tabel `audit_log` (spec §6.8, blok F09).
 *
 * Moet exact overeenkomen met `migraties/0007_audit_log.sql`. Append-only met
 * een hashketen: `eigen_hash = sha256(vorige_hash ‖ canonieke JSON van de
 * regel)`. De applicatierol heeft uitsluitend INSERT (migratie 0007).
 */

import { bigint, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { persoon } from './persoon.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    vveId: bigint('vve_id', { mode: 'bigint' }),
    persoonId: bigint('persoon_id', { mode: 'bigint' }).references(() => persoon.id),
    gebeurtenis: text('gebeurtenis').notNull(),
    categorie: text('categorie').notNull().default('app'),
    onderwerpTabel: text('onderwerp_tabel'),
    onderwerpId: bigint('onderwerp_id', { mode: 'bigint' }),
    details: jsonb('details'),
    ipAdres: text('ip_adres'),
    gebruikerAgent: text('gebruiker_agent'),
    gebeurtenisOp: timestamp('gebeurtenis_op', { withTimezone: true }).notNull().defaultNow(),
    vorigeHash: text('vorige_hash'),
    eigenHash: text('eigen_hash').notNull(),
  },
  (tabel) => [index('ix_audit_vve_op').on(tabel.vveId, tabel.gebeurtenisOp)],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NieuweAuditLog = typeof auditLog.$inferInsert;