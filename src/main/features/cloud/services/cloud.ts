import {
  CloudDatesheet,
  CloudDatesheetGameEntry,
  CloudDatesheetLockInfo,
  CloudDatesheetSideStatus,
  CloudDatesheetStatusReport,
  CloudGameStatus,
  CloudGameSummary,
  CloudOrphanSummary,
  CloudStorageLocationInfo,
  CloudStorageRole,
  CloudTaskPhase,
  CloudTaskProgress,
  configLocalDocs,
  DEFAULT_GAME_LOCAL_VALUES,
  DEFAULT_GAME_VALUES,
  gameLocalDoc
} from '@appTypes/models'
import { generateUUID, getErrorMessage } from '@appUtils'
import { app } from 'electron'
import log from 'electron-log/main'
import fse from 'fs-extra'
import path from 'path'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs, ReadStream, WriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { ConfigDBManager, GameDBManager } from '~/core/database'
import { eventBus } from '~/core/events'
import { ipcManager } from '~/core/ipc'
import { ActiveGameInfo } from '~/features/game/services'
import { getAppRootPath, getDataPath, portableStore } from '~/features/system'
import { isPathWithinRoot, normalizePath, pathEquals } from '~/utils'

const DATESHEET_FILE = '.vnite-cloud-datesheet.json'
const DATESHEET_TMP = '.vnite-cloud-datesheet.json.tmp'
const DATESHEET_BAK = '.vnite-cloud-datesheet.json.bak'
const DATESHEET_LOCK = '.vnite-cloud-datesheet.lock'
const DATESHEET_CORRUPT_PREFIX = '.vnite-cloud-datesheet.corrupt'
const TMP_DIR = '.vnite-tmp'
const DEFAULT_VOLUME_SIZE_BYTES = 2 * 1024 * 1024 * 1024
const DATESHEET_LOCK_TIMEOUT_MS = 30 * 60 * 1000
const CONFIG_IO_TIMEOUT_MS = 20_000
const DATESHEET_WRITE_TIMEOUT_MS = 30_000
const DIRECTORY_OPERATION_TIMEOUT_MS = 120_000
const SEVEN_ZIP_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const SEVEN_ZIP_WATCHDOG_INTERVAL_MS = 15_000
const COPY_FILE_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const COPY_FILE_WATCHDOG_INTERVAL_MS = 15_000
const CLOUD_TASK_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const CLOUD_TASK_WATCHDOG_INTERVAL_MS = 15_000
const TERMINAL_TASK_RETENTION_MS = 60_000
const MAX_INLINE_DATESHEET_FILE_NAMES = 2_000
const OPTIONAL_DATESHEET_MAX_BYTES = 8 * 1024 * 1024
const OPTIONAL_DATESHEET_WRITE_TIMEOUT_MS = 8_000

type CloudStorageConfig = configLocalDocs['game']['cloudStorage']
type CloudConfigUpdate = Partial<CloudStorageConfig>
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
  copyStreams: Set<{ source: ReadStream; target: WriteStream }>
  lastProgressEmitAt: number
  lastProgressEmitBytes: number
}

const tasksById = new Map<string, CloudTaskState>()
const taskIdByGameId = new Map<string, string>()
const datesheetQueues = new Map<string, Promise<unknown>>()
let archiveIoQueue: Promise<void> = Promise.resolve()
let cloudTaskQueue: Promise<void> = Promise.resolve()
const PROGRESS_THROTTLE_MS = 250
const PROGRESS_THROTTLE_BYTES = 16 * 1024 * 1024

class CloudArchiveError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = `CloudArchiveError:${code}`
  }
}

function withOperationTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = CONFIG_IO_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CloudArchiveError(`${label} timed out`, 'operationTimeout')),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
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

function isProcessProbablyAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
    const pid = typeof lock.pid === 'number' ? lock.pid : 0
    return {
      exists: true,
      expired: ageMs > DATESHEET_LOCK_TIMEOUT_MS || !isProcessProbablyAlive(pid),
      operationId: typeof lock.operationId === 'string' ? lock.operationId : '',
      pid,
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
  const lockPath = datesheetLockPath(root)
  const lock = await readDatesheetLock(root)
  if (lock.exists) {
    if (!isProcessProbablyAlive(lock.pid)) {
      await fse.remove(lockPath).catch(() => {})
    } else if (lock.expired) {
      throw new CloudArchiveError('Datesheet lock is stale and needs user cleanup', 'lockTimeout')
    } else {
      throw new CloudArchiveError('Datesheet is busy with another operation', 'lockBusy')
    }
  }

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
  if (requireSorted && strings.length <= MAX_INLINE_DATESHEET_FILE_NAMES) {
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
  const fileNames = assertRelativeStringList(entry.fileNames ?? [], 'fileNames', true)
  const archiveParts = assertRelativeStringList(entry.archiveParts, 'archiveParts', true)
  if (!Number.isFinite(entry.sizeBytes) || entry.sizeBytes < 0)
    throw new CloudArchiveError('Invalid datesheet sizeBytes', 'schemaInvalid')
  if (
    !Number.isInteger(entry.fileCount) ||
    entry.fileCount < 0 ||
    (fileNames.length > 0 && entry.fileCount !== fileNames.length)
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

async function readDatesheetForOperation(
  root: string,
  role: CloudStorageRole,
  label: string,
  timeoutMs = CONFIG_IO_TIMEOUT_MS
): Promise<DateSheetReadResult> {
  return await withOperationTimeout(readDatesheet(root, role), label, timeoutMs)
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
  const previous = datesheetQueues.get(key)
  if (previous) {
    await withOperationTimeout(
      previous.catch(() => undefined),
      `Waiting for previous datesheet write at ${root}`,
      DATESHEET_WRITE_TIMEOUT_MS
    ).catch((error) => {
      if (datesheetQueues.get(key) === previous) datesheetQueues.delete(key)
      throw error
    })
  }

  const next = withOperationTimeout(action(), `Writing datesheet at ${root}`, DATESHEET_WRITE_TIMEOUT_MS)
  datesheetQueues.set(
    key,
    next.finally(() => {
      if (datesheetQueues.get(key) === next) datesheetQueues.delete(key)
    })
  )
  return await next
}

async function writeDatesheet(root: string, datesheet: CloudDatesheet): Promise<void> {
  await enqueueDatesheetWrite(root, async () => {
    await withOperationTimeout(fse.ensureDir(root), `Ensuring datesheet root ${root}`)
    const operationId = datesheet.lastOperationId || generateUUID()
    const releaseLock = await withOperationTimeout(
      acquireDatesheetLock(root, operationId),
      `Acquiring datesheet lock at ${root}`
    )
    try {
      const filePath = datesheetPath(root)
      const tmpPath = datesheetTmpPath(root)
      const bakPath = datesheetBakPath(root)
      const compactDatesheet = compactDatesheetForWrite(datesheet)
      const nextDatesheet = { ...compactDatesheet, lastOperationId: operationId, updatedAt: nowIso() }
      if (await withOperationTimeout(pathExists(filePath), `Checking datesheet at ${root}`)) {
        await withOperationTimeout(
          fse.copy(filePath, bakPath, { overwrite: true }),
          `Backing up datesheet at ${root}`
        )
      }
      await withOperationTimeout(
        fse.writeFile(tmpPath, JSON.stringify(nextDatesheet, null, 2), 'utf-8'),
        `Writing temporary datesheet at ${root}`
      )
      validateDatesheetSchema(
        await withOperationTimeout(
          readJsonFile<CloudDatesheet>(tmpPath),
          `Reading temporary datesheet at ${root}`
        ),
        nextDatesheet.role
      )
      await withOperationTimeout(
        fse.move(tmpPath, filePath, { overwrite: true }),
        `Promoting datesheet at ${root}`
      )
      validateDatesheetSchema(
        await withOperationTimeout(
          readJsonFile<CloudDatesheet>(filePath),
          `Verifying datesheet at ${root}`
        ),
        nextDatesheet.role
      )
      await withOperationTimeout(fse.remove(tmpPath).catch(() => {}), `Cleaning datesheet tmp at ${root}`)
    } catch (error) {
      if (error instanceof CloudArchiveError) throw error
      throw new CloudArchiveError(
        `Failed to write datesheet: ${getErrorMessage(error)}`,
        'writeFailed'
      )
    } finally {
      await withOperationTimeout(releaseLock(), `Releasing datesheet lock at ${root}`).catch((error) => {
        log.warn('[Cloud] Failed to release datesheet lock in time:', error)
      })
    }
  })
}
async function ensureConfiguredDatesheets(
  config: CloudStorageConfig,
  initializeDatesheet: boolean
): Promise<void> {
  const localResult = await readDatesheetForOperation(
    config.localRoot,
    'localCache',
    'Reading local datesheet during readiness check'
  )
  const cloudResult = await readDatesheetForOperation(
    config.cloudRoot,
    'cloudArchive',
    'Reading cloud datesheet during readiness check'
  )
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
    await readDatesheetForOperation(
      config.localRoot,
      'localCache',
      'Verifying initialized local datesheet'
    ),
    config.localRoot
  )
  const cloud = assertDatesheetRead(
    await readDatesheetForOperation(
      config.cloudRoot,
      'cloudArchive',
      'Verifying initialized cloud datesheet'
    ),
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
    const backup = await withOperationTimeout(
    readJsonFile<CloudDatesheet>(backupPath),
    'Reading datesheet backup'
  )
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
  let lock = emptyLockInfo()
  const createBase = (): CloudDatesheetSideStatus => ({
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
  })

  if (!root) return createBase()

  try {
    lock = await withOperationTimeout(
      readDatesheetLock(root),
      `Reading ${role} datesheet lock`,
      5_000
    )
  } catch (error) {
    return {
      ...createBase(),
      status: 'operationTimeout',
      error: getErrorMessage(error)
    }
  }

  const base = createBase()
  try {
    const [hasRootContent, result, canRestoreFromBackup, exists] = await Promise.all([
      withOperationTimeout(directoryHasContent(root), `Reading ${role} root content`, 5_000),
      withOperationTimeout(readDatesheet(root, role), `Reading ${role} datesheet`, 5_000),
      withOperationTimeout(
        canRestoreDatesheetFromBackup(root, role),
        `Reading ${role} datesheet backup`,
        5_000
      ),
      withOperationTimeout(pathExists(datesheetPath(root)), `Checking ${role} datesheet file`, 5_000)
    ])

    if (result.status === 'ok') {
      return {
        ...base,
        status: result.recoveredFromBackup ? 'recoveredFromBackup' : 'ok',
        exists,
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
      exists,
      hasRootContent,
      canRestoreFromBackup,
      error: result.error || ''
    }
  } catch (error) {
    return {
      ...base,
      status: 'operationTimeout',
      error: getErrorMessage(error)
    }
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

  const backup = await withOperationTimeout(
    readJsonFile<CloudDatesheet>(backupPath),
    'Reading datesheet backup'
  )
  validateDatesheetSchema(backup, role)

  await enqueueDatesheetWrite(root, async () => {
    const operationId = generateUUID()
    const releaseLock = await withOperationTimeout(
      acquireDatesheetLock(root, operationId),
      'Acquiring datesheet restore lock'
    )
    try {
      const filePath = datesheetPath(root)
      const tmpPath = datesheetTmpPath(root)
      if (await withOperationTimeout(pathExists(filePath), 'Checking current datesheet before restore'))
        await withOperationTimeout(
          fse.copy(filePath, datesheetCorruptPath(root), { overwrite: false }),
          'Backing up corrupt datesheet before restore',
          DIRECTORY_OPERATION_TIMEOUT_MS
        )
      const restored = { ...backup, updatedAt: nowIso(), lastOperationId: operationId }
      await withOperationTimeout(
        fse.writeFile(tmpPath, JSON.stringify(restored, null, 2), 'utf-8'),
        'Writing restored datesheet'
      )
      validateDatesheetSchema(
        await withOperationTimeout(readJsonFile<CloudDatesheet>(tmpPath), 'Verifying restored temp datesheet'),
        role
      )
      await withOperationTimeout(
        fse.move(tmpPath, filePath, { overwrite: true }),
        'Promoting restored datesheet',
        DIRECTORY_OPERATION_TIMEOUT_MS
      )
      validateDatesheetSchema(
        await withOperationTimeout(readJsonFile<CloudDatesheet>(filePath), 'Reading restored datesheet'),
        role
      )
      await withOperationTimeout(fse.remove(tmpPath).catch(() => {}), 'Cleaning restore tmp datesheet')
    } finally {
      await withOperationTimeout(releaseLock(), 'Releasing datesheet restore lock').catch((error) => {
        log.warn('[Cloud] Failed to release datesheet restore lock:', error)
      })
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
  await withOperationTimeout(
    fse.remove(datesheetLockPath(root)),
    'Removing stale datesheet lock'
  )
  return await getCloudDatesheetStatus()
}
async function getConfig(): Promise<CloudStorageConfig> {
  return normalizeConfig(await ConfigDBManager.getConfigLocalValue('game.cloudStorage'))
}

export async function getCloudConfig(): Promise<CloudStorageConfig> {
  return await getConfig()
}

function isCompleteCloudConfigUpdate(update: CloudConfigUpdate): update is CloudStorageConfig {
  return (
    typeof update.enabled === 'boolean' &&
    typeof update.cloudRoot === 'string' &&
    typeof update.localRoot === 'string' &&
    typeof update.localLimitBytes === 'number' &&
    update.archiveFormat === '7z' &&
    typeof update.volumeSizeBytes === 'number' &&
    typeof update.sevenZipPath === 'string' &&
    typeof update.autoImportNewGames === 'boolean'
  )
}

async function resolveCloudConfigUpdate(update: CloudConfigUpdate): Promise<CloudStorageConfig> {
  if (isCompleteCloudConfigUpdate(update)) return normalizeConfig(update)
  return normalizeConfig({ ...(await getConfig()), ...update })
}

async function saveCloudConfigUpdate(update: CloudConfigUpdate): Promise<CloudStorageConfig> {
  const next = await resolveCloudConfigUpdate(update)
  if (!next.enabled || !next.cloudRoot || !next.localRoot) {
    next.autoImportNewGames = false
  }
  validateCloudConfigForSave(next)
  await withOperationTimeout(
    ConfigDBManager.setConfigLocalValue('game.cloudStorage', next),
    'Saving cloud archive config'
  )
  return next
}

async function validateCloudStorageRoots(config: CloudStorageConfig): Promise<void> {
  await withOperationTimeout(
    ensureWritableDirectory(config.localRoot, 'Local cache directory'),
    'Checking local cache directory'
  )
  await withOperationTimeout(
    ensureWritableDirectory(config.cloudRoot, 'Cloud archive directory'),
    'Checking cloud archive directory'
  )
  if (pathEquals(path.resolve(config.localRoot), path.resolve(config.cloudRoot))) {
    throw new CloudArchiveError(
      'Local cache and cloud archive directories cannot be the same',
      'sameRoot'
    )
  }
}

function validateCloudConfigForSave(config: CloudStorageConfig): void {
  if (!config.enabled) return
  if (!config.localRoot || !config.cloudRoot) {
    throw new CloudArchiveError('Cloud archive directories are not configured', 'pathEmpty')
  }
  if (pathEquals(path.resolve(config.localRoot), path.resolve(config.cloudRoot))) {
    throw new CloudArchiveError(
      'Local cache and cloud archive directories cannot be the same',
      'sameRoot'
    )
  }
}

export async function updateCloudConfig(update: CloudConfigUpdate): Promise<CloudStorageConfig> {
  return await saveCloudConfigUpdate(update)
}

export async function initializeCloudDatesheets(
  update?: CloudConfigUpdate
): Promise<CloudDatesheetStatusReport> {
  const config = update ? await saveCloudConfigUpdate(update) : await getConfig()
  await validateCloudStorageRoots(config)
  await withOperationTimeout(
    ensureConfiguredDatesheets(config, true),
    'Initializing cloud archive datesheets'
  )
  return await getCloudDatesheetStatus()
}

async function ensureReadyConfig(): Promise<CloudStorageConfig> {
  const config = await getConfig()
  if (!config.enabled) throw new CloudArchiveError('Cloud archive is not enabled', 'notEnabled')
  await withOperationTimeout(
    ensureWritableDirectory(config.localRoot, 'Local cache directory'),
    'Checking local cache directory'
  )
  await withOperationTimeout(
    ensureWritableDirectory(config.cloudRoot, 'Cloud archive directory'),
    'Checking cloud archive directory'
  )
  await withOperationTimeout(
    ensureConfiguredDatesheets(config, false),
    'Checking cloud archive datesheets'
  )
  return config
}

async function listManifest(
  root: string,
  task?: CloudTaskState,
  scanMessage = 'Scanning files'
): Promise<FileManifest> {
  const entries: Array<{ relativePath: string; size: number }> = []
  let scannedBytes = 0
  let lastEmitAt = 0

  const emitScanProgress = (force = false): void => {
    if (!task) return
    const now = Date.now()
    if (!force && now - lastEmitAt < PROGRESS_THROTTLE_MS) return
    lastEmitAt = now
    updateProgress(task, {
      percent: task.progress.percent,
      processedBytes: task.progress.processedBytes,
      totalBytes: task.progress.totalBytes,
      message: scanMessage + ' (' + entries.length + ' files)'
    })
  }

  async function walk(current: string): Promise<void> {
    if (task) assertTaskNotCanceled(task)
    const dirents = await fse.readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      if (task) assertTaskNotCanceled(task)
      if (dirent.name === TMP_DIR) continue
      const fullPath = path.join(current, dirent.name)
      const relativePath = normalizePath(path.relative(root, fullPath))
      if (dirent.isDirectory()) await walk(fullPath)
      else if (dirent.isFile()) {
        const stat = await fse.stat(fullPath)
        entries.push({ relativePath, size: stat.size })
        scannedBytes += stat.size
        emitScanProgress()
      }
    }
  }

  emitScanProgress(true)
  await walk(root)
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.relativePath + '\0' + entry.size + '\n')
  }
  emitScanProgress(true)
  return {
    fileNames: entries.map((entry) => entry.relativePath),
    fileCount: entries.length,
    sizeBytes: scannedBytes,
    fileListHash: hash.digest('hex')
  }
}

function getInlineDatesheetFileNames(manifest: FileManifest): string[] {
  return manifest.fileCount <= MAX_INLINE_DATESHEET_FILE_NAMES ? manifest.fileNames : []
}

function compactDatesheetForWrite(datesheet: CloudDatesheet): CloudDatesheet {
  return {
    ...datesheet,
    games: Object.fromEntries(
      Object.entries(datesheet.games).map(([gameId, entry]) => [
        gameId,
        {
          ...entry,
          fileNames:
            (entry.fileNames ?? []).length <= MAX_INLINE_DATESHEET_FILE_NAMES
              ? (entry.fileNames ?? [])
              : []
        }
      ])
    )
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
    fileNames: getInlineDatesheetFileNames(params.manifest),
    fileListHash: params.manifest.fileListHash,
    archiveRevision: revision,
    localRevision: revision,
    lastVerifiedAt: nowIso(),
    lastError: params.lastError || ''
  }
}

async function updateDatesheetGameEntry(
  root: string,
  role: CloudStorageRole,
  entry: CloudDatesheetGameEntry,
  operationId: string
): Promise<void> {
  const datesheet = assertDatesheetRead(
    await readDatesheetForOperation(root, role, `Reading ${role} datesheet before update`),
    root
  )
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
  const datesheet = assertDatesheetRead(
    await readDatesheetForOperation(root, role, `Reading ${role} datesheet before removal`),
    root
  )
  if (!datesheet.games[gameId]) return
  datesheet.lastOperationId = operationId
  delete datesheet.games[gameId]
  await writeDatesheet(root, datesheet)
}

async function readPairedDatesheets(
  config: CloudStorageConfig,
  task?: CloudTaskState
): Promise<{ local: CloudDatesheet; cloud: CloudDatesheet }> {
  if (task) {
    updateProgress(task, {
      phase: 'writingDatesheet',
      percent: 99,
      message: 'Checking local datesheet'
    })
  }
  const local = assertDatesheetRead(
    await readDatesheetForOperation(
      config.localRoot,
      'localCache',
      'Reading local datesheet for cloud archive task'
    ),
    config.localRoot
  )
  if (task) {
    updateProgress(task, {
      phase: 'writingDatesheet',
      percent: 99,
      message: 'Checking cloud datesheet'
    })
  }
  const cloud = assertDatesheetRead(
    await readDatesheetForOperation(
      config.cloudRoot,
      'cloudArchive',
      'Reading cloud datesheet for cloud archive task'
    ),
    config.cloudRoot
  )
  if (local.pairId !== cloud.pairId)
    throw new CloudArchiveError('Local and cloud datesheets do not match', 'pairMismatch')
  return { local, cloud }
}

async function writeEntryToBothDatesheets(
  config: CloudStorageConfig,
  entry: CloudDatesheetGameEntry,
  operationId: string,
  task?: CloudTaskState,
  options: { localRequired?: boolean; cloudRequired?: boolean; localFirst?: boolean } = {}
): Promise<void> {
  const localRequired = options.localRequired ?? false
  const cloudRequired = options.cloudRequired ?? true

  const writeSide = async (role: CloudStorageRole): Promise<void> => {
    const isLocal = role === 'localCache'
    const required = isLocal ? localRequired : cloudRequired
    const label = isLocal ? 'local' : 'cloud'
    if (task) {
      updateProgress(task, {
        phase: 'writingDatesheet',
        percent: 99,
        message: `Writing ${label} datesheet`
      })
    }
    const root = isLocal ? config.localRoot : config.cloudRoot
    try {
      if (!required) {
        const stat = await withOperationTimeout(
          fse.stat(datesheetPath(root)),
          `Checking ${label} datesheet size`,
          5_000
        ).catch(() => null)
        if (stat && stat.size > OPTIONAL_DATESHEET_MAX_BYTES) {
          throw new CloudArchiveError(
            `${label} datesheet is too large to update during a cloud task`,
            'datesheetTooLarge'
          )
        }
      }
      const updatePromise = updateDatesheetGameEntry(root, role, entry, operationId)
      if (required) await updatePromise
      else {
        await withOperationTimeout(
          updatePromise,
          `Updating optional ${label} datesheet`,
          OPTIONAL_DATESHEET_WRITE_TIMEOUT_MS
        )
      }
    } catch (error) {
      if (required) throw error
      log.warn(`[Cloud] Skipped non-critical ${label} datesheet update:`, error)
      if (task) {
        updateProgress(task, {
          phase: 'writingDatesheet',
          percent: 99,
          message: `${label[0].toUpperCase()}${label.slice(1)} datesheet update skipped; continuing`
        })
      }
    }
  }

  if (options.localFirst) {
    await writeSide('localCache')
    await writeSide('cloudArchive')
  } else {
    await writeSide('cloudArchive')
    await writeSide('localCache')
  }
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

  await withOperationTimeout(
    fse.remove(currentPath),
    'Removing canceled managed copy',
    DIRECTORY_OPERATION_TIMEOUT_MS
  ).catch((cleanupError) => {
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
    copyStreams: new Set(),
    lastProgressEmitAt: 0,
    lastProgressEmitBytes: 0,
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

function stopTaskResources(task: CloudTaskState, error: CloudArchiveError): void {
  for (const { source, target } of task.copyStreams) {
    source.destroy(error)
    target.destroy(error)
  }
  task.child?.kill()
}

function cancelTaskWithError(task: CloudTaskState, error: CloudArchiveError): void {
  task.canceled = true
  stopTaskResources(task, error)
}

async function runTaskWithIdleWatchdog<T>(
  task: CloudTaskState,
  action: () => Promise<T>
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      callback()
    }
    const watchdog = setInterval(() => {
      if (settled) return
      if (task.canceled) {
        finish(() => reject(new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled')))
        return
      }
      const updatedAt = new Date(task.progress.updatedAt).getTime()
      const lastActivityAt = Number.isFinite(updatedAt) ? updatedAt : Date.now()
      if (Date.now() - lastActivityAt > CLOUD_TASK_IDLE_TIMEOUT_MS) {
        const error = new CloudArchiveError(
          'Cloud archive task stopped reporting progress',
          'operationTimeout'
        )
        cancelTaskWithError(task, error)
        finish(() => reject(error))
      }
    }, CLOUD_TASK_WATCHDOG_INTERVAL_MS)

    action().then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

async function enqueueCloudTask<T>(
  task: CloudTaskState,
  phase: CloudTaskPhase,
  message: string,
  action: () => Promise<T>
): Promise<T> {
  const run = cloudTaskQueue.catch(() => undefined).then(async () => {
    assertTaskNotCanceled(task)
    updateProgress(task, {
      phase,
      percent: 0,
      processedBytes: 0,
      totalBytes: task.progress.totalBytes,
      message
    })
    return await runTaskWithIdleWatchdog(task, action)
  })
  cloudTaskQueue = run.then(
    () => undefined,
    () => undefined
  )
  return await run
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
  const previousProgress = task.progress
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

  const now = Date.now()
  const phaseChanged = Boolean(patch.phase && patch.phase !== previousProgress.phase)
  const messageChanged = Boolean(patch.message && patch.message !== previousProgress.message)
  const terminalPhase = task.progress.phase === 'completed' || task.progress.phase === 'error'
  const firstEmit = task.lastProgressEmitAt === 0
  const enoughTimePassed = now - task.lastProgressEmitAt >= PROGRESS_THROTTLE_MS
  const enoughBytesProcessed =
    Math.abs(task.progress.processedBytes - task.lastProgressEmitBytes) >= PROGRESS_THROTTLE_BYTES

  if (firstEmit || phaseChanged || messageChanged || terminalPhase || enoughTimePassed || enoughBytesProcessed) {
    task.lastProgressEmitAt = now
    task.lastProgressEmitBytes = task.progress.processedBytes
    ipcManager.send('cloud:task-progress', task.progress)
  }
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
  const taskId = task.progress.taskId
  taskIdByGameId.delete(task.progress.gameId)
  setTimeout(() => {
    const current = tasksById.get(taskId)
    if (
      current === task &&
      (current.progress.phase === 'completed' || current.progress.phase === 'error')
    ) {
      tasksById.delete(taskId)
    }
  }, TERMINAL_TASK_RETENTION_MS)
}

async function copyFileWithProgress(
  sourcePath: string,
  targetPath: string,
  sizeBytes: number,
  manifest: FileManifest,
  task: CloudTaskState
): Promise<void> {
  await withOperationTimeout(
    fse.ensureDir(path.dirname(targetPath)),
    'Ensuring copy target directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
  const source = createReadStream(sourcePath)
  const target = createWriteStream(targetPath)
  const pair = { source, target }
  task.copyStreams.add(pair)
  let lastActivityAt = Date.now()

  const destroyCopy = (error: CloudArchiveError): void => {
    source.destroy(error)
    target.destroy(error)
  }

  const watchdog = setInterval(() => {
    if (task.canceled) {
      destroyCopy(new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled'))
      return
    }
    if (Date.now() - lastActivityAt > COPY_FILE_IDLE_TIMEOUT_MS) {
      destroyCopy(new CloudArchiveError('Copying game file stopped reporting progress', 'operationTimeout'))
    }
  }, COPY_FILE_WATCHDOG_INTERVAL_MS)

  source.on('data', (chunk) => {
    lastActivityAt = Date.now()
    if (task.canceled) {
      destroyCopy(new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled'))
      return
    }
    const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    const processedBytes = Math.min(task.progress.processedBytes + chunkBytes, manifest.sizeBytes)
    updateProgress(task, {
      processedBytes,
      percent:
        manifest.sizeBytes > 0 ? Math.min(99, (processedBytes / manifest.sizeBytes) * 100) : 99
    })
  })

  try {
    await pipeline(source, target)
    assertTaskNotCanceled(task)
    if (sizeBytes === 0) {
      updateProgress(task, {
        processedBytes: task.progress.processedBytes,
        percent: manifest.sizeBytes > 0 ? task.progress.percent : 99
      })
    }
  } finally {
    clearInterval(watchdog)
    task.copyStreams.delete(pair)
  }
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
        await withOperationTimeout(
          fse.ensureDir(targetPath),
          'Creating copied directory',
          DIRECTORY_OPERATION_TIMEOUT_MS
        )
        await walk(sourcePath)
      } else if (dirent.isFile()) {
        const stat = await fse.stat(sourcePath)
        await copyFileWithProgress(sourcePath, targetPath, stat.size, manifest, task)
      }
    }
  }

  await walk(sourceRoot)
  updateProgress(task, {
    processedBytes: manifest.sizeBytes,
    percent: 99,
    message: 'Finished copying game files; verifying local cache'
  })
}
async function validateSevenZipExecutable(executable: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(executable, ['-h'], { windowsHide: true })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve(false)
    }, CONFIG_IO_TIMEOUT_MS)
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
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
      let lastActivityAt = Date.now()
      let settled = false

      const killChild = (): void => {
        try {
          child.kill()
        } catch (error) {
          log.warn('[Cloud] Failed to kill 7-Zip process:', error)
        }
      }

      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        task.child = undefined
        if (error) reject(error)
        else resolve()
      }

      const watchdog = setInterval(() => {
        if (settled) return
        if (task.canceled) {
          killChild()
          finish(new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled'))
          return
        }
        if (Date.now() - lastActivityAt > SEVEN_ZIP_IDLE_TIMEOUT_MS) {
          killChild()
          finish(new CloudArchiveError('7-Zip stopped reporting progress', 'operationTimeout'))
        }
      }, SEVEN_ZIP_WATCHDOG_INTERVAL_MS)

      const handleData = (data: Buffer): void => {
        lastActivityAt = Date.now()
        const chunk = data.toString()
        output += chunk
        const matches = chunk.match(/(\d{1,3})%/g)
        const last = matches?.at(-1)
        if (last) {
          const percent = Math.max(0, Math.min(99, Number(last.replace('%', ''))))
          updateProgress(task, {
            percent,
            message: percent >= 99 ? message + ' - finalizing' : message,
            processedBytes:
              task.progress.totalBytes > 0
                ? Math.floor((task.progress.totalBytes * percent) / 100)
                : task.progress.processedBytes
          })
        }
      }
      child.stdout.on('data', handleData)
      child.stderr.on('data', handleData)
      child.once('error', (error) => finish(error))
      child.once('exit', (code) => {
        if (task.canceled) {
          finish(new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled'))
        } else if (code === 0) {
          finish()
        } else {
          finish(new CloudArchiveError(output || '7-Zip exited with code ' + code, 'sevenZipFailed'))
        }
      })
    })
  })
}

async function replaceDirectoryWithRollback(
  sourceDir: string,
  targetDir: string,
  backupDir: string,
  task?: CloudTaskState
): Promise<void> {
  if (task) {
    updateProgress(task, {
      phase: 'verifying',
      percent: 99,
      message: 'Publishing archive directory'
    })
  }
  await withOperationTimeout(
    fse.remove(backupDir),
    'Removing previous archive backup',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
  await withOperationTimeout(
    fse.ensureDir(path.dirname(targetDir)),
    'Ensuring archive parent',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )

  const hadTarget = await pathExists(targetDir)
  if (hadTarget)
    await withOperationTimeout(
      fse.move(targetDir, backupDir, { overwrite: true }),
      'Backing up previous archive',
      DIRECTORY_OPERATION_TIMEOUT_MS
    )

  try {
    await withOperationTimeout(
      fse.move(sourceDir, targetDir, { overwrite: false }),
      'Publishing archive directory',
      DIRECTORY_OPERATION_TIMEOUT_MS
    )
  } catch (error) {
    if (hadTarget && !(await pathExists(targetDir)) && (await pathExists(backupDir))) {
      await withOperationTimeout(
        fse.move(backupDir, targetDir, { overwrite: false }),
        'Restoring previous archive',
        DIRECTORY_OPERATION_TIMEOUT_MS
      ).catch((restoreError) => {
        log.error(
          '[Cloud] Failed to restore previous archive after replacement failure:',
          restoreError
        )
      })
    }
    throw error
  }

  await withOperationTimeout(
    fse.remove(backupDir),
    'Removing archive backup',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
}

async function detachDirectoryForBackgroundRemoval(
  directory: string,
  root: string,
  task: CloudTaskState,
  message: string
): Promise<void> {
  const deleteDir = path.join(root, TMP_DIR, 'delete-' + task.progress.taskId)
  updateProgress(task, {
    phase: 'deleting',
    percent: 99,
    message
  })
  await withOperationTimeout(
    fse.ensureDir(path.dirname(deleteDir)),
    'Ensuring cleanup directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
  await withOperationTimeout(
    fse.remove(deleteDir),
    'Removing stale cleanup directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
  await withOperationTimeout(
    fse.move(directory, deleteDir, { overwrite: false }),
    'Moving directory to cleanup directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
  void fse.remove(deleteDir).catch((error) => {
    log.warn('[Cloud] Failed to remove detached cleanup directory:', error)
  })
}

async function archiveGame(
  config: CloudStorageConfig,
  gameId: string,
  sourceRoot: string,
  task: CloudTaskState
): Promise<{ entry: CloudDatesheetGameEntry; manifest: FileManifest }> {
  const executable = await findSevenZip(config)
  updateProgress(task, {
    phase: 'scanning',
    percent: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: 'Scanning files for archive'
  })
  const manifest = await listManifest(sourceRoot, task, 'Scanning files for archive')
  const tempArchiveDir = path.join(config.cloudRoot, TMP_DIR, task.progress.taskId)
  const previousArchiveDir = path.join(
    config.cloudRoot,
    TMP_DIR,
    `${task.progress.taskId}-previous-${gameId}`
  )
  const finalArchiveDir = getArchiveDir(config, gameId)
  const archiveBase = path.join(tempArchiveDir, `${gameId}.7z`)
  let archivePromoted = false
  await withOperationTimeout(
    fse.remove(tempArchiveDir),
    'Removing stale archive temp directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
  await withOperationTimeout(
    fse.ensureDir(tempArchiveDir),
    'Creating archive temp directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )

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
        '-bsp1',
        `-v${config.volumeSizeBytes}b`,
        archiveBase,
        path.join(sourceRoot, '*')
      ],
      task,
      'compressing',
      'Compressing game files'
    )

    const partNames = (await withOperationTimeout(
      fse.readdir(tempArchiveDir),
      'Reading generated archive parts',
      DIRECTORY_OPERATION_TIMEOUT_MS
    ))
      .filter((name) => name.startsWith(`${gameId}.7z.`))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (partNames.length === 0)
      throw new CloudArchiveError('No 7z archive parts were generated', 'archivePartsMissing')
    for (const part of partNames) {
      const stat = await withOperationTimeout(
        fse.stat(path.join(tempArchiveDir, part)),
        'Checking generated archive part',
        DIRECTORY_OPERATION_TIMEOUT_MS
      )
      if (!stat.isFile() || stat.size <= 0)
        throw new CloudArchiveError(`Archive part is invalid: ${part}`, 'archivePartsMismatch')
    }

    updateProgress(task, {
      phase: 'verifying',
      percent: 99,
      message: 'Verifying archive parts'
    })
    assertTaskNotCanceled(task)
    await replaceDirectoryWithRollback(tempArchiveDir, finalArchiveDir, previousArchiveDir, task)
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
    if (!archivePromoted)
      await withOperationTimeout(
        fse.remove(tempArchiveDir),
        'Cleaning failed archive temp directory',
        DIRECTORY_OPERATION_TIMEOUT_MS
      ).catch(() => {})
    if (archivePromoted)
      await withOperationTimeout(
        fse.remove(previousArchiveDir),
        'Cleaning previous archive directory',
        DIRECTORY_OPERATION_TIMEOUT_MS
      ).catch(() => {})
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
    if (!(await withOperationTimeout(pathExists(partPath), 'Checking cloud archive part exists')))
      throw new CloudArchiveError(
        'Cloud archive may not have finished syncing yet',
        'archivePartsMissing'
      )
    const stat = await withOperationTimeout(
      fse.stat(partPath),
      'Checking cloud archive part',
      DIRECTORY_OPERATION_TIMEOUT_MS
    )
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
    const stat = await withOperationTimeout(
      fse.stat(getArchivePartPath(config, gameId, part)),
      'Reading cloud archive part size',
      DIRECTORY_OPERATION_TIMEOUT_MS
    )
    sizeBytes += stat.size
  }
  return sizeBytes
}
async function ensureLocalCacheCapacity(
  config: CloudStorageConfig,
  additionalBytes: number,
  task?: CloudTaskState
): Promise<void> {
  const usedBytes = await getLocalRootUsedBytes(config.localRoot, task)
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

  updateProgress(task, {
    phase: 'scanning',
    percent: 0,
    processedBytes: 0,
    totalBytes: 0,
    message: 'Scanning local game files'
  })
  const sourceManifest = await listManifest(currentRoot, task, 'Scanning local game files')
  await ensureLocalCacheCapacity(config, sourceManifest.sizeBytes, task)

  try {
    await copyDirectoryWithProgress(currentRoot, managedRoot, task, sourceManifest)
    assertTaskNotCanceled(task)
  } catch (error) {
    if (isPathWithinRoot(managedRoot, config.localRoot))
      await withOperationTimeout(
        fse.remove(managedRoot),
        'Cleaning failed managed local copy',
        DIRECTORY_OPERATION_TIMEOUT_MS
      ).catch(() => {})
    throw error
  }
  updateProgress(task, {
    phase: 'verifying',
    percent: 99,
    message: 'Verifying copied local cache'
  })
  const manifest = await listManifest(managedRoot, task, 'Verifying copied local cache')
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
  updateProgress(task, {
    phase: 'verifying',
    percent: 99,
    message: 'Local cache ready; continuing cloud archive task'
  })
  await GameDBManager.setGameLocal(gameId, migrated)
  return { local: migrated, sourceRoot: managedRoot, managedRoot }
}

async function saveArchiveResult(
  config: CloudStorageConfig,
  gameId: string,
  entry: CloudDatesheetGameEntry,
  status: CloudGameStatus,
  operationId: string,
  task?: CloudTaskState
): Promise<void> {
  const nextEntry = { ...entry, status, lastError: '', lastVerifiedAt: nowIso() }
  await writeEntryToBothDatesheets(config, nextEntry, operationId, task)
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
  updateProgress(task, {
    phase: 'writingDatesheet',
    percent: 99,
    message: 'Writing archive datesheets'
  })
  await saveArchiveResult(config, gameId, entry, 'local', task.progress.taskId, task)
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
  updateProgress(task, {
    phase: 'writingDatesheet',
    percent: 99,
    message: 'Writing archive datesheets'
  })
  await writeEntryToBothDatesheets(config, cloudEntry, task.progress.taskId, task)
  updateProgress(task, {
    phase: 'verifying',
    percent: 99,
    message: 'Verifying cloud archive before deleting local cache'
  })
  await verifyArchiveParts(config, gameId, cloudEntry)
  assertTaskNotCanceled(task)

  if (!isPathWithinRoot(managedRoot, config.localRoot)) {
    throw new CloudArchiveError('Refusing to delete a directory outside localRoot', 'unsafeDelete')
  }

  updateProgress(task, {
    phase: 'deleting',
    message: 'Deleting local cache after archive verification'
  })
  await detachDirectoryForBackgroundRemoval(
    managedRoot,
    config.localRoot,
    task,
    'Detaching local cache for background cleanup'
  )
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

async function getLocalRootUsedBytes(localRoot: string, task?: CloudTaskState): Promise<number> {
  if (!(await pathExists(localRoot))) return 0
  const manifest = await listManifest(localRoot, task, 'Checking local cache capacity')
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
  await ensureLocalCacheCapacity(config, estimatedBytes, task)

  const executable = await findSevenZip(config)
  const tempExtractDir = path.join(config.localRoot, TMP_DIR, task.progress.taskId)
  await withOperationTimeout(
    fse.remove(tempExtractDir),
    'Removing stale extraction directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
  await withOperationTimeout(
    fse.ensureDir(tempExtractDir),
    'Creating extraction directory',
    DIRECTORY_OPERATION_TIMEOUT_MS
  )
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
      ['x', '-bsp1', getArchivePartPath(config, gameId, entry.archiveParts[0]), `-o${tempExtractDir}`, '-y'],
      task,
      'extracting',
      'Extracting cloud archive to local cache'
    )

    updateProgress(task, {
      phase: 'verifying',
      percent: 99,
      message: 'Verifying extracted files'
    })
    manifest = await listManifest(tempExtractDir, task, 'Verifying extracted files')
    if (manifest.fileListHash !== entry.fileListHash) {
      throw new CloudArchiveError(
        'Extracted files do not match cloud datesheet',
        'fileListMismatch'
      )
    }

    assertTaskNotCanceled(task)
    updateProgress(task, {
      phase: 'verifying',
      percent: 99,
      message: 'Publishing local cache'
    })
    await withOperationTimeout(
      fse.move(tempExtractDir, targetRoot, { overwrite: false }),
      'Publishing local cache',
      DIRECTORY_OPERATION_TIMEOUT_MS
    )
    extractedPromoted = true
  } finally {
    if (!extractedPromoted)
      await withOperationTimeout(
        fse.remove(tempExtractDir),
        'Cleaning failed extraction directory',
        DIRECTORY_OPERATION_TIMEOUT_MS
      ).catch(() => {})
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

  updateProgress(task, {
    phase: 'writingDatesheet',
    percent: 99,
    message: 'Writing local datesheet'
  })
  const nextEntry = {
    ...entry,
    status: 'local' as CloudGameStatus,
    localManagedPath: targetRoot,
    sizeBytes: manifest.sizeBytes,
    localRevision: generateUUID(),
    lastVerifiedAt: nowIso(),
    lastError: ''
  }
  await writeEntryToBothDatesheets(config, nextEntry, task.progress.taskId, task, {
    localFirst: true,
    localRequired: false,
    cloudRequired: false
  })
}

async function runRebuildArchive(gameId: string, task: CloudTaskState): Promise<void> {
  const config = await ensureReadyConfig()
  await setGameCloudState(gameId, 'syncing')
  const { sourceRoot } = await ensureManagedLocalCopy(config, gameId, task)
  const { entry } = await archiveGame(config, gameId, sourceRoot, task)
  assertTaskNotCanceled(task)
  updateProgress(task, {
    phase: 'writingDatesheet',
    percent: 99,
    message: 'Writing archive datesheets'
  })
  await saveArchiveResult(config, gameId, entry, 'local', task.progress.taskId, task)
}

function startCloudTask(
  gameId: string,
  phase: CloudTaskPhase,
  message: string,
  runner: (task: CloudTaskState) => Promise<void>
): { taskId: string } {
  const task = createTask(gameId, gameId, 'queued', 'Waiting for other cloud archive tasks')
  void (async () => {
    try {
      task.progress.gameName = await getGameName(gameId)
      task.previousCloud = cloneGameLocal(await GameDBManager.getGameLocal(gameId)).cloud
      await enqueueCloudTask(task, phase, message, () => runner(task))
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

function isSafeGameStorageId(gameId: string): boolean {
  return Boolean(gameId) && !path.isAbsolute(gameId) && !gameId.includes('/') && !gameId.includes('\\')
}

async function listGameStorageIds(root: string): Promise<Set<string>> {
  if (!root || !(await pathExists(root))) return new Set()
  const dirents = await fse.readdir(root, { withFileTypes: true })
  return new Set(
    dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .filter((name) => name !== TMP_DIR && !name.startsWith('.') && isSafeGameStorageId(name))
  )
}

async function readDatesheetIfAvailable(
  root: string,
  role: CloudStorageRole
): Promise<CloudDatesheet | null> {
  if (!root) return null
  const result = await readDatesheet(root, role)
  return result.status === 'ok' ? result.datesheet : null
}


export function getCloudStorageLocation(): CloudStorageLocationInfo {
  const databaseRoot = getDataPath('')
  return {
    databaseRoot,
    configPath: getDataPath('config-local'),
    appRootPath: getAppRootPath(),
    isPortableMode: portableStore.isPortableMode
  }
}

export async function getCloudOrphans(): Promise<CloudOrphanSummary[]> {
  const config = await getConfig()
  if (!config.localRoot && !config.cloudRoot) return []

  const [games, localDocs, localIds, cloudIds, localDatesheet, cloudDatesheet] = await Promise.all([
    GameDBManager.getAllGames(),
    GameDBManager.getAllGamesLocal(),
    withOperationTimeout(listGameStorageIds(config.localRoot), 'Scanning local cache directory'),
    withOperationTimeout(listGameStorageIds(config.cloudRoot), 'Scanning cloud archive directory'),
    withOperationTimeout(readDatesheetIfAvailable(config.localRoot, 'localCache'), 'Reading local datesheet'),
    withOperationTimeout(readDatesheetIfAvailable(config.cloudRoot, 'cloudArchive'), 'Reading cloud datesheet')
  ])

  const ids = new Set<string>([
    ...localIds,
    ...cloudIds,
    ...Object.keys(localDatesheet?.games || {}),
    ...Object.keys(cloudDatesheet?.games || {})
  ])

  const summaries: CloudOrphanSummary[] = []
  for (const gameId of ids) {
    if (!isSafeGameStorageId(gameId)) continue
    const dbGame = games[gameId]
    const dbLocal = cloneGameLocal(localDocs[gameId])
    const hasDbGame = Boolean(dbGame?._id && dbGame._id !== 'collections')
    const hasLocalDir = localIds.has(gameId)
    const hasCloudDir = cloudIds.has(gameId)
    const localEntry = localDatesheet?.games[gameId]
    const cloudEntry = cloudDatesheet?.games[gameId]
    const hasLocalDatesheetEntry = Boolean(localEntry)
    const hasCloudDatesheetEntry = Boolean(cloudEntry)
    const localPath = config.localRoot ? getLocalManagedPath(config, gameId) : ''
    const archiveDir = config.cloudRoot ? getArchiveDir(config, gameId) : ''
    const gameName = dbGame?.metadata?.name || localEntry?.gameName || cloudEntry?.gameName || gameId
    let kind: CloudOrphanSummary['kind'] | null = null
    let reason = ''

    if (!hasDbGame && hasLocalDir) {
      kind = 'localOnly'
      reason = hasCloudDir
        ? 'Local cache and cloud archive exist, but the game database record is missing.'
        : 'Local cache exists, but the game database record is missing.'
    } else if (!hasDbGame && hasCloudDir) {
      kind = 'cloudOnly'
      reason = 'Cloud archive exists, but the game database record is missing.'
    } else if (!hasDbGame && (hasLocalDatesheetEntry || hasCloudDatesheetEntry)) {
      kind = 'datesheetOnly'
      reason = 'Datesheet has a game entry, but the game database record and files are incomplete.'
    } else if (hasDbGame) {
      const cloudState = dbLocal.cloud
      const isCloudManaged = Boolean(
        cloudState.localManagedPath || cloudState.archiveDir || cloudState.archiveParts.length
      )
      const expectedLocalPath = cloudState.localManagedPath || localPath
      const expectedArchiveDir = cloudState.archiveDir || archiveDir
      const expectedLocalMissing =
        isCloudManaged && cloudState.status !== 'cloud' && !(await pathExists(expectedLocalPath))
      const expectedCloudMissing =
        isCloudManaged && cloudState.status === 'cloud' && !(await pathExists(expectedArchiveDir))
      if (expectedLocalMissing || expectedCloudMissing) {
        kind = 'dbMissingFiles'
        reason = expectedCloudMissing
          ? 'The game database points to a cloud archive that is missing on disk.'
          : 'The game database points to a local cache that is missing on disk.'
      }
    }

    if (!kind) continue

    const sizeBytes = localEntry?.sizeBytes || cloudEntry?.sizeBytes || dbLocal.cloud.sizeBytes || 0

    summaries.push({
      gameId,
      gameName,
      kind,
      localPath,
      archiveDir,
      sizeBytes,
      hasDbGame,
      hasLocalDir,
      hasCloudDir,
      hasLocalDatesheetEntry,
      hasCloudDatesheetEntry,
      canRestore: kind === 'localOnly' && hasLocalDir && !hasDbGame,
      canArchive: kind === 'localOnly' && hasLocalDir,
      reason
    })
  }

  return summaries.sort((a, b) => a.gameName.localeCompare(b.gameName, undefined, { numeric: true }))
}

export async function restoreLocalOrphan(gameId: string): Promise<string> {
  const config = await ensureReadyConfig()
  if (!isSafeGameStorageId(gameId)) throw new CloudArchiveError('Invalid gameId', 'invalidGameId')
  const localPath = getLocalManagedPath(config, gameId)
  if (!(await pathExists(localPath)))
    throw new CloudArchiveError('Local orphan cache does not exist', 'localPathMissing')

  const games = await GameDBManager.getAllGames()
  if (games[gameId]?._id && games[gameId]._id !== 'collections') return gameId

  const { local, cloud } = await readPairedDatesheets(config)
  const sourceEntry = local.games[gameId] || cloud.games[gameId]
  const manifest = await listManifest(localPath)
  const gameName = sourceEntry?.gameName || path.basename(localPath)
  const operationId = generateUUID()

  const gameDoc = JSON.parse(JSON.stringify(DEFAULT_GAME_VALUES))
  gameDoc._id = gameId
  gameDoc.record.addDate = nowIso()
  gameDoc.metadata.name = gameName

  const gameLocal = cloneGameLocal({ _id: gameId })
  gameLocal.path.gamePath = ''
  gameLocal.utils.markPath = localPath
  gameLocal.utils.rootPath = localPath
  gameLocal.cloud = {
    ...gameLocal.cloud,
    status: 'local',
    localManagedPath: localPath,
    archiveDir: getArchiveDir(config, gameId),
    archiveParts: sourceEntry?.archiveParts || [],
    sizeBytes: manifest.sizeBytes,
    updatedAt: nowIso(),
    lastError: ''
  }

  await GameDBManager.setGame(gameId, gameDoc)
  await GameDBManager.setGameLocal(gameId, gameLocal)

  const localEntry: CloudDatesheetGameEntry = sourceEntry
    ? {
        ...sourceEntry,
        status: 'local',
        localManagedPath: localPath,
        archiveDir: gameId,
        sizeBytes: manifest.sizeBytes,
        fileCount: manifest.fileCount,
        fileNames: getInlineDatesheetFileNames(manifest),
        fileListHash: manifest.fileListHash,
        localRevision: generateUUID(),
        lastVerifiedAt: nowIso(),
        lastError: ''
      }
    : createGameEntry({
        gameId,
        gameName,
        status: 'local',
        localManagedPath: localPath,
        archiveDir: gameId,
        archiveParts: [],
        manifest
      })

  await updateDatesheetGameEntry(config.localRoot, 'localCache', localEntry, operationId)
  if (cloud.games[gameId]) {
    await updateDatesheetGameEntry(
      config.cloudRoot,
      'cloudArchive',
      {
        ...cloud.games[gameId],
        status: 'local',
        localManagedPath: localPath,
        sizeBytes: manifest.sizeBytes,
        lastVerifiedAt: nowIso(),
        lastError: ''
      },
      operationId
    )
  }

  eventBus.emit(
    'game:added',
    {
      gameId,
      name: gameName
    },
    { source: 'cloud-orphan-restore' }
  )

  return gameId
}

export async function archiveLocalOrphan(gameId: string): Promise<{ taskId: string }> {
  await restoreLocalOrphan(gameId)
  return importGameToCloud(gameId)
}
export async function getCloudGames(): Promise<CloudGameSummary[]> {
  const [games, localDocs, config] = await Promise.all([
    GameDBManager.getAllGames(),
    GameDBManager.getAllGamesLocal(),
    getConfig()
  ])
  return await Promise.all(
    Object.values(games)
      .filter((game) => game?._id && game._id !== 'collections')
      .map(async (game) => {
        const local = cloneGameLocal(localDocs[game._id])
        const hasActiveTask = taskIdByGameId.has(game._id)
        const storedStatus = local.cloud.status || 'local'
        const localManagedPath = local.cloud.localManagedPath || (config.localRoot ? getLocalManagedPath(config, game._id) : '')
        const archiveDir = local.cloud.archiveDir || (config.cloudRoot ? getArchiveDir(config, game._id) : '')
        let status: CloudGameStatus = storedStatus
        let lastError = local.cloud.lastError

        if ((storedStatus === 'syncing' || storedStatus === 'error') && !hasActiveTask) {
          const hasLocalCache = Boolean(
            localManagedPath &&
              (await withOperationTimeout(
                pathExists(localManagedPath),
                'Checking stale local cache path',
                5_000
              ).catch(() => false))
          )
          const hasCloudArchive = Boolean(
            archiveDir &&
              (await withOperationTimeout(
                pathExists(archiveDir),
                'Checking stale cloud archive path',
                5_000
              ).catch(() => false))
          )
          if (hasLocalCache) status = 'local'
          else if (hasCloudArchive || local.cloud.archiveParts.length > 0) status = 'cloud'
          else status = 'error'
          lastError =
            status === 'error'
              ? local.cloud.lastError || 'Previous cloud archive task did not finish. Please retry.'
              : local.cloud.lastError
        }

        return {
          gameId: game._id,
          gameName: game.metadata?.name || game._id,
          status,
          localManagedPath,
          archiveDir,
          archiveParts: local.cloud.archiveParts,
          sizeBytes: local.cloud.sizeBytes,
          updatedAt: local.cloud.updatedAt,
          lastError
        }
      })
  )
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
  cancelTaskWithError(task, new CloudArchiveError('Cloud archive task was canceled', 'taskCanceled'))
  return true
}

