/**
 * Proefbalans, saldibalans en grootboek — endpoints van blok B07 (M9 · AC9.8).
 *
 * Drie routes die samen het auditspoor vormen, elk een stap fijner:
 * de balans over alle rekeningen, het grootboek van één rekening, en de
 * boeking achter één mutatie mét de verwijzing naar de bron.
 *
 * Alles is lezen. Er staat dan ook geen geldstroomrecht op: `boekhouding.lezen`
 * valt buiten `GELDSTROOM_RECHTEN`, want meekijken in de cijfers is precies wat
 * een kascommissie moet kunnen zonder tweede factor (§8.5 beschermt het
 * *muteren* van geld, niet het inzien ervan).
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DATABASE } from '../database/database.module.js';
import { VereistRecht } from '../gemeenschappelijk/auth/vereist-recht.js';
import { RolSessieGuard, TenantSessieGuard } from '../gemeenschappelijk/auth/tenant-guards.js';
import { SessieGuard } from '../modules/auth/sessie.guard.js';
import { NietGevondenFout } from './boekhouding.js';
import {
  maakBalansService,
  type BalansService,
  type BoekingDetail,
  type GrootboekWeergave,
  type ProefSaldiBalans,
} from './balans-service.js';
import {
  maakJaarrekeningService,
  type Jaarrekening,
  type JaarrekeningService,
} from './jaarrekening-service.js';
import { bouwJaarrekeningPdf, bouwJaarrekeningXlsx } from './jaarrekening-export.js';
import {
  maakAfrekeningService,
  type Afrekening,
  type AfrekeningService,
} from './afrekening-service.js';
import { InvoerFout } from './boekhouding.js';
import {
  maakAfsluitingService,
  type AfsluitUitkomst,
  type AfsluitingService,
  type KascommissieDossier,
} from './afsluiting-service.js';

interface MetInlog extends Request {
  inlogContext?: { persoonId: bigint; vveId: bigint | null };
}

/** ISO-kalenderdatum; `date`-kolommen ondergaan nooit tijdzoneconversie (§5.8). */
const DATUM = /^\d{4}-\d{2}-\d{2}$/;

function idUit(waarde: string, veld: string): bigint {
  if (!/^\d+$/.test(waarde)) throw new BadRequestException(`Ongeldig ${veld}.`);
  return BigInt(waarde);
}

@Controller('financieel')
@UseGuards(SessieGuard, TenantSessieGuard, RolSessieGuard)
export class BalansController {
  readonly #balans: BalansService;
  readonly #jaarrekening: JaarrekeningService;
  readonly #afrekening: AfrekeningService;
  readonly #afsluiting: AfsluitingService;

  constructor(@Inject(DATABASE) db: NodePgDatabase) {
    this.#balans = maakBalansService({ db });
    this.#jaarrekening = maakJaarrekeningService({ db });
    this.#afrekening = maakAfrekeningService({ db });
    this.#afsluiting = maakAfsluitingService({ db });
  }

  #eisTenant(verzoek: MetInlog): bigint {
    const inlog = verzoek.inlogContext;
    if (inlog === undefined || inlog.vveId === null) {
      throw new ForbiddenException('Geen actieve VvE in de sessie.');
    }
    return inlog.vveId;
  }

  /** De servicefouten kennen geen HTTP; hier pas de vertaling. */
  #alsHttp(fout: unknown): never {
    if (fout instanceof NietGevondenFout) throw new NotFoundException(fout.message);
    if (fout instanceof InvoerFout) throw new BadRequestException(fout.message);
    throw fout;
  }

  /**
   * Proef- en saldibalans over een boekjaar. `peildatum` beperkt tot boekingen
   * tot en met die dag — nodig voor een tussentijdse stand, bijvoorbeeld voor
   * de kascommissie halverwege het jaar.
   */
  @Get('proefbalans/:boekjaarId')
  @VereistRecht('boekhouding.lezen')
  async proefbalans(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
    @Query('peildatum') peildatum?: string,
  ): Promise<ProefSaldiBalans> {
    const vveId = this.#eisTenant(verzoek);
    if (peildatum !== undefined && peildatum !== '' && !DATUM.test(peildatum)) {
      throw new BadRequestException('peildatum moet de vorm YYYY-MM-DD hebben.');
    }
    try {
      return await this.#balans.proefSaldiBalans(
        vveId,
        idUit(boekjaarId, 'boekjaar-id'),
        peildatum === undefined || peildatum === '' ? null : peildatum,
      );
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /** De mutaties van één rekening, chronologisch, met lopend saldo. */
  @Get('grootboek/:boekjaarId/:rekeningId')
  @VereistRecht('boekhouding.lezen')
  async grootboek(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
    @Param('rekeningId') rekeningId: string,
  ): Promise<GrootboekWeergave> {
    const vveId = this.#eisTenant(verzoek);
    try {
      return await this.#balans.grootboek(
        vveId,
        idUit(boekjaarId, 'boekjaar-id'),
        idUit(rekeningId, 'rekening-id'),
      );
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /** De laatste stap van AC9.8: de boeking zelf, met bron en bron-id. */
  @Get('boeking/:id')
  @VereistRecht('boekhouding.lezen')
  async boeking(@Req() verzoek: MetInlog, @Param('id') id: string): Promise<BoekingDetail> {
    const vveId = this.#eisTenant(verzoek);
    try {
      return await this.#balans.boekingDetail(vveId, idUit(id, 'boeking-id'));
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /** De jaarrekening als gegevens (AC9.4); PDF en XLSX hieronder. */
  @Get('jaarrekening/:boekjaarId')
  @VereistRecht('boekhouding.lezen')
  async jaarrekening(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
  ): Promise<Jaarrekening> {
    const vveId = this.#eisTenant(verzoek);
    try {
      return await this.#jaarrekening.jaarrekening(vveId, idUit(boekjaarId, 'boekjaar-id'));
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /**
   * Jaarrekening als PDF of XLSX (AC9.4). Eén route met een formaatparameter en
   * niet twee: de inhoud is identiek, alleen de verpakking verschilt, en zo kan
   * er geen verschil tussen de twee ontstaan.
   */
  @Get('jaarrekening/:boekjaarId/export.:formaat')
  @VereistRecht('boekhouding.lezen')
  async exporteer(
    @Req() verzoek: MetInlog,
    @Res({ passthrough: true }) antwoord: Response,
    @Param('boekjaarId') boekjaarId: string,
    @Param('formaat') formaat: string,
  ): Promise<StreamableFile> {
    const vveId = this.#eisTenant(verzoek);
    if (formaat !== 'pdf' && formaat !== 'xlsx') {
      throw new BadRequestException('Formaat moet "pdf" of "xlsx" zijn.');
    }
    let jr: Jaarrekening;
    try {
      jr = await this.#jaarrekening.jaarrekening(vveId, idUit(boekjaarId, 'boekjaar-id'));
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
    const bytes = formaat === 'pdf' ? bouwJaarrekeningPdf(jr) : bouwJaarrekeningXlsx(jr);
    const bestandsnaam = `jaarrekening-${String(jr.jaar)}.${formaat}`;
    antwoord.set({
      'Content-Type':
        formaat === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // `attachment` en niet `inline`: dit is een stuk voor de ALV dat mensen
      // bewaren, geen pagina om even in de browser te bekijken.
      'Content-Disposition': `attachment; filename="${bestandsnaam}"`,
    });
    return new StreamableFile(bytes);
  }

  /**
   * Afrekening servicekosten per eenheid (AC9.5), met de pro-rataverdeling bij
   * een eigenaarswissel binnen het jaar (AC9.6).
   *
   * Alleen berekenen en tonen. Het genereren van nota's of creditnota's hieruit
   * gebeurt pas na goedkeuring in de ALV, en dat is een muterende handeling die
   * bij A03 (besluitenregister) hoort — niet bij dit leesendpoint.
   */
  @Get('afrekening/:boekjaarId')
  @VereistRecht('boekhouding.lezen')
  async afrekening(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
  ): Promise<Afrekening> {
    const vveId = this.#eisTenant(verzoek);
    try {
      return await this.#afrekening.afrekening(vveId, idUit(boekjaarId, 'boekjaar-id'));
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /**
   * Boekjaar afsluiten (AC9.3): resultaatbestemming, vergrendelen, status.
   *
   * `boekjaar.afsluiten` staat op de geldstroomlijst (§8.5), dus hier eist de
   * RolGuard een tweede factor — dit is de handeling die een jaar definitief
   * dichtzet.
   */
  @Post('boekjaren/:boekjaarId/sluiten')
  @VereistRecht('boekjaar.afsluiten')
  async sluitAf(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
    @Body() body: { naarReservefondsCent?: unknown },
  ): Promise<AfsluitUitkomst> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId;
    if (persoonId === undefined) throw new ForbiddenException('Geen inlogcontext.');
    const naar = body.naarReservefondsCent;
    if (naar !== undefined && (typeof naar !== 'number' || !Number.isInteger(naar))) {
      throw new BadRequestException('naarReservefondsCent moet een geheel aantal centen zijn.');
    }
    try {
      return await this.#afsluiting.sluitAf(
        vveId,
        idUit(boekjaarId, 'boekjaar-id'),
        naar === undefined ? {} : { naarReservefondsCent: naar },
        persoonId,
      );
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /** AC9.7: het kascommissiedossier — boekingen, banksaldi, verklaringen. */
  @Get('kascommissie/:boekjaarId')
  @VereistRecht('boekhouding.lezen')
  async kascommissie(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
  ): Promise<KascommissieDossier> {
    const vveId = this.#eisTenant(verzoek);
    try {
      return await this.#afsluiting.kascommissieDossier(vveId, idUit(boekjaarId, 'boekjaar-id'));
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }

  /** AC9.7: aftekenen. Bezwaar is net zo goed een uitkomst als akkoord. */
  @Post('kascommissie/:boekjaarId/aftekenen')
  @VereistRecht('boekhouding.aftekenen')
  async tekenAf(
    @Req() verzoek: MetInlog,
    @Param('boekjaarId') boekjaarId: string,
    @Body() body: { akkoord?: unknown; bevindingen?: unknown },
  ): Promise<{ id: bigint }> {
    const vveId = this.#eisTenant(verzoek);
    const persoonId = verzoek.inlogContext?.persoonId;
    if (persoonId === undefined) throw new ForbiddenException('Geen inlogcontext.');
    if (typeof body.akkoord !== 'boolean') {
      throw new BadRequestException('Veld "akkoord" is verplicht (true of false).');
    }
    const bevindingen = typeof body.bevindingen === 'string' ? body.bevindingen : null;
    try {
      return await this.#afsluiting.tekenAf(
        vveId,
        idUit(boekjaarId, 'boekjaar-id'),
        { akkoord: body.akkoord, bevindingen },
        persoonId,
      );
    } catch (fout: unknown) {
      return this.#alsHttp(fout);
    }
  }
}
