import path from 'node:path'

/**
 * Files whose CONTENT never leaves the machine, even inside a diff (hard rule 6 extension).
 * They still appear in the diffstat — the model may know the file changed; it may not see what
 * is in it. Matching is on the basename, case-insensitive.
 */
const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i, // often carries auth tokens
  /credential/i,
  /^secrets?(\..+)?$/i,
]

export function isSecretPath(repoRelativePath: string): boolean {
  const base = path.posix.basename(repoRelativePath)
  return SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(base))
}
