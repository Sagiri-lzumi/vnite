import { cn, waitForCloudTask } from '~/utils'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '~/components/ui/alert-dialog'
import { useGameAdderStore, initializeStore } from './store'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ipcManager } from '~/app/ipc'
import { useConfigState } from '~/hooks'
import { useLibrarybarStore } from '~/components/Librarybar/store'
import { Search } from './Search'
import { GameList } from './GameList'
import { BackgroundList } from './BackgroundList'

type CloudAutoImportError = Error & { code?: string }

function parseCloudAutoImportError(error: unknown): { code: string; message: string } {
  const cloudError = error as Partial<CloudAutoImportError>
  const rawMessage = error instanceof Error ? error.message : String(error)
  if (cloudError.code) return { code: cloudError.code, message: rawMessage }
  const match = rawMessage.match(/^\[([^\]]+)]\s*(.*)$/)
  return match
    ? { code: match[1], message: match[2] || rawMessage }
    : { code: 'unknown', message: rawMessage }
}

function getCloudAutoImportErrorKey(code: string): string {
  if (code === 'localLimitExceeded' || code === 'diskSpaceInsufficient') return 'spaceInsufficient'
  if (code === 'sevenZipMissing' || code === 'sevenZipInvalid' || code === 'sevenZipFailed')
    return 'sevenZipUnavailable'
  if (
    [
      'pathEmpty',
      'pathNotWritable',
      'sameRoot',
      'datesheetMissing',
      'pairMismatch',
      'roleMismatch',
      'schemaUnsupported',
      'schemaInvalid',
      'corrupted',
      'unrecoverable',
      'lockBusy',
      'lockTimeout',
      'writeFailed'
    ].includes(code)
  )
    return 'cloudConfigInvalid'
  if (code === 'taskCanceled') return 'taskCanceled'
  return 'generic'
}

function GameAdderContent(): React.JSX.Element {
  const { isOpen, currentPage, handleClose, pendingCloudAutoImport, setPendingCloudAutoImport } =
    useGameAdderStore()
  const [defaultDataSource] = useConfigState('game.scraper.common.defaultDataSource')
  const { t } = useTranslation(['adder', 'cloudArchive'])

  useEffect(() => {
    const initStore = async (): Promise<void> => {
      initializeStore(defaultDataSource)
    }
    initStore()
  }, [defaultDataSource])

  const renderCurrentPage = (): React.JSX.Element => {
    switch (currentPage) {
      case 'search':
        return <Search />
      case 'games':
        return <GameList />
      case 'backgrounds':
        return <BackgroundList />
      default:
        return <Search />
    }
  }


  const confirmCloudAutoImport = (): void => {
    const pending = pendingCloudAutoImport
    if (!pending) return
    setPendingCloudAutoImport(null)
    toast.promise(
      waitForCloudTask(ipcManager.invoke('cloud:import-game-to-cloud', pending.gameId)).then(() =>
        useLibrarybarStore.getState().refreshGameList()
      ),
      {
        loading: t('gameAdder.cloudAutoImport.notifications.starting', {
          gameName: pending.gameName
        }),
        success: t('gameAdder.cloudAutoImport.notifications.success', {
          gameName: pending.gameName
        }),
        error: (error) => {
          const { code, message } = parseCloudAutoImportError(error)
          const errorKey = getCloudAutoImportErrorKey(code)
          if (errorKey !== 'generic') {
            return t(`gameAdder.cloudAutoImport.errors.${errorKey}`, {
              gameName: pending.gameName,
              message
            })
          }
          return t('gameAdder.cloudAutoImport.notifications.failed', {
            gameName: pending.gameName,
            message
          })
        }
      }
    )
  }

  const skipCloudAutoImport = (): void => {
    setPendingCloudAutoImport(null)
    toast.info(t('gameAdder.cloudAutoImport.notifications.skipped'))
  }

  return (
    <>
      <Dialog open={isOpen}>
        <DialogContent
          className={cn('w-auto h-auto max-w-none flex flex-col gap-5 outline-none')}
          onInteractOutside={(e) => {
            e.preventDefault()
          }}
          onClose={() => {
            handleClose()
          }}
        >
          {renderCurrentPage()}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(pendingCloudAutoImport)}
        onOpenChange={(open) => !open && setPendingCloudAutoImport(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('gameAdder.cloudAutoImport.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('gameAdder.cloudAutoImport.description', {
                gameName: pendingCloudAutoImport?.gameName || ''
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={skipCloudAutoImport}>
              {t('gameAdder.cloudAutoImport.actions.normalImport')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmCloudAutoImport}>
              {t('gameAdder.cloudAutoImport.actions.importToCloud')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function GameAdder(): React.JSX.Element {
  return <GameAdderContent />
}
