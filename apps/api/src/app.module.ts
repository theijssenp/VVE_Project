/** Hoofdmodule — bundelt de databaseverbinding en de functionele modules. */
import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { FinancieelModule } from './financieel/financieel.module.js';
import { GrootboekModule } from './financieel/grootboek.module.js';
import { BegrotingModule } from './financieel/begroting.module.js';
import { VerdeelsleutelModule } from './financieel/verdeelsleutel.module.js';
import { BijdrageModule } from './financieel/bijdrage.module.js';
import { NotaModule } from './financieel/nota.module.js';
import { NotaVerzendModule } from './financieel/nota-verzend.module.js';
import { BetalingModule } from './financieel/betaling.module.js';
import { DebiteurenModule } from './financieel/debiteuren.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { EenhedenModule } from './modules/eenheden/eenheden.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { UitnodigingenModule } from './modules/uitnodigingen/uitnodigingen.module.js';
import { VveModule } from './modules/vve/vve.module.js';

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    VveModule,
    EenhedenModule,
    UitnodigingenModule,
    GrootboekModule,
    FinancieelModule,
    VerdeelsleutelModule,
    BegrotingModule,
    BijdrageModule,
    NotaModule,
    NotaVerzendModule,
    BetalingModule,
    DebiteurenModule,
  ],
})
export class AppModule {}
