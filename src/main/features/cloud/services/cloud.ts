import {
  CloudDatesheet,
  CloudDatesheetGameEntry,
  CloudDatesheetLockInfo,
  CloudDatesheetSideStatus,
  CloudDatesheetStatusReport,
  CloudGameStatus,
  CloudGameSummary,
  CloudStorageRole,
  CloudTaskPhase,
  CloudTaskProgress,
  configLocalDocs,
  DEFAULT_GAME_LOCAL_VALUES,
  gameLocalDoc
} from '@appTypes/models'
import { generateUUID, getErrorMessage } from '@appUtils'
import { app } from 'electron'
import log from 'electron-log/main'
import fse from 'fs-extra'
import path from 'path'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { ConfigDBManager, GameDBManager } from '~/core/database'
import { ipcManager } from '~/core/ipc'
import { ActiveGameInfo } from '~/features/game/services'
import { isPathWithinRoot, normalizePath, pathEquals } from '~/utils'

const DATESHEET_FILE = '.vnite-cloud-datesheet.json'
const DATESHEET_TMP = '.vnite-cloud-datesheet.json.tmp'
const DATESHEET_BAK = '.vnite-cloud-datesheet.json.bak'
const DATESHEET_LOCK = '.vnite-cloud-datesheet.lock'
const DATESHEET_CORRUPT_PREFIX = '.vnite-cloud-datesheet.corrupt'
const TMP_DIR = '.vnite-tmp'
const DEFAULT_VOLUME_SIZE_BYTES = 2 * 1024 * 1024 * 1024
const DATESHEET_LOCK_TIMEOUT_MS = 30 * 60 * 1000

type CloudStorageConfig = configLocalDocs['game']['cloudStorage']
type CloudConfigUpdate = Partial<CloudStorageConfig> & { initializeDatesheet?: boolean }
type DateSheetReadResult =
  | { status: 'ok'; datesheet: CloudDatesheet; recoveredFromBackup: boolean }
  | {
      status:
        | 'missing'
        | 'corrupted'
        | 'unrecoverable'
        | 'schemaUnsupported'
        | 'roleMismatch'
        | 'lockBusy'
        | 'lockTimeout'
      error?: string
    }

interface FileManifest {
  fileNames: string[]
  fileCount: number
  sizeBytes: number
  fileListHash: string
}

interface CloudTaskState {
  progress: CloudTaskProgress
  canceled: boolean
  previousCloud?: gameLocalDoc['cloud']
  child?: ChildProcessWithoutNullStreams
}

const tasksById = new Map<string, CloudTaskState>()
const taskIdByGameId = new Map<string, string>()
const datesheetQueues = new Map<string, Promise<unknown>>()
let archiveIoQueue: Promise<void> = Promise.resolve()

class CloudArchiveError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = `CloudArchiveError:${code}`
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function cloneGameLocal(data: Partial<gameLocalDoc> | null | undefined): gameLocalDoc {
  return {
    ...(JSON.parse(JSON.stringify(DEFAULT_GAME_LOCAL_VALUES)) as gameLocalDoc),
    ...(data || {}),
    path: { ...DEFAULT_GAME_LOCAL_VALUES.path, ...(data?.path || {}) },
    launcher: {
      ...DEFAULT_GAME_LOCAL_VALUES.launcher,
      ...(data?.launcher || {}),
      fileConfig: {
        ...DEFAULT_GAME_LOCAL_VALUES.launcher.fileConfig,
        ...(data?.launcher?.fileConfig || {})
      },
      urlConfig: {
        ...DEFAULT_GAME_LOCAL_VALUES.launcher.urlConfig,
        ...(data?.launcher?.urlConfig || {})
      },
      scriptConfig: {
        ...DEFAULT_GAME_LOCAL_VALUES.launcher.scriptConfig,
        ...(data?.launcher?.scriptConfig || {})
      }
    },
    utils: { ...DEFAULT_GAME_LOCAL_VALUES.utils, ...(data?.utils || {}) },
    cloud: { ...DEFAULT_GAME_LOCAL_VALUES.cloud, ...(data?.cloud || {}) }
  }
}

function normalizeConfig(config: Partial<CloudStorageConfig> | undefined): CloudStorageConfig {
  return {
    enabled: Boolean(config?.enabled),
    cloudRoot: config?.cloudRoot || '',
    localRoot: config?.localRoot || '',
    localLimitBytes:
      typeof config?.localLimitBytes === 'number' && config.localLimitBytes > 0
        ? Math.floor(config.localLimitBytes)
        : 0,
    archiveFormat: '7z',
    volumeSizeBytes:
      typeof config?.volumeSizeBytes === 'number' && config.volumeSizeBytes > 0
        ? Math.floor(config.volumeSizeBytes)
        : DEFAULT_VOLUME_SIZE_BYTES,
    sevenZipPath: config?.sevenZipPath || '',
    autoImportNewGames: Boolean(config?.autoImportNewGames)
  }
}

function datesheetPath(root: string): string {
  return path.join(root, DATESHEET_FILE)
}
function datesheetTmpPath(root: string): string {
  return path.join(root, DATESHEET_TMP)
}
function datesheetBakPath(root: string): string {
  return path.join(root, DATESHEET_BAK)
}
function datesheetLockPath(root: string): string {
  return path.join(root, DATESHEET_LOCK)
}
function datesheetCorruptPath(root: string): string {
  return path.join(root, `${DATESHEET_CORRUPT_PREFIX}-${Date.now()}.json`)
}
function getGameStoragePath(root: string, gameId: string, label: string): string {
  if (!gameId || path.isAbsolute(gameId) || gameId.includes('/') || gameId.includes('\\')) {
    throw new CloudArchiveError(`Invalid gameId for ${label}`, 'invalidGameId')
  }
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, gameId)
  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    throw new CloudArchiveError(`Invalid gameId for ${label}`, 'invalidGameId')
  }
  return resolvedPath
}
function getLocalManagedPath(config: CloudStorageConfig, gameId: string): string {
  return getGameStoragePath(config.localRoot, gameId, 'local cache path')
}
function getArchiveDir(config: CloudStorageConfig, gameId: string): string {
  return getGameStoragePath(config.cloudRoot, gameId, 'cloud archive path')
}
function getArchivePartPath(config: CloudStorageConfig, gameId: string, part: string): string {
  return path.join(getArchiveDir(config, gameId), part)
}
async function pathExists(filePath: string): Promise<boolean> {
  return await fse.pathExists(filePath)
}

async function directoryHasContent(root: string): Promise<boolean> {
  try {
    if (!(await pathExists(root))) return false
    const names = await fse.readdir(root)
    return names.some(
      (name) =>
        name !== DATESHEET_FILE &&
        name !== DATESHEET_TMP &&
        name !== DATESHEET_BAK &&
        name !== DATESHEET_LOCK &&
        !name.startsWith(DATESHEET_CORRUPT_PREFIX)
    )
  } catch {
    return false
  }
}

async function ensureWritableDirectory(dirPath: string, label: string): Promise<void> {
  if (!dirPath) throw new CloudArchiveError(`${label} cannot be empty`, 'pathEmpty')
  await fse.ensureDir(dirPath)
  const testFile = path.join(dirPath, `.vnite-write-test-${Date.now()}`)
  try {
    await fse.writeFile(testFile, 'ok', 'utf-8')
  } catch (error) {
    throw new CloudArchiveError(
      `${label} is not writable: ${getErrorMessage(error)}`,
      'pathNotWritable'
    )
  } finally {
    await fse.remove(testFile).catch(() => {})
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fse.readFile(filePath, 'utf-8')) as T
}

function emptyLockInfo(): CloudDatesheetLockInfo {
  return {
    exists: false,
    expired: false,
    operationId: '',
    pid: 0,
    createdAt: '',
    ageMs: 0,
    error: ''
  }
}

async function readDatesheetLock(root: string): Promise<CloudDatesheetLockInfo> {
  const lockPath = datesheetLockPath(root)
  if (!root || !(await pathExists(lockPath))) return emptyLockInfo()
  try {
    const lock = await readJsonFile<{ operationId?: string; pid?: number; createdAt?: string }>(
      lockPath
    )
    const createdAt = typeof lock.createdAt === 'string' ? lock.createdAt : ''
    const createdAtMs = createdAt ? new Date(createdAt).getTime() : 0
    const ageMs = createdAtMs > 0 ? Date.now() - createdAtMs : Number.MAX_SAFE_INTEGER
    return {
      exists: true,
      expired: ageMs > DATESHEET_LOCK_TIMEOUT_MS,
      operationId: typeof lock.operationId === 'string' ? lock.operationId : '',
      pid: typeof lock.pid === 'number' ? lock.pid : 0,
      createdAt,
      ageMs,
      error: ''
    }
  } catch (error) {
    return {
      exists: true,
      expired: true,
      operationId: '',
      pid: 0,
      createdAt: '',
      ageMs: Number.MAX_SAFE_INTEGER,
      error: getErrorMessage(error)
    }
  }
}

async function acquireDatesheetLock(
  root: string,
  operationId: string
): Promise<() => Promise<void>> {
  const lock = await readDatesheetLock(root)
  if (lock.exists) {
    if (lock.expired)
      throw new CloudArchiveError('Datesheet lock is stale and needs user cleanup', 'lockTimeout')
    throw new CloudArchiveError('Datesheet is busy with another operation', 'lockBusy')
  }

  const lockPath = datesheetLockPath(root)
  await fse.writeFile(
    lockPath,
    JSON.stringify({ operationId, pid: process.pid, createdAt: nowIso() }, null, 2),
    'utf-8'
  )

  return async () => {
    try {
      const current = await readDatesheetLock(root)
      if (!current.exists || current.operationId === operationId || current.pid === process.pid) {
        await fse.remove(lockPath)
      }
    } catch (error) {
      log.warn('[Cloud] Failed to release datesheet lock:', error)
    }
  }
}
function isValidDateString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(new Date(value).getTime())
}

function assertRelativeStringList(
  values: unknown,
  field: string,
  requireSorted: boolean
): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new CloudArchiveError(`Invalid datesheet ${field}`, 'schemaInvalid')
  }
  const strings = values as string[]
  if (strings.some((value) => path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value))) {
    throw new CloudArchiveError(`Datesheet ${field} must use relative paths`, 'schemaInvalid')
  }
  if (requireSorted) {
    const sorted = [...strings].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (strings.some((value, index) => value !== sorted[index])) {
      throw new CloudArchiveError(`Datesheet ${field} must be sorted`, 'schemaInvalid')
    }
  }
  return strings
}

function validateDatesheetGameEntry(entry: CloudDatesheetGameEntry, gameId: string): void {
  if (!entry || typeof entry !== 'object')
    throw new CloudArchiveError('Invalid datesheet game entry', 'schemaInvalid')
  if (entry.gameId !== gameId || typeof entry.gameName !== 'string' || !entry.gameName) {
    throw new CloudArchiveError('Invalid datesheet game identity', 'schemaInvalid')
  }
  if (!['local', 'cloud', 'syncing', 'error'].includes(entry.status))
    throw new CloudArchiveError('Invalid datesheet game status', 'schemaInvalid')
  if (typeof entry.localManagedPath !== 'string' || typeof entry.archiveDir !== 'string')
    throw new CloudArchiveError('Invalid datesheet game paths', 'schemaInvalid')
  const fileNames = assertRelativeStringList(entry.fileNames, 'fileNames', true)
  const archiveParts = assertRelativeStringList(entry.archiveParts, 'archiveParts', true)
  if (!Number.isFinite(entry.sizeBytes) || entry.sizeBytes < 0)
    throw new CloudArchiveError('Invalid datesheet sizeBytes', 'schemaInvalid')
  if (
    !Number.isInteger(entry.fileCount) ||
    entry.fileCount < 0 ||
    entry.fileCount !== fileNames.length
  )
    throw new CloudArchiveError('Invalid datesheet fileCount', 'schemaInvalid')
  if (typeof entry.fileListHash !== 'string' || !entry.fileListHash)
    throw new CloudArchiveError('Invalid datesheet fileListHash', 'schemaInvalid')
  if (typeof entry.archiveRevision !== 'string' || typeof entry.localRevision !== 'string')
    throw new CloudArchiveError('Invalid datesheet revisions', 'schemaInvalid')
  if (!isValidDateString(entry.lastVerifiedAt))
    throw new CloudArchiveError('Invalid datesheet lastVerifiedAt', 'schemaInvalid')
  if (typeof entry.lastError !== 'string')
    throw new CloudArchiveError('Invalid datesheet lastError', 'schemaInvalid')
  if (archiveParts.some((part) => part.includes('..')))
    throw new CloudArchiveError('Invalid archive part path', 'schemaInvalid')
}

function validateDatesheetSchema(datesheet: CloudDatesheet, expectedRole?: CloudStorageRole): void {
  if (datesheet.schemaVersion !== 1)
    throw new CloudArchiveError('Unsupported datesheet schema', 'schemaUnsupported')
  if (!datesheet.pairId || typeof datesheet.pairId !== 'string')
    throw new CloudArchiveError('Invalid datesheet pairId', 'schemaInvalid')
  if (datesheet.role !== 'localCache' && datesheet.role !== 'cloudArchive')
    throw new CloudArchiveError('Invalid datesheet role', 'schemaInvalid')
  if (expectedRole && datesheet.role !== expectedRole)
    throw new CloudArchiveError('Datesheet role mismatch', 'roleMismatch')
  if (!isValidDateString(datesheet.createdAt) || !isValidDateString(datesheet.updatedAt))
    throw new CloudArchiveError('Invalid datesheet timestamps', 'schemaInvalid')
  if (typeof datesheet.lastOperationId !== 'string')
    throw new CloudArchiveError('Invalid datesheet operation id', 'schemaInvalid')
  if (!datesheet.games || Array.isArray(datesheet.games) || typeof datesheet.games !== 'object')
    throw new CloudArchiveError('Invalid datesheet games object', 'schemaInvalid')
  for (const [gameId, entry] of Object.entries(datesheet.games))
    validateDatesheetGameEntry(entry, gameId)
}

async function readDatesheet(
  root: string,
  expectedRole?: CloudStorageRole
): Promise<DateSheetReadResult> {
  const filePath = datesheetPath(root)
  if (!(await pathExists(filePath))) return { status: 'missing' }
  try {
    const datesheet = await readJsonFile<CloudDatesheet>(filePath)
    validateDatesheetSchema(datesheet, expectedRole)
    return { status: 'ok', datesheet, recoveredFromBackup: false }
  } catch (error) {
    const code = error instanceof CloudArchiveError ? error.code : 'corrupted'
    if (code === 'schemaUnsupported' || code === 'roleMismatch')
      return { status: code, error: getErrorMessage(error) }
    const backupPath = datesheetBakPath(root)
    if (await pathExists(backupPath)) {
      try {
        const datesheet = await readJsonFile<CloudDatesheet>(backupPath)
        validateDatesheetSchema(datesheet, expectedRole)
        return { status: 'ok', datesheet, recoveredFromBackup: true }
      } catch (backupError) {
        return { status: 'unrecoverable', error: getErrorMessage(backupError) }
      }
    }
    return { status: 'unrecoverable', error: getErrorMessage(error) }
  }
}

function assertDatesheetRead(result: DateSheetReadResult, root: string): CloudDatesheet {
  if (result.status === 'ok') return result.datesheet
  throw new CloudArchiveError(`Cloud datesheet at ${root} is ${result.status}`, result.status)
}

function createEmptyDatesheet(pairId: string, role: CloudStorageRole): CloudDatesheet {
  const timestamp = nowIso()
  return {
    schemaVersion: 1,
    pairId,
    role,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOperationId: '',
    games: {}
  }
}

async function enqueueDatesheetWrite<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root)
  const previous = datesheetQueues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(action)
  datesheetQueues.set(
    key,
    next.finally(() => datesheetQueues.get(key) === next && datesheetQueues.delete(key))
  )
  return await next
}

async function writeDatesheet(root: string, datesheet: CloudDatesheet): Promise<void> {
  await enqueueDatesheetWrite(root, async () => {
    await fse.ensureDir(root)
    const operationId = datesheet.lastOperationId || generateUUID()
    const releaseLock = await acquireDatesheetLock(root, operationId)
    try {
      const filePath = datesheetPath(root)
      const tmpPath = datesheetTmpPath(root)
      const bakPath = datesheetBakPath(root)
      const nextDatesheet = { ...datesheet, lastOperationId: operationId, updatedAt: nowIso() }
      if (await pathExists(filePath)) await fse.copy(filePath, bakPath, { overwrite: true })
      await fse.writeFile(tmpPath, JSON.stringify(nextDatesheet, null, 2), 'utf-8')
      validateDatesheetSchema(await readJsonFile<CloudDatesheet>(tmpPath), nextDatesheet.role)
      await fse.move(tmpPath, filePath, { overwrite: true })
      validateDatesheetSchema(await readJsonFile<CloudDatesheet>(filePath), nextDatesheet.role)
      await fse.remove(tmpPath).catch(() => {})
    } catch (error) {
      if (error instanceof CloudArchiveError) throw error
      throw new CloudArchiveError(
        `Failed to write datesheet: ${getErrorMessage(error)}`,
        'writeFailed'
      )
    } finally {
      await releaseLock()
    }
  })
}
async function ensureConfiguredDatesheets(
  config: CloudStorageConfig,
  initializeDatesheet: boolean
): Promise<void> {
  const localResult = await readDatesheet(config.localRoot, 'localCache')
  const cloudResult = await readDatesheet(config.cloudRoot, 'cloudArchive')
  if (localResult.status === 'ok' && cloudResult.status === 'ok') {
    if (localResult.recoveredFromBackup || cloudResult.recoveredFromBackup) {
      throw new CloudArchiveError(
        'Datesheet must be restored from backup before use',
        'recoveredFromBackup'
      )
    }
    if (localResult.datesheet.pairId !== cloudResult.datesheet.pairId) {
      throw new CloudArchiveError(
        'Local cache and cloud archive datesheets do not belong to the same pair',
        'pairMismatch'
      )
    }
    return
  }
  if (!initializeDatesheet)
    throw new CloudArchiveError(
      'Cloud archive directories need datesheet initialization',
      'datesheetMissing'
    )

  const pairId =
    localResult.status === 'ok'
      ? localResult.datesheet.pairId
      : cloudResult.status === 'ok'
        ? cloudResult.datesheet.pairId
        : generateUUID()

  if (localResult.status === 'missing')
    await writeDatesheet(config.localRoot, createEmptyDatesheet(pairId, 'localCache'))
  else if (localResult.status !== 'ok')
    throw new CloudArchiveError(`Local datesheet is ${localResult.status}`, localResult.status)

  if (cloudResult.status === 'missing')
    await writeDatesheet(config.cloudRoot, createEmptyDatesheet(pairId, 'cloudArchive'))
  else if (cloudResult.status !== 'ok')
    throw new CloudArchiveError(`Cloud datesheet is ${cloudResult.status}`, cloudResult.status)

  const local = assertDatesheetRead(
    await readDatesheet(config.localRoot, 'localCache'),
    config.localRoot
  )
  const cloud = assertDatesheetRead(
    await readDatesheet(config.cloudRoot, 'cloudArchive'),
    config.cloudRoot
  )
  if (local.pairId !== cloud.pairId)
    throw new CloudArchiveError('Datesheet pair mismatch after initialization', 'pairMismatch')
}

function getDatesheetRoot(config: CloudStorageConfig, role: CloudStorageRole): string {
  return role === 'localCache' ? config.localRoot : config.cloudRoot
}

async function canRestoreDatesheetFromBackup(
  root: string,
  role: CloudStorageRole
): Promise<boolean> {
  if (!root) return false
  const backupPath = datesheetBakPath(root)
  if (!(await pathExists(backupPath))) return false
  try {
    const backup = await readJsonFile<CloudDatesheet>(backupPath)
    validateDatesheetSchema(backup, role)
    return true
  } catch {
    return false
  }
}

async function getDatesheetSideStatus(
  root: string,
  role: CloudStorageRole
): Promise<CloudDatesheetSideStatus> {
  const lock = await readDatesheetLock(root)
  const base: CloudDatesheetSideStatus = {
    role,
    root,
    filePath: root ? datesheetPath(root) : '',
    status: root ? 'missing' : 'pathEmpty',
    exists: false,
    recoveredFromBackup: false,
    pairId: '',
    pairIdShort: '',
    schemaVersion: 0,
    gameCount: 0,
    updatedAt: '',
    hasRootContent: false,
    canRestoreFromBackup: false,
    lock,
    error: ''
  }

  if (!root) return base

  const hasRootContent = await directoryHasContent(root)
  const result = await readDatesheet(root, role)
  const canRestoreFromBackup = await canRestoreDatesheetFromBackup(root, role)
  if (result.status === 'ok') {
    return {
      ...base,
      status: result.recoveredFromBackup ? 'recoveredFromBackup' : 'ok',
      exists: await pathExists(datesheetPath(root)),
      recoveredFromBackup: result.recoveredFromBackup,
      pairId: result.datesheet.pairId,
      pairIdShort: result.datesheet.pairId.slice(0, 8),
      schemaVersion: result.datesheet.schemaVersion,
      gameCount: Object.keys(result.datesheet.games || {}).length,
      updatedAt: result.datesheet.updatedAt,
      hasRootContent,
      canRestoreFromBackup,
      error: result.recoveredFromBackup ? 'Official datesheet is corrupted; backup is readable' : ''
    }
  }

  return {
    ...base,
    status: result.status,
    exists: await pathExists(datesheetPath(root)),
    hasRootContent,
    canRestoreFromBackup,
    error: result.error || ''
  }
}

export async function getCloudDatesheetStatus(): Promise<CloudDatesheetStatusReport> {
  const config = await getConfig()
  const [local, cloud] = await Promise.all([
    getDatesheetSideStatus(config.localRoot, 'localCache'),
    getDatesheetSideStatus(config.cloudRoot, 'cloudArchive')
  ])
  const pairMatched = Boolean(local.pairId && cloud.pairId && local.pairId === cloud.pairId)
  if (local.pairId && cloud.pairId && !pairMatched) {
    local.status = 'pairMismatch'
    local.error = 'Local and cloud datesheets do not belong to the same pair'
    cloud.status = 'pairMismatch'
    cloud.error = 'Local and cloud datesheets do not belong to the same pair'
  }

  return {
    enabled: config.enabled,
    pairMatched,
    canInitialize:
      Boolean(config.localRoot && config.cloudRoot) &&
      (local.status === 'missing' || cloud.status === 'missing'),
    local,
    cloud
  }
}

export async function restoreDatesheetFromBackup(
  role: CloudStorageRole
): Promise<CloudDatesheetStatusReport> {
  const config = await getConfig()
  const root = getDatesheetRoot(config, role)
  if (!root) throw new CloudArchiveError('Datesheet root is not configured', 'pathEmpty')
  const backupPath = datesheetBakPath(root)
  if (!(await pathExists(backupPath)))
    throw new CloudArchiveError('Datesheet backup does not exist', 'backupMissing')

  const backup = await readJsonFile<CloudDatesheet>(backupPath)
  validateDatesheetSchema(backup, role)

  await enqueueDatesheetWrite(root, async () => {
    const operationId = generateUUID()
    const releaseLock = await acquireDatesheetLock(root, operationId)
    try {
      const filePath = datesheetPath(root)
      const tmpPath = datesheetTmpPath(root)
      if (await pathExists(filePath))
        await fse.copy(filePath, datesheetCorruptPath(root), { overwrite: false })
      const restored = { ...backup, updatedAt: nowIso(), lastOperationId: operationId }
      await fse.writeFile(tmpPath, JSON.stringify(restored, null, 2), 'utf-8')
      validateDatesheetSchema(await readJsonFile<CloudDatesheet>(tmpPath), role)
      await fse.move(tmpPath, filePath, { overwrite: true })
      validateDatesheetSchema(await readJsonFile<CloudDatesheet>(filePath), role)
      await fse.remove(tmpPath).catch(() => {})
    } finally {
      await releaseLock()
    }
  })

  return await getCloudDatesheetStatus()
}

export async function cleanupDatesheetLock(
  role: CloudStorageRole
): Promise<CloudDatesheetStatusReport> {
  const config = await getConfig()
  const root = getDatesheetRoot(config, role)
  if (!root) throw new CloudArchiveError('Datesheet root is not configured', 'pathEmpty')
  const lock = await readDatesheetLock(root)
  if (!lock.exists) return await getCloudDatesheetStatus()
  if (!lock.expired) throw new CloudArchiveError('Datesheet lock is not expired', 'lockBusy')
  await fse.remove(datesheetLockPath(root))
  return await getCloudDatesheetStatus()
}
async function getConfig(): Promise<CloudStorageConfig> {
  return normalizeConfig(await ConfigDBManager.getConfigLocalValue('game.cloudStorage'))
}

export async function getCloudConfig(): Promise<CloudStorageConfig> {
  return await getConfig()
}

export async function updateCloudConfig(update: CloudConfigUpdate): Promise<CloudStorageConfig> {
  const current = await getConfig()
  const initializeDatesheet = Boolean(update.initializeDatesheet)
  const { initializeDatesheet: _ignored, ...cleanUpdate } = update
  const next = normalizeConfig({ ...current, ...cleanUpdate })
  if (!next.enabled || !next.cloudRoot || !next.localRoot) {
    next.autoImportNewGames = false
  }
  if (next.enabled) {
    await ensureWritableDirectory(next.localRoot, 'Local cache directory')
    await ensureWritableDirectory(next.cloudRoot, 'Cloud archive directory')
    if (pathEquals(path.resolve(next.localRoot), path.resolve(next.cloudRoot))) {
      throw new CloudArchiveError(
        'Local cache and cloud archive directories cannot be the same',
        'sameRoot'
      )
    }
    await ensureConfiguredDatesheets(next, initializeDatesheet)
    if (
      next.sevenZipPath &&
      (!(await pathExists(next.sevenZipPath)) ||
        !(await validateSevenZipExecutable(next.sevenZipPath)))
    ) {
      throw new CloudArchiveError('Configured 7-Zip path is invalid.', 'sevenZipInvalid')
    }
  }
  await ConfigDBManager.setConfigLocalValue('game.cloudStorage', next)
  return next
}

async function ensureReadyConfig(): Promise<CloudStorageConfig> {
  const config = await getConfig()
  if (!config.enabled) throw new CloudArchiveError('Cloud archive is not enabled', 'notEnabled')
  await ensureWritableDirectory(config.localRoot, 'Local cache directory')
  await ensureWritableDirectory(config.cloudRoot, 'Cloud archive directory')
  await ensureConfiguredDatesheets(config, false)
  return config
}

async function listManifest(root: string): Promise<FileManifest> {
  const entries: Array<{ relativePath: string; size: number }> = []
  async function walk(current: string): Promise<void> {
    const dirents = await fse.readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      if (dirent.name === TMP_DIR) continue
      const fullPath = path.join(current, dirent.name)
      const relativePath = normalizePath(path.relative(root, fullPath))
      if (dirent.isDirectory()) await walk(fullPath)
      else if (dirent.isFile()) {
        const stat = await fse.stat(fullPath)
        entries.push({ relativePath, size: stat.size })
      }
    }
  }
  await walk(root)
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
  const hash = createHash('sha256')
  let sizeBytes = 0
  for (const entry of entries) {
    sizeBytes += entry.size
    hash.update(`${entry.relativePath}\0${entry.size}\n`)
  }
  return {
    fileNames: entries.map((entry) => entry.relativePath),
    fileCount: entries.length,
    sizeBytes,
    fileListHash: hash.digest('hex')
  }
}

function createGameEntry(params: {
  gameId: string
  gameName: string
  status: CloudGameStatus
  localManagedPath: string
  archiveDir: string
  archiveParts: string[]
  manifest: FileManifest
  lastError?: string
}): CloudDatesheetGameEntry {
  const revision = generateUUID()
  return {
    gameId: params.gameId,
    gameName: params.gameName,
    status: params.status,
    localManagedPath: params.localManagedPath,
    archiveDir: params.archiveDir,
    archiveParts: params.archiveParts,
    sizeBytes: params.manifest.sizeBytes,
    fileCount: params.manifest.fileCount,
    fileNames: params.manifest.fileNames,
    fileListHash: params.manifest.fileListHash,
    archiveRevision: revision,
    localRevision: revision,
    lastVerifiedAt: nowIso(),
    lastError: params.lastError || ''
  }
}

async function updateLocalDatesheetAfterCopy(
  config: CloudStorageConfig,
  gameId: string,
  managedRoot: string,
  archiveParts: string[],
  manifest: FileManifest,
  operationId: string
): Promise<void> {
  const datesheet = assertDatesheetRead(
    await readDatesheet(config.localRoot, 'localCache'),
    config.localRoot
  )
  const existing = datesheet.games[gameId]
  const entry: CloudDatesheetGameEntry = {
    gameId,
    gameName: await getGameName(gameId),
    status: 'local',
    localManagedPath: managedRoot,
    archiveDir: existing?.archiveDir || gameId,
    archiveParts: existing?.archiveParts?.length ? existing.archiveParts : archiveParts,
    sizeBytes: manifest.sizeBytes,
    fileCount: manifest.fileCount,
    fileNames: manifest.fileNames,
    fileListHash: manifest.fileListHash,
    archiveRevision: existing?.archiveRevision || '',
    localRevision: generateUUID(),
    lastVerifiedAt: nowIso(),
    lastError: ''
  }
  await updateDatesheetGameEntry(config.localRoot, 'localCache', entry, operationId)
}

async function updateDatesheetGameEntry(
  root: string,
  role: CloudStorageRole,
  entry: CloudDatesheetGameEntry,
  operationId: string
): Promise<void> {
  const datesheet = assertDatesheetRead(await readDatesheet(root, role), root)
  datesheet.lastOperationId = operationId
  datesheet.games[entry.gameId] = entry
  await writeDatesheet(root, datesheet)
}

async function removeDatesheetGameEntry(
  root: string,
  role: CloudStorageRole,
  gameId: string,
  operationId: string
): Promise<void> {
  const datesheet = assertDatesheetRead(await readDatesheet(root, role), root)
  if (!datesheet.games[gameId]) return
  datesheet.lastOperationId = operationId
  delete datesheet.games[gameId]
  await writeDatesheet(root, datesheet)
}

async function readPairedDatesheets(
  config: CloudStorageConfig
): Promise<{ local: CloudDatesheet; cloud: CloudDatesheet }> {
  const local = assertDatesheetRead(
    await readDatesheet(config.localRoot, 'localCache'),
    config.localRoot
  )
  const cloud = assertDatesheetRead(
    await readDatesheet(config.cloudRoot, 'cloudArchive'),
    config.cloudRoot
  )
  if (local.pairId !== cloud.pairId)
    throw new CloudArchiveError('Local and cloud datesheets do not match', 'pairMismatch')
  return { local, cloud }
}

async function writeEntryToBothDatesheets(
  config: CloudStorageConfig,
  entry: CloudDatesheetGameEntry,
  operationId: string
): Promise<void> {
  await readPairedDatesheets(config)
  await updateDatesheetGameEntry(config.localRoot, 'localCache', entry, operationId)
  await updateDatesheetGameEntry(config.cloudRoot, 'cloudArchive', entry, operationId)
}

async function setGameCloudState(
  gameId: string,
  status: CloudGameStatus,
  updates: Partial<gameLocalDoc['cloud']> = {}
): Promise<void> {
  const local = cloneGameLocal(await GameDBManager.getGameLocal(gameId))
  await GameDBManager.setGameLocalValue(gameId, 'cloud', {
    ...local.cloud,
    ...updates,
    status,
    updatedAt: nowIso()
  })
}

async function cleanupCanceledManagedCopy(
  gameId: string,
  currentCloud: gameLocalDoc['cloud'],
  previousCloud: gameLocalDoc['cloud'],
  operationId: string
): Promise<void> {
  const config = await getConfig()
  const currentPath = currentCloud.localManagedPath
  if (!config.localRoot || !currentPath) return
  if (previousCloud.localManagedPath && pathEquals(currentPath, previousCloud.localManagedPath)) return
  if (!isPathWithinRoot(currentPath, config.localRoot)) return

  await fse.remove(currentPath).catch((cleanupError) => {
    log.warn('[Cloud] Failed to remove canceled managed copy:', cleanupError)
  })
  await removeDatesheetGameEntry(config.localRoot, 'localCache', gameId, operationId).catch(
    (cleanupError) => {
      log.warn('[Cloud] Failed to remove canceled local datesheet entry:', cleanupError)
    }
  )
}

async function restoreCanceledTaskCloudState(
  gameId: string,
  task: CloudTaskState,
  error: unknown
): Promise<void> {
  if (!task.previousCloud) {
    await setGameCloudState(gameId, 'error', { lastError: getErrorMessage(error) })
    return
  }
  const currentCloud = cloneGameLocal(await GameDBManager.getGameLocal(gameId)).cloud
  await cleanupCanceledManagedCopy(
    gameId,
    currentCloud,
    task.previousCloud,
    task.progress.taskId
  ).catch((cleanupError) => {
    log.warn('[Cloud] Failed to cleanup canceled cloud task artifacts:', cleanupError)
  })
  await GameDBManager.setGameLocalValue(gameId, 'cloud', {
    ...task.previousCloud,
    updatedAt: nowIso(),
    lastError: getErrorMessage(error)
  })
}

function migratePathValue(value: string, oldRoot: string, newRoot: string): string {
  if (!value || !oldRoot || !isPathWithinRoot(value, oldRoot)) return value
  return path.join(newRoot, path.relative(oldRoot, value))
}

function migrateLocalPaths(local: gameLocalDoc, oldRoot: string, newRoot: string): gameLocalDoc {
  const next = cloneGameLocal(local)
  next.path.gamePath = migratePathValue(next.path.gamePath, oldRoot, newRoot)
  next.path.savePaths = next.path.savePaths.map((savePath) =>
    migratePathValue(savePath, oldRoot, newRoot)
  )
  if (next.path.screenshotPath)
    next.path.screenshotPath = migratePathValue(next.path.screenshotPath, oldRoot, newRoot)
  next.utils.rootPath = newRoot
  next.utils.markPath = migratePathValue(next.utils.markPath, oldRoot, newRoot) || newRoot
  next.launcher.fileConfig.path = migratePathValue(next.launcher.fileConfig.path, oldRoot, newRoot)
  next.launcher.fileConfig.monitorPath = migratePathValue(
    next.launcher.fileConfig.monitorPath,
    oldRoot,
    newRoot
  )
  next.launcher.urlConfig.browserPath = migratePathValue(
    next.launcher.urlConfig.browserPath,
    oldRoot,
    newRoot
  )
  next.launcher.urlConfig.monitorPath = migratePathValue(
    next.launcher.urlConfig.monitorPath,
    oldRoot,
    newRoot
  )
  next.launcher.scriptConfig.workingDirectory = migratePathValue(
    next.launcher.scriptConfig.workingDirectory,
    oldRoot,
    newRoot
  )
  next.launcher.scriptConfig.monitorPath = migratePathValue(
    next.launcher.scriptConfig.monitorPath,
    oldRoot,
    newRoot
  )
  return next
}

function inferGameRoot(local: gameLocalDoc): string {
  return (
    local.utils.rootPath ||
    local.utils.markPath ||
    (local.path.gamePath ? path.dirname(local.path.gamePath) : '')
  )
}

async function getGameName(gameId: string): Promise<string> {
  const game = await GameDBManager.getGame(gameId)
  return game?.metadata?.name || gameId
}
function createTask(
  gameId: string,
  gameName: string,
  phase: CloudTaskPhase,
  message: string
): CloudTaskState {
  const existingTaskId = taskIdByGameId.get(gameId)
  if (existingTaskId)
    throw new CloudArchiveError(
      'A cloud archive task is already running for this game',
      'taskRunning'
    )
  const timestamp = nowIso()
  const task: CloudTaskState = {
    canceled: false,
    progress: {
      taskId: generateUUID(),
      gameId,
      gameName,
      phase,
      percent: 0,
      processedBytes: 0,
      totalBytes: 0,
      speedBytesPerSecond: 0,
      etaSeconds: null,
      message,
      startedAt: timestamp,
      updatedAt: timestamp
    }
  }
  tasksById.set(task.progress.taskId, task)
  taskIdByGameId.set(gameId, task.progress.taskId)
  return task
}

function assertTaskNotCanceled(task: CloudTaskState): void {
  if (task.canceled) throw new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled')
}

async function runArchiveIoSerial<T>(
  task: CloudTaskState,
  phase: CloudTaskPhase,
  action: () => Promise<T>
): Promise<T> {
  assertTaskNotCanceled(task)
  const previous = archiveIoQueue.catch(() => {})
  let releaseQueue!: () => void
  archiveIoQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })

  updateProgress(task, {
    phase,
    message: 'Waiting for other archive tasks to finish'
  })
  await previous

  try {
    assertTaskNotCanceled(task)
    return await action()
  } finally {
    releaseQueue()
  }
}

function updateProgress(
  task: CloudTaskState,
  patch: Partial<Omit<CloudTaskProgress, 'taskId' | 'gameId' | 'gameName' | 'startedAt'>>
): void {
  const startedAt = new Date(task.progress.startedAt).getTime()
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
  const processedBytes = patch.processedBytes ?? task.progress.processedBytes
  const totalBytes = patch.totalBytes ?? task.progress.totalBytes
  const speedBytesPerSecond = processedBytes / elapsedSeconds
  const remainingBytes = totalBytes > processedBytes ? totalBytes - processedBytes : 0
  task.progress = {
    ...task.progress,
    ...patch,
    speedBytesPerSecond: patch.speedBytesPerSecond ?? speedBytesPerSecond,
    etaSeconds:
      patch.etaSeconds ??
      (speedBytesPerSecond > 0 && totalBytes > 0 ? remainingBytes / speedBytesPerSecond : null),
    updatedAt: nowIso()
  }
  ipcManager.send('cloud:task-progress', task.progress)
}

function completeTask(task: CloudTaskState, message: string): void {
  updateProgress(task, {
    phase: 'completed',
    percent: 100,
    processedBytes: task.progress.totalBytes || task.progress.processedBytes,
    message
  })
  ipcManager.send('cloud:task-completed', task.progress)
}

function failTask(task: CloudTaskState, error: unknown): void {
  updateProgress(task, {
    phase: 'error',
    message: getErrorMessage(error),
    errorCode: error instanceof CloudArchiveError ? error.code : undefined
  })
  ipcManager.send('cloud:task-failed', task.progress)
}

function cleanupTask(task: CloudTaskState): void {
  tasksById.delete(task.progress.taskId)
  taskIdByGameId.delete(task.progress.gameId)
}

async function copyDirectoryWithProgress(
  sourceRoot: string,
  targetRoot: string,
  task: CloudTaskState,
  sourceManifest?: FileManifest
): Promise<void> {
  if (await pathExists(targetRoot))
    throw new CloudArchiveError('Local managed directory already exists', 'targetExists')
  const manifest = sourceManifest ?? (await listManifest(sourceRoot))
  updateProgress(task, {
    phase: 'copying',
    totalBytes: manifest.sizeBytes,
    processedBytes: 0,
    percent: 0,
    message: 'Copying game files to local cache'
  })

  async function walk(current: string): Promise<void> {
    assertTaskNotCanceled(task)
    const dirents = await fse.readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      assertTaskNotCanceled(task)
      const sourcePath = path.join(current, dirent.name)
      const targetPath = path.join(targetRoot, path.relative(sourceRoot, sourcePath))
      if (dirent.isDirectory()) {
        await fse.ensureDir(targetPath)
        await walk(sourcePath)
      } else if (dirent.isFile()) {
        await fse.ensureDir(path.dirname(targetPath))
        const stat = await fse.stat(sourcePath)
        await fse.copyFile(sourcePath, targetPath)
        const processedBytes = task.progress.processedBytes + stat.size
        updateProgress(task, {
          processedBytes,
          percent:
            manifest.sizeBytes > 0 ? Math.min(99, (processedBytes / manifest.sizeBytes) * 100) : 99
        })
      }
    }
  }

  await walk(sourceRoot)
}

async function validateSevenZipExecutable(executable: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(executable, ['-h'], { windowsHide: true })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

async function findSevenZip(config: CloudStorageConfig): Promise<string> {
  if (config.sevenZipPath) {
    if (
      !(await pathExists(config.sevenZipPath)) ||
      !(await validateSevenZipExecutable(config.sevenZipPath))
    ) {
      throw new CloudArchiveError('Configured 7-Zip path is invalid.', 'sevenZipInvalid')
    }
    return config.sevenZipPath
  }

  const candidates = [
    path.join(process.resourcesPath || '', '7za.exe'),
    path.join(app.getAppPath(), 'resources', '7za.exe'),
    '7z',
    '7za',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !(await pathExists(candidate))) continue
    if (await validateSevenZipExecutable(candidate)) return candidate
  }
  throw new CloudArchiveError(
    '7-Zip was not found. Install 7-Zip or configure a custom path.',
    'sevenZipMissing'
  )
}

async function runSevenZip(
  executable: string,
  args: string[],
  task: CloudTaskState,
  phase: CloudTaskPhase,
  message: string
): Promise<void> {
  await runArchiveIoSerial(task, phase, async () => {
    updateProgress(task, { phase, message })
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true })
      task.child = child
      let output = ''
      const handleData = (data: Buffer): void => {
        const chunk = data.toString()
        output += chunk
        const matches = chunk.match(/(\d{1,3})%/g)
        const last = matches?.at(-1)
        if (last) {
          const percent = Math.max(0, Math.min(99, Number(last.replace('%', ''))))
          updateProgress(task, {
            percent,
            processedBytes:
              task.progress.totalBytes > 0
                ? Math.floor((task.progress.totalBytes * percent) / 100)
                : task.progress.processedBytes
          })
        }
      }
      child.stdout.on('data', handleData)
      child.stderr.on('data', handleData)
      child.once('error', reject)
      child.once('exit', (code) => {
        task.child = undefined
        if (task.canceled)
          reject(new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled'))
        else if (code === 0) resolve()
        else
          reject(new CloudArchiveError(output || `7-Zip exited with code ${code}`, 'sevenZipFailed'))
      })
    })
  })
}

async function replaceDirectoryWithRollback(
  sourceDir: string,
  targetDir: string,
  backupDir: string
): Promise<void> {
  await fse.remove(backupDir)
  await fse.ensureDir(path.dirname(targetDir))

  const hadTarget = await pathExists(targetDir)
  if (hadTarget) await fse.move(targetDir, backupDir, { overwrite: true })

  try {
    await fse.move(sourceDir, targetDir, { overwrite: false })
  } catch (error) {
    if (hadTarget && !(await pathExists(targetDir)) && (await pathExists(backupDir))) {
      await fse.move(backupDir, targetDir, { overwrite: false }).catch((restoreError) => {
        log.error(
          '[Cloud] Failed to restore previous archive after replacement failure:',
          restoreError
        )
      })
    }
    throw error
  }

  await fse.remove(backupDir)
}

async function archiveGame(
  config: CloudStorageConfig,
  gameId: string,
  sourceRoot: string,
  task: CloudTaskState
): Promise<{ entry: CloudDatesheetGameEntry; manifest: FileManifest }> {
  const executable = await findSevenZip(config)
  const manifest = await listManifest(sourceRoot)
  const tempArchiveDir = path.join(config.cloudRoot, TMP_DIR, task.progress.taskId)
  const previousArchiveDir = path.join(
    config.cloudRoot,
    TMP_DIR,
    `${task.progress.taskId}-previous-${gameId}`
  )
  const finalArchiveDir = getArchiveDir(config, gameId)
  const archiveBase = path.join(tempArchiveDir, `${gameId}.7z`)
  let archivePromoted = false
  await fse.remove(tempArchiveDir)
  await fse.ensureDir(tempArchiveDir)

  try {
    updateProgress(task, {
      phase: 'compressing',
      totalBytes: manifest.sizeBytes,
      processedBytes: 0,
      percent: 0,
      message: 'Compressing game files'
    })
    await runSevenZip(
      executable,
      [
        'a',
        '-t7z',
        '-mx=9',
        `-v${config.volumeSizeBytes}b`,
        archiveBase,
        path.join(sourceRoot, '*')
      ],
      task,
      'compressing',
      'Compressing game files'
    )

    const partNames = (await fse.readdir(tempArchiveDir))
      .filter((name) => name.startsWith(`${gameId}.7z.`))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (partNames.length === 0)
      throw new CloudArchiveError('No 7z archive parts were generated', 'archivePartsMissing')
    for (const part of partNames) {
      const stat = await fse.stat(path.join(tempArchiveDir, part))
      if (!stat.isFile() || stat.size <= 0)
        throw new CloudArchiveError(`Archive part is invalid: ${part}`, 'archivePartsMismatch')
    }

    assertTaskNotCanceled(task)
    await replaceDirectoryWithRollback(tempArchiveDir, finalArchiveDir, previousArchiveDir)
    archivePromoted = true
    const gameName = await getGameName(gameId)
    return {
      manifest,
      entry: createGameEntry({
        gameId,
        gameName,
        status: 'local',
        localManagedPath: getLocalManagedPath(config, gameId),
        archiveDir: gameId,
        archiveParts: partNames,
        manifest
      })
    }
  } finally {
    if (!archivePromoted) await fse.remove(tempArchiveDir).catch(() => {})
    if (archivePromoted) await fse.remove(previousArchiveDir).catch(() => {})
  }
}

async function verifyArchiveParts(
  config: CloudStorageConfig,
  gameId: string,
  entry: CloudDatesheetGameEntry
): Promise<void> {
  if (!entry.archiveParts.length)
    throw new CloudArchiveError('Archive parts are missing from datesheet', 'archivePartsMissing')
  for (const part of entry.archiveParts) {
    if (path.isAbsolute(part))
      throw new CloudArchiveError('Archive part path must be relative', 'archivePartsMismatch')
    const partPath = getArchivePartPath(config, gameId, part)
    if (!(await pathExists(partPath)))
      throw new CloudArchiveError(
        'Cloud archive may not have finished syncing yet',
        'archivePartsMissing'
      )
    const stat = await fse.stat(partPath)
    if (!stat.isFile() || stat.size <= 0)
      throw new CloudArchiveError('Cloud archive part is invalid', 'archivePartsMismatch')
  }
}

async function getArchivePartsSizeBytes(
  config: CloudStorageConfig,
  gameId: string,
  entry: CloudDatesheetGameEntry
): Promise<number> {
  let sizeBytes = 0
  for (const part of entry.archiveParts) {
    const stat = await fse.stat(getArchivePartPath(config, gameId, part))
    sizeBytes += stat.size
  }
  return sizeBytes
}
async function ensureLocalCacheCapacity(
  config: CloudStorageConfig,
  additionalBytes: number
): Promise<void> {
  const usedBytes = await getLocalRootUsedBytes(config.localRoot)
  if (config.localLimitBytes > 0 && usedBytes + additionalBytes > config.localLimitBytes) {
    throw new CloudArchiveError('Local cache capacity is not enough', 'localLimitExceeded')
  }
  const freeBytes = await getFreeSpaceBytes(config.localRoot)
  if (freeBytes < additionalBytes)
    throw new CloudArchiveError('Disk free space is not enough', 'diskSpaceInsufficient')
}

async function ensureManagedLocalCopy(
  config: CloudStorageConfig,
  gameId: string,
  task: CloudTaskState
): Promise<{ local: gameLocalDoc; sourceRoot: string; managedRoot: string }> {
  const local = cloneGameLocal(await GameDBManager.getGameLocal(gameId))
  const managedRoot = getLocalManagedPath(config, gameId)
  const currentRoot = inferGameRoot(local)

  if (await pathExists(managedRoot)) return { local, sourceRoot: managedRoot, managedRoot }

  if (!currentRoot || !(await pathExists(currentRoot))) {
    throw new CloudArchiveError('Local game directory does not exist', 'localPathMissing')
  }

  const sourceManifest = await listManifest(currentRoot)
  await ensureLocalCacheCapacity(config, sourceManifest.sizeBytes)

  try {
    await copyDirectoryWithProgress(currentRoot, managedRoot, task, sourceManifest)
    assertTaskNotCanceled(task)
  } catch (error) {
    if (isPathWithinRoot(managedRoot, config.localRoot))
      await fse.remove(managedRoot).catch(() => {})
    throw error
  }
  const manifest = await listManifest(managedRoot)
  assertTaskNotCanceled(task)
  const migrated = migrateLocalPaths(local, currentRoot, managedRoot)
  migrated.cloud = {
    ...migrated.cloud,
    status: 'local',
    localManagedPath: managedRoot,
    archiveDir: getArchiveDir(config, gameId),
    originalImportedPath: migrated.cloud.originalImportedPath || currentRoot,
    sizeBytes: manifest.sizeBytes,
    updatedAt: nowIso(),
    lastError: ''
  }
  await updateLocalDatesheetAfterCopy(
    config,
    gameId,
    managedRoot,
    migrated.cloud.archiveParts,
    manifest,
    task.progress.taskId
  )
  await GameDBManager.setGameLocal(gameId, migrated)
  return { local: migrated, sourceRoot: managedRoot, managedRoot }
}

async function saveArchiveResult(
  config: CloudStorageConfig,
  gameId: string,
  entry: CloudDatesheetGameEntry,
  status: CloudGameStatus,
  operationId: string
): Promise<void> {
  const nextEntry = { ...entry, status, lastError: '', lastVerifiedAt: nowIso() }
  await writeEntryToBothDatesheets(config, nextEntry, operationId)
  await setGameCloudState(gameId, status, {
    localManagedPath: getLocalManagedPath(config, gameId),
    archiveDir: getArchiveDir(config, gameId),
    archiveParts: entry.archiveParts,
    sizeBytes: entry.sizeBytes,
    lastError: ''
  })
}

async function runImportGame(gameId: string, task: CloudTaskState): Promise<void> {
  const config = await ensureReadyConfig()
  await setGameCloudState(gameId, 'syncing')
  const { sourceRoot } = await ensureManagedLocalCopy(config, gameId, task)
  const { entry } = await archiveGame(config, gameId, sourceRoot, task)
  assertTaskNotCanceled(task)
  await saveArchiveResult(config, gameId, entry, 'local', task.progress.taskId)
}

async function runMigrateGameToCloud(gameId: string, task: CloudTaskState): Promise<void> {
  if (ActiveGameInfo.infos.some((info) => info.gameId === gameId)) {
    throw new CloudArchiveError('Game is currently running', 'gameRunning')
  }
  const config = await ensureReadyConfig()
  await setGameCloudState(gameId, 'syncing')
  const { sourceRoot, managedRoot } = await ensureManagedLocalCopy(config, gameId, task)
  const { entry } = await archiveGame(config, gameId, sourceRoot, task)
  assertTaskNotCanceled(task)
  const cloudEntry = { ...entry, status: 'cloud' as CloudGameStatus }
  await writeEntryToBothDatesheets(config, cloudEntry, task.progress.taskId)
  await verifyArchiveParts(config, gameId, cloudEntry)
  assertTaskNotCanceled(task)

  if (!isPathWithinRoot(managedRoot, config.localRoot)) {
    throw new CloudArchiveError('Refusing to delete a directory outside localRoot', 'unsafeDelete')
  }

  updateProgress(task, {
    phase: 'deleting',
    message: 'Deleting local cache after archive verification'
  })
  await fse.remove(managedRoot)
  await setGameCloudState(gameId, 'cloud', {
    localManagedPath: managedRoot,
    archiveDir: getArchiveDir(config, gameId),
    archiveParts: entry.archiveParts,
    sizeBytes: entry.sizeBytes,
    lastError: ''
  })
}

async function getFreeSpaceBytes(root: string): Promise<number> {
  try {
    const stat = await fs.statfs(root)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch (error) {
    log.warn('[Cloud] Failed to read free space, skipping disk free-space check:', error)
    return Number.MAX_SAFE_INTEGER
  }
}

async function getLocalRootUsedBytes(localRoot: string): Promise<number> {
  if (!(await pathExists(localRoot))) return 0
  const manifest = await listManifest(localRoot)
  return manifest.sizeBytes
}

async function runDownloadGameToLocal(gameId: string, task: CloudTaskState): Promise<void> {
  const config = await ensureReadyConfig()
  await setGameCloudState(gameId, 'syncing')
  const { cloud } = await readPairedDatesheets(config)
  const entry = cloud.games[gameId]
  if (!entry)
    throw new CloudArchiveError('Game entry is missing from cloud datesheet', 'gameEntryMissing')
  await verifyArchiveParts(config, gameId, entry)

  const targetRoot = getLocalManagedPath(config, gameId)
  if (await pathExists(targetRoot))
    throw new CloudArchiveError('Local target directory already exists', 'targetExists')

  const estimatedBytes = entry.sizeBytes || (await getArchivePartsSizeBytes(config, gameId, entry))
  await ensureLocalCacheCapacity(config, estimatedBytes)

  const executable = await findSevenZip(config)
  const tempExtractDir = path.join(config.localRoot, TMP_DIR, task.progress.taskId)
  await fse.remove(tempExtractDir)
  await fse.ensureDir(tempExtractDir)
  updateProgress(task, {
    phase: 'extracting',
    percent: 0,
    totalBytes: estimatedBytes,
    processedBytes: 0,
    message: 'Extracting cloud archive to local cache'
  })

  let manifest: FileManifest | undefined
  let extractedPromoted = false
  try {
    await runSevenZip(
      executable,
      ['x', getArchivePartPath(config, gameId, entry.archiveParts[0]), `-o${tempExtractDir}`, '-y'],
      task,
      'extracting',
      'Extracting cloud archive to local cache'
    )

    manifest = await listManifest(tempExtractDir)
    if (entry.fileNames.length && manifest.fileListHash !== entry.fileListHash) {
      throw new CloudArchiveError(
        'Extracted files do not match cloud datesheet',
        'fileListMismatch'
      )
    }

    assertTaskNotCanceled(task)
    await fse.move(tempExtractDir, targetRoot, { overwrite: false })
    extractedPromoted = true
  } finally {
    if (!extractedPromoted) await fse.remove(tempExtractDir).catch(() => {})
  }
  if (!manifest)
    throw new CloudArchiveError('Extracted files do not match cloud datesheet', 'fileListMismatch')
  const local = cloneGameLocal(await GameDBManager.getGameLocal(gameId))
  const oldRoot = local.cloud.localManagedPath || inferGameRoot(local) || targetRoot
  const migrated = migrateLocalPaths(local, oldRoot, targetRoot)
  migrated.cloud = {
    ...migrated.cloud,
    status: 'local',
    localManagedPath: targetRoot,
    archiveDir: getArchiveDir(config, gameId),
    archiveParts: entry.archiveParts,
    sizeBytes: manifest.sizeBytes,
    updatedAt: nowIso(),
    lastError: ''
  }
  await GameDBManager.setGameLocal(gameId, migrated)

  const nextEntry = {
    ...entry,
    status: 'local' as CloudGameStatus,
    localManagedPath: targetRoot,
    sizeBytes: manifest.sizeBytes,
    localRevision: generateUUID(),
    lastVerifiedAt: nowIso(),
    lastError: ''
  }
  await writeEntryToBothDatesheets(config, nextEntry, task.progress.taskId)
}

async function runRebuildArchive(gameId: string, task: CloudTaskState): Promise<void> {
  const config = await ensureReadyConfig()
  await setGameCloudState(gameId, 'syncing')
  const { sourceRoot } = await ensureManagedLocalCopy(config, gameId, task)
  const { entry } = await archiveGame(config, gameId, sourceRoot, task)
  assertTaskNotCanceled(task)
  await saveArchiveResult(config, gameId, entry, 'local', task.progress.taskId)
}

function startCloudTask(
  gameId: string,
  phase: CloudTaskPhase,
  message: string,
  runner: (task: CloudTaskState) => Promise<void>
): { taskId: string } {
  const task = createTask(gameId, gameId, phase, message)
  void (async () => {
    try {
      task.progress.gameName = await getGameName(gameId)
      task.previousCloud = cloneGameLocal(await GameDBManager.getGameLocal(gameId)).cloud
      await runner(task)
      completeTask(task, 'Cloud archive task completed')
    } catch (error) {
      if (error instanceof CloudArchiveError && error.code === 'taskCanceled') {
        await restoreCanceledTaskCloudState(gameId, task, error).catch(() => {})
      } else {
        await setGameCloudState(gameId, 'error', { lastError: getErrorMessage(error) }).catch(
          () => {}
        )
      }
      failTask(task, error)
    } finally {
      cleanupTask(task)
    }
  })()
  return { taskId: task.progress.taskId }
}

export async function getCloudGames(): Promise<CloudGameSummary[]> {
  const [games, localDocs] = await Promise.all([
    GameDBManager.getAllGames(),
    GameDBManager.getAllGamesLocal()
  ])
  return Object.values(games)
    .filter((game) => game?._id && game._id !== 'collections')
    .map((game) => {
      const local = cloneGameLocal(localDocs[game._id])
      return {
        gameId: game._id,
        gameName: game.metadata?.name || game._id,
        status: local.cloud.status || 'local',
        localManagedPath: local.cloud.localManagedPath,
        archiveDir: local.cloud.archiveDir,
        archiveParts: local.cloud.archiveParts,
        sizeBytes: local.cloud.sizeBytes,
        updatedAt: local.cloud.updatedAt,
        lastError: local.cloud.lastError
      }
    })
}

export async function importGameToCloud(gameId: string): Promise<{ taskId: string }> {
  return startCloudTask(gameId, 'copying', 'Importing game into cloud archive', (task) =>
    runImportGame(gameId, task)
  )
}

export async function importExistingGames(): Promise<{ taskIds: string[] }> {
  await ensureReadyConfig()
  const games = await getCloudGames()
  const taskIds: string[] = []
  for (const game of games) {
    if (game.status === 'syncing' || game.status === 'cloud') continue
    try {
      const { taskId } = startCloudTask(
        game.gameId,
        'copying',
        'Importing game into cloud archive',
        (task) => runImportGame(game.gameId, task)
      )
      taskIds.push(taskId)
    } catch (error) {
      log.warn('[Cloud] Failed to start import task:', error)
    }
  }
  return { taskIds }
}

export async function migrateGameToCloud(gameId: string): Promise<{ taskId: string }> {
  return startCloudTask(gameId, 'compressing', 'Migrating game to cloud archive', (task) =>
    runMigrateGameToCloud(gameId, task)
  )
}

export async function downloadGameToLocal(gameId: string): Promise<{ taskId: string }> {
  return startCloudTask(gameId, 'downloading', 'Downloading game from cloud archive', (task) =>
    runDownloadGameToLocal(gameId, task)
  )
}

export async function rebuildArchive(gameId: string): Promise<{ taskId: string }> {
  return startCloudTask(gameId, 'compressing', 'Rebuilding cloud archive', (task) =>
    runRebuildArchive(gameId, task)
  )
}

export function getTaskProgress(query?: { gameId?: string; taskId?: string }): CloudTaskProgress[] {
  const tasks = Array.from(tasksById.values()).map((task) => task.progress)
  if (query?.taskId) return tasks.filter((task) => task.taskId === query.taskId)
  if (query?.gameId) return tasks.filter((task) => task.gameId === query.gameId)
  return tasks
}

export function cancelTask(query: { gameId?: string; taskId?: string }): boolean {
  const taskId = query.taskId || (query.gameId ? taskIdByGameId.get(query.gameId) : undefined)
  if (!taskId) return false
  const task = tasksById.get(taskId)
  if (!task) return false
  task.canceled = true
  task.child?.kill()
  return true
}

