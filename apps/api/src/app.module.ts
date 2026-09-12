/** Hoofdmodule — bundelt de databaseverbinding en de functionele modules. */
import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { BankModule } from './bank/bank.module.js';
import { FinancieelModule } from './financieel/financieel.module.js';
import { GrootboekModule } from './financieel/grootboek.module.js';
import { BegrotingModule } from './financieel/begroting.module.js';
import { VerdeelsleutelModule } from './financieel/verdeelsleutel.module.js';
import { BijdrageModule } from './financieel/bijdrage.module.js';
import { NotaModule } from './financieel/nota.module.js';
import { NotaVerzendModule } from './financieel/nota-verzend.module.js';
import { BetalingModule } from './financieel/betaling.module.js';
import { AanmaningModule } from './financieel/aanmaning.module.js';
import { DebiteurenModule } from './financieel/debiteuren.module.js';
import { LeverancierModule } from './financieel/leverancier.module.js';
import { MededelingModule } from './financieel/mededeling.module.js';
import { EigenaarschapModule } from './financieel/eigenaarschap.module.js';
import { DocumentenModule } from './financieel/documenten.module.js';
import { PortaalModule } from './modules/portaal/portaal.module.js';
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
    BankModule,
    VerdeelsleutelModule,
    BegrotingModule,
    BijdrageModule,
    NotaModule,
    NotaVerzendModule,
    BetalingModule,
    DebiteurenModule,
    LeverancierModule,
    MededelingModule,
    EigenaarschapModule,
    DocumentenModule,
    PortaalModule,
    AanmaningModule,
  ],
})
export class AppModule {}
