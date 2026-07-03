import { CloudStorageRole } from '@appTypes/models'
import { ipcManager } from '~/core/ipc'
import {
  archiveLocalOrphan,
  cancelTask,
  cleanupDatesheetLock,
  downloadGameToLocal,
  getCloudConfig,
  getCloudDatesheetStatus,
  getCloudGames,
  getCloudOrphans,
  getCloudStorageLocation,
  getTaskProgress,
  importExistingGames,
  importGameToCloud,
  initializeCloudDatesheets,
  migrateGameToCloud,
  rebuildArchive,
  restoreDatesheetFromBackup,
  restoreLocalOrphan,
  updateCloudConfig
} from './services'

function normalizeCloudError(error: unknown): Error {
  if (error instanceof Error && error.name.startsWith('CloudArchiveError:')) {
    const code = error.name.slice('CloudArchiveError:'.length)
    return new Error(`[${code}] ${error.message}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function handleCloud<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw normalizeCloudError(error)
  }
}

export function setupCloudIPC(): void {
  ipcManager.handle('cloud:get-config', async () => await handleCloud(() => getCloudConfig()))
  ipcManager.handle(
    'cloud:update-config',
    async (_, config) => await handleCloud(() => updateCloudConfig(config))
  )
  ipcManager.handle(
    'cloud:initialize-datesheets',
    async (_, config) => await handleCloud(() => initializeCloudDatesheets(config))
  )
  ipcManager.handle(
    'cloud:get-datesheet-status',
    async () => await handleCloud(() => getCloudDatesheetStatus())
  )
  ipcManager.handle(
    'cloud:restore-datesheet-backup',
    async (_, role: CloudStorageRole) => await handleCloud(() => restoreDatesheetFromBackup(role))
  )
  ipcManager.handle(
    'cloud:cleanup-datesheet-lock',
    async (_, role: CloudStorageRole) => await handleCloud(() => cleanupDatesheetLock(role))
  )
  ipcManager.handle('cloud:get-games', async () => await handleCloud(() => getCloudGames()))
  ipcManager.handle('cloud:get-orphans', async () => await handleCloud(() => getCloudOrphans()))
  ipcManager.handle('cloud:get-storage-location', async () =>
    await handleCloud(() => getCloudStorageLocation())
  )
  ipcManager.handle('cloud:restore-local-orphan', async (_, gameId) =>
    await handleCloud(() => restoreLocalOrphan(gameId))
  )
  ipcManager.handle('cloud:archive-local-orphan', async (_, gameId) =>
    await handleCloud(() => archiveLocalOrphan(gameId))
  )
  ipcManager.handle(
    'cloud:import-existing-games',
    async () => await handleCloud(() => importExistingGames())
  )
  ipcManager.handle(
    'cloud:import-game-to-cloud',
    async (_, gameId) => await handleCloud(() => importGameToCloud(gameId))
  )
  ipcManager.handle(
    'cloud:migrate-game-to-cloud',
    async (_, gameId) => await handleCloud(() => migrateGameToCloud(gameId))
  )
  ipcManager.handle(
    'cloud:download-game-to-local',
    async (_, gameId) => await handleCloud(() => downloadGameToLocal(gameId))
  )
  ipcManager.handle(
    'cloud:rebuild-archive',
    async (_, gameId) => await handleCloud(() => rebuildArchive(gameId))
  )
  ipcManager.handle(
    'cloud:get-task-progress',
    async (_, query) => await handleCloud(() => getTaskProgress(query))
  )
  ipcManager.handle(
    'cloud:cancel-task',
    async (_, query) => await handleCloud(() => cancelTask(query))
  )
}
