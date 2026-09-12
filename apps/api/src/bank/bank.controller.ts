/**
 * Bankendpoints — blok B02 (AC7.1–7.3).
 *
 * Twee routes: een bankrekening opvoeren, en een CAMT.053-bestand inlezen.
 *
 * De import is een muterende handeling maar géén geldstroomrecht (§8.5): er
 * gaat geen geld weg, er komt informatie binnen. Het opvoeren van een
 * bankrekening is dat wél — dat bepaalt waar de administratie naar kijkt, en
 * §8.5 noemt de IBAN-wijziging met zoveel woorden als vier-ogen-handeling.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../database/database.module.js';
import { bankImport, bankrekening } from '../database/schema/bank.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { inTenantTransactie } from '../gemeenschappelijk/tenant/tenant-context.js';
import { InvoerFout, NietGevondenFout } from '../financieel/boekhouding.js';
import {
  maakBankimportService,
  type BankimportService,
  type ImportUitkomst,
} from './bankimport-service.js';
import {
  OngeldigIbanFout,
  beveiligIban,
  laadIbanSleutels,
  normaliseerIban,
} from './iban-versleuteling.js';

interface MetInlog extends Request {
  inlogContext?: { persoonId: bigint; vveId: bigint | null };
}

@Controller('bank')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class BankController {
  readonly #db: NodePgDatabase;
  readonly #import: BankimportService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#db = db;
    this.#import = maakBankimportService({ db });
  }

  #eisTenant(verzoek: MetInlog): { vveId: bigint; persoonId: bigint } {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return { vveId: inlog.vveId, persoonId: inlog.persoonId };
  }

  #alsHttp(fout: unknown): never {
    if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
    if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
    if (fout instanceof OngeldigIbanFout) throw new BadRequestException(fout.message);
    throw fout;
  }

  /** De bankrekeningen van de VvE, met masker — nooit de volledige IBAN. */
  @Get('rekeningen')
  @VereistRecht('bank.lezen')
  async rekeningen(@Req() verzoek: MetInlog): Promise<unknown> {
    const { vveId } = this.#eisTenant(verzoek);
    return inTenantTransactie(this.#db, vveId, async (tx) =>
      tx
        .select({
          id: bankrekening.id,
          naam: bankrekening.naam,
          ibanMasker: bankrekening.ibanMasker,
          laatsteSaldoCent: bankrekening.laatsteSaldoCent,
          laatsteSaldoDatum: bankrekening.laatsteSaldoDatum,
          actief: bankrekening.actief,
        })
        .from(bankrekening)
        .where(eq(bankrekening.vveId, vveId)),
    );
  }

  /**
   * Bankrekening opvoeren. Recht `vve.iban.wijzig` staat op de geldstroomlijst,
   * dus hier eist de RolGuard een tweede factor — dit bepaalt waar het geld
   * van de VvE langskomt.
   */
  @Post('rekeningen')
  @VereistRecht('vve.iban.wijzig')
  async voegRekeningToe(
    @Req() verzoek: MetInlog,
    @Body() body: { naam?: unknown; iban?: unknown },
  ): Promise<{ id: bigint; ibanMasker: string }> {
    const { vveId } = this.#eisTenant(verzoek);
    if (typeof body.naam !== 'string' || body.naam.trim() === '') {
      throw new BadRequestException('Veld "naam" is verplicht.');
    }
    if (typeof body.iban !== 'string') {
      throw new BadRequestException('Veld "iban" is verplicht.');
    }
    try {
      const drieluik = beveiligIban(normaliseerIban(body.iban), laadIbanSleutels());
      return await inTenantTransactie(this.#db, vveId, async (tx) => {
        const [rij] = await tx
          .insert(bankrekening)
          .values({
            vveId,
            naam: body.naam as string,
            ibanVersleuteld: drieluik.versleuteld,
            ibanHmac: drieluik.hmac,
            ibanMasker: drieluik.masker,
            sleutelVersie: drieluik.sleutelVersie,
          })
          .returning({ id: bankrekening.id, ibanMasker: bankrekening.ibanMasker });
        if (rij === undefined) throw new InvoerFout('Deze bankrekening bestaat al.');
        return rij;
      });
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /** De laatste imports, met het eventuele continuïteitsgat (AC7.3). */
  @Get('imports')
  @VereistRecht('bank.lezen')
  async imports(@Req() verzoek: MetInlog): Promise<unknown> {
    const { vveId } = this.#eisTenant(verzoek);
    return inTenantTransactie(this.#db, vveId, async (tx) =>
      tx
        .select()
        .from(bankImport)
        .where(eq(bankImport.vveId, vveId))
        .orderBy(desc(bankImport.aangemaaktOp))
        .limit(50),
    );
  }

  /**
   * CAMT.053 inlezen. Het bestand komt als tekst in de body en niet als
   * multipart-upload: een afschrift is XML van enkele honderden kilobytes, en
   * een uploadpad erbij zou een tweede plek zijn waar bestanden binnenkomen —
   * met een eigen MIME-afhandeling die niemand nodig heeft.
   */
  @Post('import/camt053')
  @VereistRecht('bank.importeren')
  async importeer(
    @Req() verzoek: MetInlog,
    @Body() body: { xml?: unknown; bestandsnaam?: unknown },
  ): Promise<readonly ImportUitkomst[]> {
    const { vveId, persoonId } = this.#eisTenant(verzoek);
    if (typeof body.xml !== 'string' || body.xml.trim() === '') {
      throw new BadRequestException('Veld "xml" met de inhoud van het afschrift is verplicht.');
    }
    const bestandsnaam = typeof body.bestandsnaam === 'string' ? body.bestandsnaam : null;
    try {
      return await this.#import.importeerCamt053(vveId, body.xml, { bestandsnaam }, persoonId);
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }
}
