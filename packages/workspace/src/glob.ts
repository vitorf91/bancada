/**
 * Minimal glob to RegExp for absolute POSIX paths. Supports `**` (any depth, including none), `*` and `?`
 * (within one segment). Everything else is literal. `**\/x` matches `x` at any depth, `x/**` matches
 * `x` and everything under it.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        const slashAfter = glob.charAt(i + 2) === '/'
        const slashBefore = i > 0 && glob.charAt(i - 1) === '/'
        if (slashAfter) {
          out += '(?:.*/)?'
          i += 2
        } else if (slashBefore) {
          // `a/**` : drop the slash already emitted so `a` itself matches too.
          out = `${out.slice(0, -1)}(?:/.*)?`
          i += 1
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

export function matchesAnyGlob(globs: readonly string[], target: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(target))
}
