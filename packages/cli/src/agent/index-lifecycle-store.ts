import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getConfigDir } from '../utils/paths'
import { isIndexJob, type IndexJob } from './context-intelligence-models'

export type IndexLifecycleStoreOptions = { rootDir?: string; now?: () => Date; maxJobs?: number }
const FILE_NAME = 'index-lifecycle.json'

function filePath(options?: IndexLifecycleStoreOptions): string { return path.join(options?.rootDir ? path.resolve(options.rootDir) : getConfigDir(), FILE_NAME) }
function now(options?: IndexLifecycleStoreOptions): string { return (options?.now || (() => new Date()))().toISOString() }
function read(options?: IndexLifecycleStoreOptions): IndexJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(options), 'utf8')) as unknown
    return Array.isArray(parsed) && parsed.every(isIndexJob) ? parsed : []
  } catch { return [] }
}
function write(jobs: IndexJob[], options?: IndexLifecycleStoreOptions): void {
  const target = filePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const bounded = jobs.slice(-Math.max(10, Math.min(options?.maxJobs || 500, 2_000)))
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(bounded), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
}

export function createIndexJob(job: Omit<IndexJob, 'schemaVersion' | 'jobId' | 'createdAt' | 'updatedAt'> & { jobId?: string; createdAt?: string; updatedAt?: string }, options?: IndexLifecycleStoreOptions): { ok: true; job: IndexJob } | { ok: false; message: string } {
  const timestamp = job.createdAt || now(options)
  const next: IndexJob = { schemaVersion: 1, ...job, jobId: job.jobId || `index-job-${crypto.randomUUID()}`, createdAt: timestamp, updatedAt: job.updatedAt || timestamp }
  if (!isIndexJob(next)) return { ok: false, message: 'Index job failed validation.' }
  const jobs = read(options)
  jobs.push(next)
  write(jobs, options)
  return { ok: true, job: next }
}

export function getIndexJob(jobId: string, options?: IndexLifecycleStoreOptions): IndexJob | undefined { return read(options).find(job => job.jobId === jobId) }
export function listIndexJobs(sourceId?: string, options?: IndexLifecycleStoreOptions): IndexJob[] { return read(options).filter(job => !sourceId || job.sourceId === sourceId) }
export function updateIndexJob(jobId: string, patch: Partial<IndexJob>, options?: IndexLifecycleStoreOptions): { ok: true; job: IndexJob } | { ok: false; message: string } {
  const jobs = read(options)
  const index = jobs.findIndex(job => job.jobId === jobId)
  if (index < 0) return { ok: false, message: 'Index job not found.' }
  const next = { ...jobs[index], ...patch, jobId, updatedAt: now(options) }
  if (!isIndexJob(next)) return { ok: false, message: 'Index job update failed validation.' }
  jobs[index] = next
  write(jobs, options)
  return { ok: true, job: next }
}

export function hasActiveIndexJob(sourceId: string, options?: IndexLifecycleStoreOptions): boolean {
  return listIndexJobs(sourceId, options).some(job => ['claimed', 'observing', 'running'].includes(job.status))
}
