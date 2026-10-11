// Framework management — the catalog of installable skills/plugins, what each
// workspace has installed, and which agents have a skill enabled.
//
// The Homebrew keg ships only binaries, so `modules/` lives in the framework
// source checkout. That tree IS the catalog: `bwoc skill install <path>`
// copies from it into a workspace.

import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import * as bwoc from './bwoc.mjs'

export const FRAMEWORK_SRC =
  process.env.BWOC_FRAMEWORK_SRC || path.join(homedir(), 'src', 'BWOC-Framework-build')

const MODULES = path.join(FRAMEWORK_SRC, 'modules')

/** Read `name = "x"` / `description = "y"` out of a manifest.toml without a TOML dep. */
async function readManifest(file) {
  try {
    const text = await readFile(file, 'utf8')
    const pick = (key) => {
      const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))
      return m ? m[1] : null
    }
    return {
      name: pick('name'),
      version: pick('version'),
      description: pick('description'),
      maturity: pick('maturity'),
      kind: pick('kind'),
      compat: pick('compat'),
    }
  } catch {
    return null
  }
}

/**
 * Walk the catalog. Skills are always one level deep; plugins may be grouped
 * (`plugins/workflow/accounting-api`), so descend one extra level when a
 * directory has no manifest of its own.
 */
async function catalogOf(kind) {
  const root = path.join(MODULES, kind === 'skill' ? 'skills' : 'plugins')
  if (!existsSync(root)) return []
  const out = []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    const manifest = await readManifest(path.join(dir, 'manifest.toml'))
    if (manifest) {
      out.push({ id: e.name, group: null, path: dir, ...manifest })
      continue
    }
    const kids = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const k of kids) {
      if (!k.isDirectory()) continue
      const kdir = path.join(dir, k.name)
      const km = await readManifest(path.join(kdir, 'manifest.toml'))
      if (km) out.push({ id: k.name, group: e.name, path: kdir, ...km })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export async function catalog() {
  const [skills, plugins] = await Promise.all([catalogOf('skill'), catalogOf('plugin')])
  return { source: FRAMEWORK_SRC, available: existsSync(MODULES), skills, plugins }
}

/** Which agents have each framework skill enabled, read from their manifests. */
async function skillMatrix(wsPath) {
  const listed = await bwoc.listAgents(wsPath)
  const agents = listed?.data?.agents ?? []
  const rows = await Promise.all(
    agents.map(async (a) => {
      const dir = a.path.split('/').pop()
      let entries = []
      try {
        const manifest = JSON.parse(
          await readFile(path.join(wsPath, a.path, 'config.manifest.json'), 'utf8'),
        )
        entries = manifest?.skills?.framework ?? []
      } catch {
        // No manifest is not an error here — the agent simply has no skills.
      }
      return {
        agent: a.id,
        dir,
        skills: entries.map((s) => ({ name: s.name, enabled: s.enabled !== false })),
      }
    }),
  )
  return rows
}

export async function workspaceFrameworks(wsPath) {
  const [skills, plugins, matrix] = await Promise.all([
    bwoc.skills(wsPath),
    bwoc.plugins(wsPath),
    skillMatrix(wsPath),
  ])
  return {
    skills: skills?.data?.skills ?? [],
    plugins: plugins?.data?.plugins ?? [],
    agents: matrix,
  }
}

/** Resolve a catalog id to its source path — the trust boundary for installs. */
export async function resolveCatalogPath(kind, id) {
  const items = kind === 'skill' ? await catalogOf('skill') : await catalogOf('plugin')
  const hit = items.find((i) => i.id === id)
  if (!hit) {
    const err = new Error(`"${id}" is not in the ${kind} catalog at ${MODULES}`)
    err.code = 404
    throw err
  }
  return hit.path
}

/** Runtime configuration the UI shows on the Fleet settings page. */
export async function runtimeSettings() {
  const version = await bwoc.version()
  let frameworkTag = null
  try {
    const { stdout } = await import('node:child_process').then(
      (cp) =>
        new Promise((resolve, reject) =>
          cp.execFile(
            'git',
            ['-C', FRAMEWORK_SRC, 'describe', '--tags', '--always'],
            (e, so, se) => (e ? reject(e) : resolve({ stdout: so, stderr: se })),
          ),
        ),
    )
    frameworkTag = stdout.trim()
  } catch {
    frameworkTag = null
  }

  const workspaces = await bwoc.discoverWorkspaces()
  let mtime = null
  try {
    mtime = (await stat(MODULES)).mtime.toISOString()
  } catch {
    /* catalog absent — reported via catalog().available */
  }

  return {
    bwoc: { version: version.version, bin: process.env.BWOC_BIN || 'bwoc', info: version.info },
    framework: { source: FRAMEWORK_SRC, tag: frameworkTag, modulesMtime: mtime },
    fleet: {
      workspaceRoot: bwoc.WORKSPACE_ROOT,
      workspaces: workspaces.filter((w) => w.isWorkspace).length,
      nonWorkspaces: workspaces.filter((w) => !w.isWorkspace).map((w) => w.name),
    },
    server: {
      port: Number(process.env.PORT || 8791),
      bindHost: process.env.BIND_HOST || '127.0.0.1',
      serveStatic: process.env.SERVE_STATIC === '1',
      inContainer: existsSync('/.dockerenv'),
      nodeVersion: process.version,
    },
    orchestrator: {
      harnessBin: process.env.BWOC_HARNESS_BIN || 'bwoc-harness',
      endpoint: process.env.BWOC_HARNESS_ENDPOINT || 'http://localhost:11434/v1',
      model: process.env.BWOC_HARNESS_MODEL || 'gemma4:latest',
      plannerUrl: process.env.BWOC_PLANNER_URL || null,
      planTimeoutMs: Number(process.env.BWOC_PLAN_TIMEOUT_MS || 300_000),
      runTimeoutS: Number(process.env.BWOC_RUN_TIMEOUT_S || 900),
    },
  }
}
