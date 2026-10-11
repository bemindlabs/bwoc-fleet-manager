// Project browser + file editor backend.
//
// Every path a caller sends is untrusted. The boundary is one project
// directory (`<workspace>/projects/<name>`), resolved through realpath so a
// symlink cannot lead out of it, and a deny list keeps secrets and git
// internals out of both the tree and the editor — they are never listed,
// read, or written.

import { execFile } from 'node:child_process'
import { chmod, lstat, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAX_FILE_BYTES = 1024 * 1024
const MAX_ENTRIES = 2000
const GIT_TIMEOUT_MS = 5000

class FileError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

// Matched against every path segment, both as requested and after realpath.
const DENY_DIRS = new Set(['.git', '.secrets', '.ssh', '.gnupg'])
const DENY_FILE = /^\.env(\..+)?$|\.(pem|key|p12|pfx|keystore|jks)$|^id_(rsa|ed25519|ecdsa)(\.pub)?$|^\.npmrc$|^\.netrc$/i
const ENV_EXAMPLE = /^\.env\.(example|sample|template)$/i

function denied(segments) {
  return segments.some((s, i) => {
    if (DENY_DIRS.has(s)) return true
    // Only the last segment is a file; a directory named `.env` is still denied.
    if (ENV_EXAMPLE.test(s) && i === segments.length - 1) return false
    return DENY_FILE.test(s)
  })
}

const isInside = (root, target) => target === root || target.startsWith(root + path.sep)

/** The project's real directory. `name` must be one entry of `projects/`. */
async function projectRoot(wsPath, name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new FileError(`bad project name: ${name}`, 400)
  }
  const projects = await realpath(path.join(wsPath, 'projects')).catch(() => null)
  if (!projects) throw new FileError('this workspace has no projects/ directory', 404)
  const root = await realpath(path.join(projects, name)).catch(() => null)
  if (!root || !(await stat(root)).isDirectory()) throw new FileError(`unknown project: ${name}`, 404)
  return root
}

/**
 * Resolve `rel` inside the project. Returns the real target path.
 * Rejects absolute paths, NUL bytes, `..` escapes, symlinks that lead out,
 * and anything on the deny list (checked before and after realpath).
 */
async function resolveInside(root, rel = '') {
  if (typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel)) {
    throw new FileError('bad path', 400)
  }
  const requested = path.resolve(root, rel)
  if (!isInside(root, requested)) throw new FileError('path escapes the project', 403)
  if (denied(path.relative(root, requested).split(path.sep).filter(Boolean))) {
    throw new FileError('that path is not available in the editor', 403)
  }
  const real = await realpath(requested).catch(() => null)
  if (!real) throw new FileError(`not found: ${rel || '.'}`, 404)
  if (!isInside(root, real)) throw new FileError('path escapes the project', 403)
  if (denied(path.relative(root, real).split(path.sep).filter(Boolean))) {
    throw new FileError('that path is not available in the editor', 403)
  }
  return real
}

function git(cwd, args) {
  return new Promise((resolve) => {
    // core.fsmonitor=false: a repo's config must not be able to run a command
    // just because the dashboard asked for its status.
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    )
  })
}

async function gitInfo(dir) {
  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === null) return null
  const [status, last] = await Promise.all([
    git(dir, ['status', '--porcelain']),
    git(dir, ['log', '-1', '--format=%h%x09%cI%x09%s']),
  ])
  const [hash, date, ...subject] = (last ?? '').trim().split('\t')
  return {
    branch: branch.trim(),
    dirty: status === null ? null : status.split('\n').filter(Boolean).length,
    lastCommit: hash ? { hash, date, subject: subject.join('\t') } : null,
  }
}

/** `projects/*` of a workspace, with git branch / dirty count / last commit. */
export async function listProjects(wsPath) {
  const dir = path.join(wsPath, 'projects')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
      .map(async (e) => {
        const root = await projectRoot(wsPath, e.name).catch(() => null)
        if (!root) return null
        return { name: e.name, git: await gitInfo(root) }
      }),
  )
  return rows.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
}

/** One directory level. Denied entries are left out, not flagged. */
export async function listDir(wsPath, project, rel = '') {
  const root = await projectRoot(wsPath, project)
  const dir = await resolveInside(root, rel)
  if (!(await stat(dir)).isDirectory()) throw new FileError('not a directory', 400)
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const e of entries) {
    if (denied([e.name])) continue
    let type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : null
    if (e.isSymbolicLink()) {
      // Show a link only when it resolves inside the project.
      const target = await realpath(path.join(dir, e.name)).catch(() => null)
      if (!target || !isInside(root, target)) continue
      if (denied(path.relative(root, target).split(path.sep).filter(Boolean))) continue
      type = (await stat(target)).isDirectory() ? 'dir' : 'file'
    }
    if (!type) continue
    out.push({ name: e.name, type, path: path.relative(root, path.join(dir, e.name)) })
    if (out.length >= MAX_ENTRIES) break
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return { path: path.relative(root, dir), entries: out, truncated: out.length >= MAX_ENTRIES }
}

export async function readProjectFile(wsPath, project, rel) {
  const root = await projectRoot(wsPath, project)
  const file = await resolveInside(root, rel)
  const st = await stat(file)
  if (!st.isFile()) throw new FileError('not a file', 400)
  if (st.size > MAX_FILE_BYTES) {
    return { path: rel, size: st.size, mtimeMs: st.mtimeMs, tooLarge: true, content: null }
  }
  const buf = await readFile(file)
  // A NUL byte in the first 8 KiB is a good-enough binary sniff.
  if (buf.subarray(0, 8192).includes(0)) {
    return { path: rel, size: st.size, mtimeMs: st.mtimeMs, binary: true, content: null }
  }
  return { path: rel, size: st.size, mtimeMs: st.mtimeMs, content: buf.toString('utf8') }
}

/**
 * Overwrite an existing file. `mtimeMs` must match what the editor loaded —
 * an agent may have written the file since, and silently clobbering its
 * work is worse than asking the human to reload.
 */
export async function writeProjectFile(wsPath, project, rel, content, mtimeMs) {
  if (typeof content !== 'string') throw new FileError('content must be a string', 400)
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new FileError('file is larger than 1 MiB', 413)
  const root = await projectRoot(wsPath, project)
  const file = await resolveInside(root, rel)
  const st = await stat(file)
  if (!st.isFile()) throw new FileError('not a file', 400)
  if (typeof mtimeMs !== 'number' || Math.abs(st.mtimeMs - mtimeMs) > 1) {
    throw new FileError('the file changed on disk since you opened it — reload before saving', 409)
  }
  // Write-then-rename so a crash never leaves half a file. `file` is the real
  // path, so a symlink inside the project is followed, not replaced.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.fm-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(tmp, content, { flag: 'wx' })
    // Set the mode explicitly — `writeFile`'s mode is filtered by the umask.
    await chmod(tmp, st.mode & 0o7777)
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  const after = await lstat(file)
  return { path: rel, size: after.size, mtimeMs: after.mtimeMs }
}
