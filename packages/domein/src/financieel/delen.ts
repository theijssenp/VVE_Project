/**
 * `financieel` — proefmodule voor `packages/domein` (F01).
 *
 * PURE TypeScript: geen NestJS, geen databaseclient, geen `Date`/`Date.now()`, geen `fetch`.
 * De volledige `Bedrag`/`Verdeler`-abstractie komt in F05 (§5.2, §7.3). Dit blokket levert
 * bewust een klein, unit-testbaar bouwsteen die de pure-TS-kader toetst zonder database of HTTP.
 */

/** Som van een rij gehele- centen-bedragen. `centen` zijn always safe integers. */
export function somCenten(centen: readonly number[]): number {
  let totaal = 0;
  for (const c of centen) {
    if (!Number.isSafeInteger(c)) {
      throw new Error(`Geld is uitsluitend hele centen; ontvangen: ${String(c)}`);
    }
    totaal += c;
  }
  return totaal;
}

/**
 * Grootste-restmethode (kern van §5.2) op een rij gehele delen, zonder float.
 *
 * Deel `totaal` (in centen) onder `aandeel` gewichten zodanig dat de som van de
 * resultaten exact gelijk is aan `totaal`. Restcenten gaan een-voor-een naar de
 * eenheden met de grootste fractie — dus de som is always exact.
 *
 * @throws Error als een gewicht negatief is of alle gewichten nul zijn.
 */
export function verdeelGrootsteRest(totaal: number, aandeel: ReadonlyArray<number>): number[] {
  if (!Number.isSafeInteger(totaal)) {
    throw new Error(`Totaal moet in hele centen: ${String(totaal)}`);
  }
  if (aandeel.length === 0) {
    throw new Error('Aandeel mag niet leeg zijn');
  }

  let somGewichten = 0;
  for (const g of aandeel) {
    if (g < 0) {
      throw new Error(`Gewicht mag niet negatief zijn: ${String(g)}`);
    }
    somGewichten += g;
  }
  if (somGewichten === 0) {
    throw new Error('Som van gewichten is nul');
  }

  // Eén pass: per gewicht de exacte (float) verdeling en de afgeronde basiswaarde.
  // Bewaar de objecten zelf, zodat we nooit op index terug moeten (noUncheckedIndexedAccess).
  const delen = aandeel.map((gewicht, i) => {
    const exact = (totaal * gewicht) / somGewichten;
    return { exact, floor: Math.floor(exact), i };
  });

  // De rest (totaal - som van de afgeronde delen) gaat één per eenheid naar de grootste fractie.
  let rest = totaal - delen.reduce((s, d) => s + d.floor, 0);
  const orden = [...delen].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.i - b.i,
  );
  for (const d of orden) {
    if (rest <= 0) {
      break;
    }
    d.floor += 1;
    rest -= 1;
  }

  // Resultaat in de oorspronkelijke volgorde; som is exact afgedwongen (anders is het een bug).
  const som = delen.reduce((s, d) => s + d.floor, 0);
  if (som !== totaal) {
    throw new Error('Som van verdeling komt niet overeen met totaal');
  }
  return delen.map((d) => d.floor);
}
