import { ipcManager } from '~/app/ipc'
import { useGameAdderStore } from './store'

export async function shouldPromptCloudAutoImportForPath(
  dirPath: string,
  gamePath?: string,
  dataSource?: string,
  dataSourceId?: string,
  existingGameId?: string
): Promise<boolean> {
  if (existingGameId) return false
  const targetPath = gamePath || dirPath
  if (!targetPath) return false
  try {
    if (await ipcManager.invoke('game:check-exits-by-path', targetPath)) return false
    if (
      dataSource &&
      dataSourceId &&
      (await ipcManager.invoke('game:check-exists-by-metadata-id', dataSource, dataSourceId))
    )
      return false
    return true
  } catch (error) {
    console.warn('[GameAdder] Failed to check existing game before cloud auto-import:', error)
    return false
  }
}

export async function requestCloudAutoImportPrompt(gameId: string): Promise<void> {
  if (!gameId) return
  try {
    const config = await ipcManager.invoke('cloud:get-config')
    if (!config.enabled || !config.autoImportNewGames || !config.cloudRoot || !config.localRoot)
      return

    const games = await ipcManager.invoke('cloud:get-games')
    const game = games.find((item) => item.gameId === gameId)
    if (
      !game ||
      game.status !== 'local' ||
      game.localManagedPath ||
      game.archiveDir ||
      game.archiveParts.length > 0
    )
      return

    useGameAdderStore.getState().setPendingCloudAutoImport({
      gameId,
      gameName: game.gameName || gameId
    })
  } catch (error) {
    console.warn('[GameAdder] Failed to prepare cloud auto-import prompt:', error)
  }
}
