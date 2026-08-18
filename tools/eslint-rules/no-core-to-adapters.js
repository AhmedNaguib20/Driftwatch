import path from 'node:path'

/**
 * Hard rule 1 (CLAUDE.md, spec §3.1): `src/core/**` must never import from `src/adapters/**`.
 *
 * Core is platform-agnostic — it takes input and returns JSON. Adapters know about exactly one
 * platform. If core ever reaches into an adapter the split is dead, and with it the "adding a
 * platform is days, not months" property the whole architecture is built on.
 *
 * This rule resolves every import specifier (static, dynamic, re-export, and `require`) against the
 * file that contains it and reports any that lands inside `src/adapters`.
 */

const CORE_DIR = path.join('src', 'core')
const ADAPTERS_DIR = path.join('src', 'adapters')

/** Bare/aliased specifiers that can only mean the adapters tree. */
const ALIASED_ADAPTER_PATTERNS = [
  /^driftwatch\/adapters(\/|$)/,
  /^@\/adapters(\/|$)/,
  /^~\/adapters(\/|$)/,
  /^src\/adapters(\/|$)/,
]

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow imports from src/adapters inside src/core — core must stay platform-agnostic.',
    },
    schema: [],
    messages: {
      forbidden:
        'src/core must not import from src/adapters (got "{{specifier}}"). Core is platform-agnostic: it returns JSON, and an adapter renders it. See CLAUDE.md hard rule 1 / spec §3.1.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename()
    const cwd = context.cwd ?? process.cwd()

    const coreRoot = path.join(cwd, CORE_DIR)
    const adaptersRoot = path.join(cwd, ADAPTERS_DIR)

    // Only files inside src/core are constrained.
    if (!isInside(coreRoot, path.resolve(filename))) return {}

    function check(node, specifier) {
      if (typeof specifier !== 'string' || specifier.length === 0) return

      let forbidden = false

      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filename), specifier)
        forbidden = isInside(adaptersRoot, resolved)
      } else {
        forbidden = ALIASED_ADAPTER_PATTERNS.some((re) => re.test(specifier))
      }

      if (forbidden) {
        context.report({ node, messageId: 'forbidden', data: { specifier } })
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) =>
        node.source.type === 'Literal' && check(node, node.source.value),
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return
        const [arg] = node.arguments
        if (arg && arg.type === 'Literal') check(node, arg.value)
      },
    }
  },
}

export default rule
