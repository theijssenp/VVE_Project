/**
 * De SMTP-verzender van F10 — in deze fase een stub die de tekst in het log
 * schrijft; de echte nodemailer-transport volgt bij de livegang (de wachtrij
 * zelf is al hetzelfde pad). Tests injecteren hun eigen verzender.
 *
 * Bewust geen geheimen in het log (§8.2): registratielinks en teksten van
 * gevoelige berichten horen daar niet.
 */
export class LogVerzender {
  verzend(bericht: {
    readonly ontvangerEmail: string;
    readonly onderwerp: string;
    readonly tekst: string;
  }): Promise<void> {
    console.log(
      `[mail] aan ${bericht.ontvangerEmail}: ${bericht.onderwerp} (${String(bericht.tekst.length)} tekens, wachtrij verzendt via SMTP zodra die is aangesloten)`,
    );
    return Promise.resolve();
  }
}
