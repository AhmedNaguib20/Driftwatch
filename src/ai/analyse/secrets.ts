import path from 'node:path'

/**
 * Files whose CONTENT never leaves the machine, even inside a diff (hard rule 6 extension).
 * They still appear in the diffstat — the model may know the file changed; it may not see what
 * is in it. Matching is on the basename, case-insensitive.
 */
export interface SecretPattern {
  readonly pattern: RegExp
  /** How the README names it. Paired with the regex so the docs cannot drift from the code. */
  readonly label: string
}

export const SECRET_BASENAME_PATTERNS: readonly SecretPattern[] = [
  { pattern: /^\.env(\..+)?$/i, label: '`.env` and `.env.*`' },
  { pattern: /\.(pem|key|p12|pfx|jks|keystore)$/i, label: '`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`' },
  { pattern: /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i, label: '`id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`' },
  { pattern: /^\.netrc$/i, label: '`.netrc`' },
  { pattern: /^\.npmrc$/i, label: '`.npmrc` (it often carries auth tokens)' },
  { pattern: /credential/i, label: 'any basename containing `credential`' },
  { pattern: /^secrets?(\..+)?$/i, label: '`secret` / `secrets` and their extensions' },
]

export function isSecretPath(repoRelativePath: string): boolean {
  const base = path.posix.basename(repoRelativePath)
  return SECRET_BASENAME_PATTERNS.some(({ pattern }) => pattern.test(base))
}
