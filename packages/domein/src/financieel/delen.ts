/**
 * `financieel` — proefmodule voor `packages/domein` (F01).
 *
 * PURE TypeScript: geen NestJS, geen databaseclient, geen `Date`/`Date.now()`, geen `fetch`.
 * De volledige `Bedrag`/`Verdeler`-abstractie volgt in F05 (§5.2, §7.3). Dit blok levert
 * bewust één kleine, unit-testbare bouwsteen die het pure-TS-kader toetst zonder database of HTTP.
 */

/** Grens waarbinnen gehele centen exact representeerbaar zijn in een IEEE-754 double. */
const MAX_VEILIG = Number.MAX_SAFE_INTEGER;

/** Som van een rij bedragen in hele centen. */
export function somCenten(centen: readonly number[]): number {
  let totaal = 0;
  for (const c of centen) {
    if (!Number.isSafeInteger(c)) {
      throw new Error(`Geld is uitsluitend hele centen; ontvangen: ${String(c)}`);
    }
    totaal += c;
    // De accumulator kan de veilige grens overschrijden ook al is elke term op zichzelf geldig.
    if (!Number.isSafeInteger(totaal)) {
      throw new Error('Som van centen overschrijdt de veilige integerruimte');
    }
  }
  return totaal;
}

/**
 * Grootste-restmethode volgens spec §5.2.
 *
 * Verdeelt `totaal` (in hele centen) over `gewichten` zodat de som van de resultaten
 * exact gelijk is aan `totaal`. Restcenten gaan één voor één naar de eenheden met de
 * grootste fractionele rest; bij gelijke rest naar de laagste index. Die tweede regel
 * maakt de uitkomst deterministisch — zonder haar zou dezelfde begroting op twee
 * momenten een andere nota kunnen opleveren.
 *
 * Gewichten mogen fractioneel zijn (m²-sleutels staan in de database als `numeric(14,4)`,
 * spec §6.5). De berekening blijft exact zolang het product `totaal × gewicht` binnen
 * `Number.MAX_SAFE_INTEGER` valt; dat wordt hieronder afgedwongen in plaats van aangenomen.
 *
 * @throws Error bij een niet-geheel totaal, een lege of negatieve gewichtenreeks,
 *               een som van nul, of een product buiten de veilige integerruimte.
 */
export function verdeelGrootsteRest(totaal: number, gewichten: ReadonlyArray<number>): number[] {
  if (!Number.isSafeInteger(totaal)) {
    throw new Error(`Totaal moet in hele centen: ${String(totaal)}`);
  }
  if (gewichten.length === 0) {
    throw new Error('Gewichten mogen niet leeg zijn');
  }

  let somGewichten = 0;
  for (const g of gewichten) {
    if (!Number.isFinite(g) || g < 0) {
      throw new Error(`Gewicht moet eindig en niet-negatief zijn: ${String(g)}`);
    }
    if (Math.abs(totaal) * g > MAX_VEILIG) {
      throw new Error(
        `Product totaal × gewicht valt buiten de veilige integerruimte (${String(totaal)} × ${String(g)})`,
      );
    }
    somGewichten += g;
  }
  if (somGewichten === 0) {
    throw new Error('Som van de gewichten is nul');
  }

  // Stap 1-2 van §5.2: het exacte aandeel en de naar beneden afgeronde basis per eenheid.
  const delen = gewichten.map((gewicht, i) => {
    const exact = (totaal * gewicht) / somGewichten;
    const basis = Math.floor(exact);
    return { fractie: exact - basis, toegekend: basis, i };
  });

  // Stap 3-5: de rest één cent per eenheid, aflopend op fractie, bij gelijkspel op index.
  let rest = totaal - delen.reduce((s, d) => s + d.toegekend, 0);
  const opFractie = [...delen].sort((a, b) => b.fractie - a.fractie || a.i - b.i);
  for (const d of opFractie) {
    if (rest <= 0) {
      break;
    }
    d.toegekend += 1;
    rest -= 1;
  }

  // De invariant uit §5.2. Faalt deze, dan is het een bug en geen afrondingskwestie.
  const som = delen.reduce((s, d) => s + d.toegekend, 0);
  if (som !== totaal) {
    throw new Error(`Verdeling telt op tot ${String(som)} in plaats van ${String(totaal)}`);
  }
  return delen.map((d) => d.toegekend);
}
