// Building the URL for a request this API forwards to the host sidecar.
//
// The sub-path comes from the caller's request, so it is checked before it is
// joined onto the sidecar's base URL: every segment must be a plain name, and
// the result must still be on the sidecar's origin and under the route prefix
// it was meant for. The API forwards only to the two prefixes it names.

const SEGMENT = /^[\w.%~-]+$/

const bad = (why) => Object.assign(new Error(`bad sidecar path: ${why}`), { code: 400 })

/**
 * @param {string} base      sidecar base URL (BWOC_PLANNER_URL)
 * @param {'/root/'|'/gateway/'} prefix
 * @param {string[]} segments path segments after the prefix, as received
 * @param {string} search     the request's query string, including `?`, or ''
 */
export function sidecarUrl(base, prefix, segments, search = '') {
  for (const s of segments) {
    if (s === '.' || s === '..' || !SEGMENT.test(s)) throw bad('unexpected segment')
  }
  const origin = new URL(base).origin
  const target = new URL(`${prefix}${segments.join('/')}${search}`, origin)
  if (target.origin !== origin || !target.pathname.startsWith(prefix)) throw bad('escapes its prefix')
  return target
}
