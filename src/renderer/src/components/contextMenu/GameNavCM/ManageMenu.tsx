import { DEFAULT_PLAY_STATUS_ORDER } from '@appTypes/models'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { eventBus } from '~/app/events'
import { ipcManager } from '~/app/ipc'
import { DeleteGameAlert } from '~/components/Game/Config/ManageMenu/DeleteGameAlert'
import { RecalculateLastRunDateAlertDialog } from '~/components/Game/Overview/Record/RecalculateLastRunDateAlertDialog'
import { useLibrarybarStore } from '~/components/Librarybar/store'
import { Button } from '~/components/ui/button'
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '~/components/ui/context-menu'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { useConfigLocalState, useConfigState, useGameLocalState, useGameState } from '~/hooks'
import { useGameAdderStore } from '~/pages/GameAdder/store'
import { useRunningGames } from '~/pages/Library/store'
import { cn, formatStorageSize, waitForCloudTask } from '~/utils'

export function ManageMenu({
  gameId,
  openInformationEditorDialog,
  openPlayingTimeEditorDialog
}: {
  gameId: string
  openInformationEditorDialog: () => void
  openPlayingTimeEditorDialog: () => void
}): React.JSX.Element {
  const [gamePath] = useGameLocalState(gameId, 'path.gamePath')
  const [rootPath] = useGameLocalState(gameId, 'utils.rootPath')
  const [cloudStatus] = useGameLocalState(gameId, 'cloud.status')
  const [archiveDir] = useGameLocalState(gameId, 'cloud.archiveDir')
  const [archiveParts] = useGameLocalState(gameId, 'cloud.archiveParts')
  const [cloudRoot] = useConfigLocalState('game.cloudStorage.cloudRoot')
  const [gameName] = useGameState(gameId, 'metadata.name')
  const [nsfw, setNsfw] = useGameState(gameId, 'apperance.nsfw')
  const [playStatus, setPlayStatus] = useGameState(gameId, 'record.playStatus')
  const [score, setScore] = useGameState(gameId, 'record.score')
  const [preScore, setPreScore] = useState(score === -1 ? '' : score.toString())
  const [selectedGroup] = useConfigState('game.gameList.selectedGroup')
  const [isScoreDialogOpen, setIsScoreDialogOpen] = useState(false)
  const { refreshGameList } = useLibrarybarStore.getState()
  // Open the game metadata adder dialog in single game updater mode
  const setIsOpen = useGameAdderStore((state) => state.setIsOpen)
  const setName = useGameAdderStore((state) => state.setName)
  const setDbId = useGameAdderStore((state) => state.setDbId)
  const { t } = useTranslation('game')
  const { t: tCloud } = useTranslation('cloudArchive')
  const { runningGames } = useRunningGames()
  const isCloudTaskDisabled = cloudStatus === 'syncing' || runningGames.includes(gameId)
  const canDownloadFromCloud =
    cloudStatus === 'cloud' || (cloudStatus === 'error' && (Boolean(archiveDir) || archiveParts.length > 0))
  const cloudTaskDisabledReason = cloudStatus === 'syncing'
    ? tCloud('notifications.waitForSyncing')
    : runningGames.includes(gameId)
      ? tCloud('notifications.gameRunning')
      : undefined

  const refreshAfterCloudTask = async (promise: Promise<{ taskId: string }>): Promise<void> => {
    await waitForCloudTask(promise)
    refreshGameList()
  }

  const startCloudTask = (messages: { loading: string; success: string }, promise: Promise<{ taskId: string }>): void => {
    toast.promise(refreshAfterCloudTask(promise), {
      loading: messages.loading,
      success: messages.success,
      error: (error) => tCloud('notifications.taskFailed', { label: messages.loading, message: error.message })
    })
  }

  const isAbsolutePathLike = (value: string): boolean =>
    /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')

  const joinRootPath = (root: string, child: string): string => {
    if (!root) return child
    if (!child) return root
    if (isAbsolutePathLike(child)) return child
    return `${root.replace(/[\\/]+$/, '')}\\${child.replace(/^[\\/]+/, '')}`
  }

  const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Open path timed out')), timeoutMs)
      promise.then(
        (value) => {
          window.clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          window.clearTimeout(timer)
          reject(error)
        }
      )
    })

  const openPath = async (target: string): Promise<void> => {
    if (!target) {
      toast.warning(tCloud('notifications.archivePathMissing'))
      return
    }
    try {
      const [exists] = await withTimeout(ipcManager.invoke('system:check-if-path-exist', [target]), 10_000)
      if (!exists) {
        toast.error(tCloud('notifications.openPathFailed', { message: target }))
        return
      }
      await withTimeout(ipcManager.invoke('system:open-path-in-explorer', target), 10_000)
    } catch (error) {
      toast.error(tCloud('notifications.openPathFailed', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  const openArchiveDir = (): void => {
    void openPath(joinRootPath(cloudRoot, archiveDir || gameId))
  }

  const resetPreScore = (): void => setPreScore(score === -1 ? '' : score.toString())

  const changePlayStatus = (value: typeof playStatus): void => {
    setPlayStatus(value)
    eventBus.emit('game:play-status-changed', { gameId, status: value }, { source: 'manage-menu' })
    if (selectedGroup === 'record.playStatus') {
      refreshGameList()
    }
  }

  // Score submission handler function
  function confirmScore(): void {
    if (preScore === '') {
      setScore(-1)
      setIsScoreDialogOpen(false)
      toast.success(t('detail.header.rating.cleared'))
      return
    }

    const scoreNum = parseFloat(preScore)

    if (isNaN(scoreNum)) {
      toast.error(t('detail.header.rating.errors.invalidNumber'))
      resetPreScore()
      return
    }

    if (scoreNum < 0) {
      toast.error(t('detail.header.rating.errors.negative'))
      resetPreScore()
      return
    }

    if (scoreNum > 10) {
      toast.error(t('detail.header.rating.errors.tooHigh'))
      resetPreScore()
      return
    }

    const formattedScore = scoreNum.toFixed(1)

    if (preScore !== formattedScore && !Number.isInteger(scoreNum)) {
      toast.warning(t('detail.header.rating.warning'))
    }

    setScore(Number(formattedScore))
    setPreScore(Number(formattedScore).toString())
    setIsScoreDialogOpen(false)
    toast.success(t('detail.header.rating.success'))
  }

  return (
    <>
      <ContextMenuGroup>
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t('detail.manage.title')}</ContextMenuSubTrigger>
          <ContextMenuPortal>
            <ContextMenuSubContent>
              {/* Change Play Status */}
              <ContextMenuSub>
                <ContextMenuSubTrigger>{t('detail.header.playStatus.label')}</ContextMenuSubTrigger>
                <ContextMenuPortal>
                  <ContextMenuSubContent>
                    {DEFAULT_PLAY_STATUS_ORDER.map((status) => (
                      <ContextMenuItem
                        key={status}
                        onClick={() => changePlayStatus(status)}
                        className={playStatus === status ? 'bg-accent' : ''}
                      >
                        {t(`utils:game.playStatus.${status}`)}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuPortal>
              </ContextMenuSub>
              {/* Change Score */}
              <ContextMenuItem
                onSelect={(e) => {
                  e.preventDefault()
                  resetPreScore()
                  setIsScoreDialogOpen(true)
                }}
              >
                {t('detail.header.rating.tooltip')}
              </ContextMenuItem>
              {/* Mark/Unmark NSFW */}
              <ContextMenuItem onClick={() => setNsfw(!nsfw)}>
                {nsfw ? t('detail.manage.unmarkNSFW') : t('detail.manage.markNSFW')}
              </ContextMenuItem>

              <ContextMenuSeparator />

              {/* Edit Game Information */}
              <ContextMenuItem onSelect={openInformationEditorDialog}>
                {t('detail.manage.editInfo')}
              </ContextMenuItem>
              {/* Edit Play Time */}
              <ContextMenuItem onClick={openPlayingTimeEditorDialog}>
                {t('detail.manage.editPlayTime')}
              </ContextMenuItem>
              {/* Update Metadata */}
              <ContextMenuItem
                onClick={() => {
                  setDbId(gameId)
                  setName(gameName)
                  setIsOpen(true)
                }}
              >
                {t('detail.manage.downloadMetadata')}
              </ContextMenuItem>

              <ContextMenuSeparator />

              {/* Create Shortcut */}
              {/* Only show if gamePath is set */}
              {gamePath !== '' && (
                <ContextMenuItem
                  onClick={async () => {
                    try {
                      const targetPath = await ipcManager.invoke('system:select-path-dialog', [
                        'openDirectory'
                      ])
                      if (!targetPath) {
                        return
                      }
                      await ipcManager.invoke('utils:create-game-shortcut', gameId, targetPath)
                      toast.success(t('detail.manage.notifications.shortcutCreated'))
                    } catch (_error) {
                      toast.error(t('detail.manage.notifications.shortcutError'))
                    }
                  }}
                >
                  {t('detail.manage.createShortcut')}
                </ContextMenuItem>
              )}
              {/* Browse Local Files */}
              {/* Only work if rootPath is set */}
              <ContextMenuItem
                onClick={() => {
                  if (!rootPath) {
                    toast.warning(t('detail.manage.notifications.gamePathNotSet'))
                  } else {
                    ipcManager.invoke('system:open-path-in-explorer', rootPath)
                  }
                }}
              >
                {t('detail.manage.browseLocalFiles')}
              </ContextMenuItem>

              <ContextMenuSeparator />

              {canDownloadFromCloud ? (
                <ContextMenuItem
                  disabled={isCloudTaskDisabled}
                  title={cloudTaskDisabledReason}
                  onClick={() =>
                    startCloudTask(
                      {
                        loading: tCloud('notifications.downloadingToLocal'),
                        success: tCloud('notifications.downloadToLocalSuccess')
                      },
                      ipcManager.invoke('cloud:download-game-to-local', gameId)
                    )
                  }
                >
                  {tCloud('actions.download')}
                </ContextMenuItem>
              ) : (
                <ContextMenuItem
                  disabled={isCloudTaskDisabled}
                  title={cloudTaskDisabledReason}
                  onClick={() =>
                    startCloudTask(
                      {
                        loading: tCloud('notifications.migratingToCloud'),
                        success: tCloud('notifications.migrateToCloudSuccess')
                      },
                      ipcManager.invoke('cloud:migrate-game-to-cloud', gameId)
                    )
                  }
                >
                  {tCloud('actions.migrate')}
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={openArchiveDir}>{tCloud('actions.openArchive')}</ContextMenuItem>
              {!canDownloadFromCloud && (
                <ContextMenuItem
                  disabled={isCloudTaskDisabled}
                  title={cloudTaskDisabledReason}
                  onClick={() =>
                    startCloudTask(
                      {
                        loading: tCloud('notifications.rebuildingArchive'),
                        success: tCloud('notifications.rebuildArchiveSuccess')
                      },
                      ipcManager.invoke('cloud:rebuild-archive', gameId)
                    )
                  }
                >
                  {tCloud('actions.rebuild')}
                </ContextMenuItem>
              )}
              {/* Calculate Storage Size */}
              {rootPath && (
                <ContextMenuItem
                  onClick={() => {
                    toast.promise(ipcManager.invoke('game:calculate-storage-size', gameId), {
                      loading: t('detail.manage.notifications.calculatingStorageSize'),
                      success: (size: number) => {
                        if (size >= 0) {
                          return t('detail.manage.notifications.storageSizeCalculated', {
                            size: formatStorageSize(size)
                          })
                        }
                        throw new Error('Calculation failed')
                      },
                      error: () => t('detail.manage.notifications.storageSizeError')
                    })
                  }}
                >
                  {t('detail.manage.calculateStorageSize')}
                </ContextMenuItem>
              )}
              {/* Recalculate Last Run Date */}
              <RecalculateLastRunDateAlertDialog gameId={gameId}>
                <ContextMenuItem onSelect={(e) => e.preventDefault()}>
                  {t('detail.manage.recalculateLastRunDate')}
                </ContextMenuItem>
              </RecalculateLastRunDateAlertDialog>

              <ContextMenuSeparator />

              {/* Delete Game */}
              {/* Wrapped in DeleteGameAlert for confirmation */}
              <DeleteGameAlert gameId={gameId}>
                <ContextMenuItem onSelect={(e) => e.preventDefault()}>
                  {t('detail.manage.delete')}
                </ContextMenuItem>
              </DeleteGameAlert>
            </ContextMenuSubContent>
          </ContextMenuPortal>
        </ContextMenuSub>
      </ContextMenuGroup>

      {/* Score Input Dialog */}
      <Dialog open={isScoreDialogOpen} onOpenChange={setIsScoreDialogOpen}>
        <DialogContent showCloseButton={false} className="w-[500px]">
          <div className={cn('flex flex-row gap-3 items-center justify-center')}>
            <div className={cn('whitespace-nowrap')}>{t('detail.header.rating.title')}</div>
            <Input
              value={preScore}
              onChange={(e) => setPreScore(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmScore()
              }}
            />
            <Button onClick={confirmScore}>{t('utils:common.confirm')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
