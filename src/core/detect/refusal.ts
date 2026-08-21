/**
 * A refusal the CLI prints verbatim: driftwatch knows what it would need and says so, instead of
 * guessing (spec §9a — do the work you can, refuse the part you cannot, name the remedy).
 */
export class SelectionRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectionRefused'
  }
}
