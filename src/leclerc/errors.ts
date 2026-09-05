/**
 * Raised when Leclerc's page/JSON no longer carries the fields we rely on.
 *
 * Ported from ncleton-petitmaker/leclerc-drive-mcp (MIT). The point is to fail
 * loudly when Leclerc changes its front-end, instead of silently returning
 * zeros / "unavailable" for everything — which is what a tolerant mapper does.
 */
export class ContractChangedError extends Error {
  constructor(message: string) {
    super(
      `${message} Le site Leclerc Drive a probablement changé de format : ` +
        `ouvre une issue avec la requête concernée (voir docs/api-capture.md).`,
    );
    this.name = "ContractChangedError";
  }
}
