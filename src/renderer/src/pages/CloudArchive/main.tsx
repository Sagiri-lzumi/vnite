import { useNavigate } from '@tanstack/react-router'
import type {
  CloudDatesheetSideStatus,
  CloudDatesheetStatusReport,
  CloudGameStatus,
  CloudGameSummary,
  CloudOrphanSummary,
  CloudStorageLocationInfo,
  CloudStorageRole,
  CloudTaskProgress,
  configLocalDocs
} from '@appTypes/models'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@ui/alert-dialog'
import { Badge } from '@ui/badge'
import { Button } from '@ui/button'
import { Card } from '@ui/card'
import { Input } from '@ui/input'
import { Progress } from '@ui/progress'
import { ScrollArea } from '@ui/scroll-area'
import { Switch } from '@ui/switch'
import {
  AlertTriangle,
  ArrowLeft,
  Cloud,
  CloudDownload,
  CloudUpload,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Unlock,
  Wrench,
  XCircle
} from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ipcManager } from '~/app/ipc'
import { cn, formatStorageSize } from '~/utils'

type CloudStorageConfig = configLocalDocs['game']['cloudStorage']
type CloudArchiveViewMode = 'overview' | 'settings'

const DEFAULT_CONFIG: CloudStorageConfig = {
  enabled: false,
  cloudRoot: '',
  localRoot: '',
  localLimitBytes: 0,
  archiveFormat: '7z',
  volumeSizeBytes: 2 * 1024 * 1024 * 1024,
  sevenZipPath: '',
  autoImportNewGames: false
}

const SAVE_CONFIG_TIMEOUT_MS = 20_000
const ORPHAN_SCAN_TIMEOUT_MS = 15_000
const INITIALIZE_DATESHEET_TIMEOUT_MS = 20_000
const TASK_START_TIMEOUT_MS = 20_000
const OPEN_PATH_TIMEOUT_MS = 10_000
const LOAD_DATA_TIMEOUT_MS = 15_000

function createCloudUiError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(error), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        window.clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

function gbToBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value * 1024 * 1024 * 1024)
}

function bytesToGB(value: number): string {
  if (!value) return ''
  return String(Number((value / 1024 / 1024 / 1024).toFixed(2)))
}

function formatSpeed(value: number): string {
  if (!value) return '--'
  return `${formatStorageSize(value)}/s`
}

function formatEta(value: number | null): string {
  if (!value || value < 0) return '--'
  const minutes = Math.floor(value / 60)
  const seconds = Math.round(value % 60)
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function isAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function joinRootPath(root: string, child: string): string {
  if (!root) return child
  if (!child) return root
  if (isAbsolutePathLike(child)) return child
  return `${root.replace(/[\\/]+$/, '')}\\${child.replace(/^[\\/]+/, '')}`
}

function statusVariant(
  status: CloudGameStatus
): 'default' | 'outline' | 'secondary' | 'destructive' {
  switch (status) {
    case 'local':
      return 'default'
    case 'cloud':
      return 'outline'
    case 'syncing':
      return 'secondary'
    case 'error':
      return 'destructive'
  }
}

function hasDownloadableArchive(game: CloudGameSummary): boolean {
  return (
    game.status === 'cloud' ||
    (game.status === 'error' && (Boolean(game.archiveDir) || game.archiveParts.length > 0))
  )
}
function datesheetStatusVariant(
  status: CloudDatesheetSideStatus['status']
): 'default' | 'outline' | 'secondary' | 'destructive' {
  if (status === 'ok') return 'default'
  if (status === 'missing' || status === 'recoveredFromBackup') return 'secondary'
  if (status === 'pathEmpty') return 'outline'
  return 'destructive'
}

function parseCloudError(error: unknown): { code: string; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const match = rawMessage.match(/^\[([^\]]+)]\s*(.*)$/)
  return match
    ? { code: match[1], message: match[2] || rawMessage }
    : { code: 'unknown', message: rawMessage }
}
export function CloudArchive(): React.JSX.Element {
  return <CloudArchiveView mode="overview" />
}

export function CloudArchiveSettings(): React.JSX.Element {
  return <CloudArchiveView mode="settings" />
}

function CloudArchiveView({ mode }: { mode: CloudArchiveViewMode }): React.JSX.Element {
  const { t } = useTranslation('cloudArchive')
  const navigate = useNavigate()
  const [config, setConfig] = useState<CloudStorageConfig>(DEFAULT_CONFIG)
  const [form, setForm] = useState<CloudStorageConfig>(DEFAULT_CONFIG)
  const [games, setGames] = useState<CloudGameSummary[]>([])
  const [orphans, setOrphans] = useState<CloudOrphanSummary[]>([])
  const [storageLocation, setStorageLocation] = useState<CloudStorageLocationInfo | null>(null)
  const [tasks, setTasks] = useState<Record<string, CloudTaskProgress>>({})
  const [datesheetStatus, setDatesheetStatus] = useState<CloudDatesheetStatusReport | null>(null)
  const [lockCleanupRole, setLockCleanupRole] = useState<CloudStorageRole | null>(null)
  const [initializeDatesheetOpen, setInitializeDatesheetOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isInitializingDatesheet, setIsInitializingDatesheet] = useState(false)
  const [isOrphansLoading, setIsOrphansLoading] = useState(false)
  const [orphanLoadError, setOrphanLoadError] = useState('')
  const saveRequestIdRef = useRef(0)
  const orphanLoadRequestIdRef = useRef(0)

  const activeTasks = useMemo(
    () =>
      Object.values(tasks).filter((task) => task.phase !== 'completed' && task.phase !== 'error'),
    [tasks]
  )

  const sortedTasks = useMemo(
    () =>
      Object.values(tasks).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ),
    [tasks]
  )

  const stats = useMemo(() => {
    return games.reduce(
      (acc, game) => {
        acc.total += 1
        acc[game.status] += 1
        if (game.status === 'local' || game.status === 'syncing')
          acc.localBytes += game.sizeBytes || 0
        return acc
      },
      { total: 0, local: 0, cloud: 0, syncing: 0, error: 0, localBytes: 0 }
    )
  }, [games])
  const initializeDatesheetHasContent = Boolean(
    datesheetStatus?.local.hasRootContent || datesheetStatus?.cloud.hasRootContent
  )
  const datesheetsPaired = Boolean(
    datesheetStatus?.local.status === 'ok' &&
      datesheetStatus.cloud.status === 'ok' &&
      datesheetStatus.pairMatched
  )
  const datesheetRootsChanged =
    form.localRoot !== config.localRoot || form.cloudRoot !== config.cloudRoot
  const canInitializeDatesheets = Boolean(
    form.localRoot && form.cloudRoot && (!datesheetsPaired || datesheetRootsChanged)
  )
  const datesheetReady = Boolean(config.enabled && datesheetsPaired)

  const formatCloudError = useCallback(
    (error: unknown): string => {
      const { code, message } = parseCloudError(error)
      return t(`errors.${code}`, { message, defaultValue: message })
    },
    [t]
  )

  const loadOrphans = useCallback(async (): Promise<void> => {
    const requestId = ++orphanLoadRequestIdRef.current
    setIsOrphansLoading(true)
    setOrphanLoadError('')
    try {
      const nextOrphans = await withTimeout(
        ipcManager.invoke('cloud:get-orphans'),
        ORPHAN_SCAN_TIMEOUT_MS,
        createCloudUiError('operationTimeout', 'Cloud orphan scan timed out')
      )
      if (requestId === orphanLoadRequestIdRef.current) setOrphans(nextOrphans)
    } catch (error) {
      if (requestId === orphanLoadRequestIdRef.current) {
        setOrphanLoadError(formatCloudError(error))
      }
    } finally {
      if (requestId === orphanLoadRequestIdRef.current) setIsOrphansLoading(false)
    }
  }, [formatCloudError])

  const loadData = useCallback(async (): Promise<void> => {
    const [nextConfig, nextGames, nextTasks, nextDatesheetStatus, nextStorageLocation] =
      await Promise.all([
        withTimeout(
          ipcManager.invoke('cloud:get-config'),
          LOAD_DATA_TIMEOUT_MS,
          createCloudUiError('operationTimeout', 'Loading cloud config timed out')
        ),
        withTimeout(
          ipcManager.invoke('cloud:get-games'),
          LOAD_DATA_TIMEOUT_MS,
          createCloudUiError('operationTimeout', 'Loading cloud games timed out')
        ),
        withTimeout(
          ipcManager.invoke('cloud:get-task-progress'),
          LOAD_DATA_TIMEOUT_MS,
          createCloudUiError('operationTimeout', 'Loading cloud tasks timed out')
        ),
        withTimeout(
          ipcManager.invoke('cloud:get-datesheet-status'),
          LOAD_DATA_TIMEOUT_MS,
          createCloudUiError('operationTimeout', 'Loading datesheet status timed out')
        ),
        withTimeout(
          ipcManager.invoke('cloud:get-storage-location'),
          LOAD_DATA_TIMEOUT_MS,
          createCloudUiError('operationTimeout', 'Loading cloud storage location timed out')
        )
      ])
    setConfig(nextConfig)
    setForm(nextConfig)
    setGames(nextGames)
    setTasks(Object.fromEntries(nextTasks.map((task) => [task.taskId, task] as const)))
    setDatesheetStatus(nextDatesheetStatus)
    setStorageLocation(nextStorageLocation)
    void loadOrphans()
  }, [loadOrphans])

  useEffect(() => {
    void loadData()
      .catch((error) =>
        toast.error(t('notifications.loadFailed', { message: formatCloudError(error) }))
      )
      .finally(() => setIsLoading(false))
  }, [formatCloudError, loadData, t])

  useEffect(() => {
    const upsertTask = (_event: unknown, task: CloudTaskProgress): void => {
      setTasks((current) => ({ ...current, [task.taskId]: task }))
    }
    const completeTask = (_event: unknown, task: CloudTaskProgress): void => {
      setTasks((current) => ({ ...current, [task.taskId]: task }))
      void loadData().catch(() => {})
    }
    const failTask = (_event: unknown, task: CloudTaskProgress): void => {
      setTasks((current) => ({ ...current, [task.taskId]: task }))
      void loadData().catch(() => {})
    }

    const offProgress = ipcManager.on('cloud:task-progress', upsertTask)
    const offCompleted = ipcManager.on('cloud:task-completed', completeTask)
    const offFailed = ipcManager.on('cloud:task-failed', failTask)
    return () => {
      offProgress()
      offCompleted()
      offFailed()
    }
  }, [loadData])
  const refreshDatesheetStatus = async (): Promise<void> => {
    const nextStatus = await ipcManager.invoke('cloud:get-datesheet-status')
    setDatesheetStatus(nextStatus)
  }

  const restoreDatesheetBackup = async (role: CloudStorageRole): Promise<void> => {
    toast.promise(
      ipcManager.invoke('cloud:restore-datesheet-backup', role).then((nextStatus) => {
        setDatesheetStatus(nextStatus)
      }),
      {
        loading: t('notifications.restoringDatesheet'),
        success: t('notifications.restoreDatesheetSuccess'),
        error: (error) =>
          t('notifications.restoreDatesheetFailed', { message: formatCloudError(error) })
      }
    )
  }

  const cleanupLock = async (role: CloudStorageRole): Promise<void> => {
    toast.promise(
      ipcManager.invoke('cloud:cleanup-datesheet-lock', role).then((nextStatus) => {
        setDatesheetStatus(nextStatus)
        setLockCleanupRole(null)
      }),
      {
        loading: t('notifications.cleaningLock'),
        success: t('notifications.cleanLockSuccess'),
        error: (error) => t('notifications.cleanLockFailed', { message: formatCloudError(error) })
      }
    )
  }
  const selectPath = async (field: 'cloudRoot' | 'localRoot' | 'sevenZipPath'): Promise<void> => {
    const selected = await ipcManager.invoke(
      'system:select-path-dialog',
      [field === 'sevenZipPath' ? 'openFile' : 'openDirectory'],
      undefined,
      form[field]
    )
    if (selected) setForm((current) => ({ ...current, [field]: selected }))
  }

  const saveConfig = async (): Promise<void> => {
    const requestId = ++saveRequestIdRef.current
    setIsSaving(true)
    try {
      const nextConfig = await withTimeout(
        ipcManager.invoke('cloud:update-config', form),
        SAVE_CONFIG_TIMEOUT_MS,
        createCloudUiError('operationTimeout', 'Cloud archive configuration save timed out')
      )
      if (requestId !== saveRequestIdRef.current) return
      setConfig(nextConfig)
      setForm(nextConfig)
      toast.success(t('notifications.saveSuccess'))
      void loadData().catch(() => {})
    } catch (error) {
      if (requestId !== saveRequestIdRef.current) return
      toast.error(t('notifications.saveFailed', { message: formatCloudError(error) }))
    } finally {
      if (requestId === saveRequestIdRef.current) setIsSaving(false)
    }
  }

  const initializeDatesheets = async (): Promise<void> => {
    setIsInitializingDatesheet(true)
    try {
      const nextStatus = await withTimeout(
        ipcManager.invoke('cloud:initialize-datesheets', form),
        INITIALIZE_DATESHEET_TIMEOUT_MS,
        createCloudUiError('operationTimeout', 'Cloud archive datesheet initialization timed out')
      )
      setDatesheetStatus(nextStatus)
      setInitializeDatesheetOpen(false)
      toast.success(t('notifications.initializeDatesheetSuccess'))
      void loadData().catch(() => {})
    } catch (error) {
      toast.error(t('notifications.initializeDatesheetFailed', { message: formatCloudError(error) }))
    } finally {
      setIsInitializingDatesheet(false)
    }
  }

  const startTask = async (label: string, invoke: () => Promise<unknown>): Promise<void> => {
    if (!config.enabled) {
      toast.error(t('errors.notEnabled'))
      return
    }
    if (!datesheetsPaired) {
      if (canInitializeDatesheets) setInitializeDatesheetOpen(true)
      toast.error(t('notifications.initializeRequired'))
      return
    }
    toast.promise(
      withTimeout(
        invoke(),
        TASK_START_TIMEOUT_MS,
        createCloudUiError('operationTimeout', 'Cloud archive task start timed out')
      ).then(() => {
        void loadData().catch(() => {})
      }),
      {
        loading: t('notifications.taskStarting', { label }),
        success: t('notifications.taskStarted', { label }),
        error: (error) => t('notifications.taskFailed', { label, message: formatCloudError(error) })
      }
    )
  }


  const switchToPortableMode = async (): Promise<void> => {
    if (storageLocation?.isPortableMode) return
    const needsAdmin = await ipcManager.invoke('system:check-if-portable-directory-needs-admin-rights')
    if (needsAdmin) {
      toast.error(t('notifications.portableAdminRequired'))
      return
    }
    toast.promise(
      (async () => {
        await ipcManager.invoke('app:switch-database-mode')
        void loadData().catch(() => {})
        toast.info(t('notifications.restartCountdown'))
        setTimeout(() => {
          ipcManager.send('app:relaunch-app')
        }, 3000)
      })(),
      {
        loading: t('notifications.switchingPortable'),
        success: t('notifications.switchPortableSuccess'),
        error: (error) => t('notifications.switchPortableFailed', { message: formatCloudError(error) })
      }
    )
  }

  const restoreOrphan = async (orphan: CloudOrphanSummary): Promise<void> => {
    toast.promise(
      ipcManager.invoke('cloud:restore-local-orphan', orphan.gameId).then(() => {
        void loadData().catch(() => {})
      }),
      {
        loading: t('notifications.restoringOrphan', { name: orphan.gameName }),
        success: t('notifications.restoreOrphanSuccess', { name: orphan.gameName }),
        error: (error) => t('notifications.restoreOrphanFailed', { message: formatCloudError(error) })
      }
    )
  }

  const archiveOrphan = async (orphan: CloudOrphanSummary): Promise<void> => {
    await startTask(t('actions.archiveOrphan'), () =>
      ipcManager.invoke('cloud:archive-local-orphan', orphan.gameId)
    )
  }

  const getOrphanLocalPath = (orphan: CloudOrphanSummary): string => {
    return orphan.localPath ? joinRootPath(config.localRoot, orphan.localPath) : ''
  }

  const getOrphanArchivePath = (orphan: CloudOrphanSummary): string => {
    return orphan.archiveDir ? joinRootPath(config.cloudRoot, orphan.archiveDir) : ''
  }

  const openPath = async (target: string): Promise<void> => {
    if (!target) return
    try {
      const [exists] = await withTimeout(
        ipcManager.invoke('system:check-if-path-exist', [target]),
        OPEN_PATH_TIMEOUT_MS,
        createCloudUiError('operationTimeout', 'Check path timed out')
      )
      if (!exists) {
        toast.error(t('notifications.openPathFailed', { message: target }))
        return
      }
      await withTimeout(
        ipcManager.invoke('system:open-path-in-explorer', target),
        OPEN_PATH_TIMEOUT_MS,
        createCloudUiError('operationTimeout', 'Open path timed out')
      )
    } catch (error) {
      toast.error(t('notifications.openPathFailed', { message: formatCloudError(error) }))
    }
  }

  const openArchive = async (game: CloudGameSummary): Promise<void> => {
    const target = game.archiveDir
      ? joinRootPath(config.cloudRoot, game.archiveDir)
      : joinRootPath(config.cloudRoot, game.gameId)
    await openPath(target)
  }

  const renderConfigPath = (
    field: 'cloudRoot' | 'localRoot' | 'sevenZipPath',
    label: string
  ): React.ReactNode => (
    <label className="grid gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex gap-2">
        <Input
          value={form[field]}
          onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
        />
        <Button variant="outline" size="icon" onClick={() => void selectPath(field)}>
          <FolderOpen className="w-4 h-4" />
        </Button>
      </div>
    </label>
  )

  const renderConfigSummary = (): React.ReactNode => (
    <Card className="p-4 rounded-lg">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('config.summaryTitle')}</div>
          <div className="text-xs text-muted-foreground truncate">
            {t('config.summaryDescription')}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void navigate({ to: '/cloud/settings' })}
        >
          <Settings className="w-4 h-4" />
          {t('actions.settings')}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 text-sm lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">{t('config.cloudRoot')}</div>
          <div className="truncate">{config.cloudRoot || t('config.notSet')}</div>
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">{t('config.localRoot')}</div>
          <div className="truncate">{config.localRoot || t('config.notSet')}</div>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">{t('config.localLimitShort')}</div>
          <div>
            {config.localLimitBytes
              ? formatStorageSize(config.localLimitBytes)
              : t('config.unlimited')}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">{t('config.volumeSizeShort')}</div>
          <div>{formatStorageSize(config.volumeSizeBytes)}</div>
        </div>
      </div>
    </Card>
  )

  const renderStorageLocation = (): React.ReactNode => (
    <Card className="p-4 rounded-lg">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('storage.title')}</div>
          <div className="text-xs text-muted-foreground truncate">{t('storage.description')}</div>
        </div>
        <Badge variant={storageLocation?.isPortableMode ? 'default' : 'secondary'}>
          {storageLocation?.isPortableMode ? t('storage.portable') : t('storage.normal')}
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-3 text-sm lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">{t('storage.configPath')}</div>
          <div className="truncate" title={storageLocation?.configPath}>
            {storageLocation?.configPath || '--'}
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">{t('storage.databaseRoot')}</div>
          <div className="truncate" title={storageLocation?.databaseRoot}>
            {storageLocation?.databaseRoot || '--'}
          </div>
        </div>
        <div className="min-w-0 lg:col-span-2">
          <div className="mb-1 text-xs text-muted-foreground">{t('storage.appRoot')}</div>
          <div className="truncate" title={storageLocation?.appRootPath}>
            {storageLocation?.appRootPath || '--'}
          </div>
        </div>
      </div>
      {!storageLocation?.isPortableMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 mt-4 rounded-lg bg-amber-500/10 text-amber-600">
          <div className="text-xs">{t('storage.notPortableWarning')}</div>
          <Button variant="outline" size="sm" onClick={() => void switchToPortableMode()}>
            {t('actions.switchToPortable')}
          </Button>
        </div>
      )}
    </Card>
  )
  const canAutoImportNewGames = form.enabled && Boolean(form.cloudRoot && form.localRoot)

  const renderConfigEditor = (): React.ReactNode => (
    <Card className="p-4 rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium">{t('config.title')}</div>
        <div className="flex items-center gap-2 text-sm">
          <span>{t('config.enabled')}</span>
          <Switch
            checked={form.enabled}
            onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: checked }))}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {renderConfigPath('cloudRoot', t('config.cloudRoot'))}
        {renderConfigPath('localRoot', t('config.localRoot'))}
        <label className="grid gap-2">
          <span className="text-sm font-medium">{t('config.localLimit')}</span>
          <Input
            type="number"
            min={0}
            value={bytesToGB(form.localLimitBytes)}
            placeholder="0"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                localLimitBytes: gbToBytes(Number(event.target.value))
              }))
            }
          />
        </label>
        <label className="grid gap-2">
          <span className="text-sm font-medium">{t('config.volumeSize')}</span>
          <Input
            type="number"
            min={0.1}
            value={bytesToGB(form.volumeSizeBytes)}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                volumeSizeBytes: gbToBytes(Number(event.target.value))
              }))
            }
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setForm((current) => ({ ...current, volumeSizeBytes: gbToBytes(2) }))}
            >
              2GB
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setForm((current) => ({ ...current, volumeSizeBytes: gbToBytes(4) }))}
            >
              4GB
            </Button>
          </div>
        </label>
        <div className="lg:col-span-2">
          {renderConfigPath('sevenZipPath', t('config.sevenZipPath'))}
        </div>
        <div className="flex items-start justify-between gap-4 p-3 rounded-lg bg-muted/30 lg:col-span-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('config.autoImportNewGames')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t('config.autoImportNewGamesDescription')}
            </div>
          </div>
          <Switch
            checked={form.autoImportNewGames && canAutoImportNewGames}
            disabled={!canAutoImportNewGames}
            onCheckedChange={(checked) =>
              setForm((current) => ({ ...current, autoImportNewGames: checked }))
            }
          />
        </div>
      </div>
      <div className="flex justify-end mt-4">
        <Button onClick={() => void saveConfig()} disabled={isSaving}>
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {t('actions.save')}
        </Button>
      </div>
    </Card>
  )

  const renderDatesheetSide = (side: CloudDatesheetSideStatus): React.ReactNode => (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="text-sm font-medium">{t(`datesheet.roles.${side.role}`)}</span>
          <Badge variant={datesheetStatusVariant(side.status)}>
            {t(`datesheet.status.${side.status}`)}
          </Badge>
          {side.recoveredFromBackup && (
            <Badge variant="secondary">{t('datesheet.recoveredFromBackup')}</Badge>
          )}
          {side.lock.exists && (
            <Badge variant={side.lock.expired ? 'destructive' : 'secondary'}>
              {side.lock.expired ? t('datesheet.lockExpired') : t('datesheet.lockBusy')}
            </Badge>
          )}
        </div>
        <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground lg:grid-cols-2">
          <div className="truncate">
            {t('datesheet.root')}: {side.root || t('config.notSet')}
          </div>
          <div>
            {t('datesheet.pairId')}: {side.pairIdShort || '--'}
          </div>
          <div>
            {t('datesheet.gameCount')}: {side.gameCount}
          </div>
          <div>
            {t('datesheet.updatedAt')}: {side.updatedAt || '--'}
          </div>
        </div>
        {side.error && <div className="mt-2 text-xs text-destructive truncate">{side.error}</div>}
        {side.status === 'missing' && side.hasRootContent && (
          <div className="mt-2 text-xs text-amber-500">{t('datesheet.nonEmptyMissing')}</div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void restoreDatesheetBackup(side.role)}
          disabled={!side.canRestoreFromBackup}
        >
          <Wrench className="w-4 h-4" />
          {t('actions.restoreBackup')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLockCleanupRole(side.role)}
          disabled={!side.lock.expired}
        >
          <Unlock className="w-4 h-4" />
          {t('actions.cleanupLock')}
        </Button>
      </div>
    </div>
  )

  const renderDatesheetStatus = (): React.ReactNode => (
    <Card className="p-0 rounded-lg gap-0">
      <div className="flex items-center justify-between p-4 border-b bg-muted/[calc(var(--glass-opacity)/2)] rounded-t-lg">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="w-4 h-4" />
          {t('datesheet.title')}
        </div>
        <div className="flex flex-wrap gap-2">
          {canInitializeDatesheets && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInitializeDatesheetOpen(true)}
              disabled={isSaving || isInitializingDatesheet}
            >
              {isInitializingDatesheet ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wrench className="w-4 h-4" />
              )}
              {t('actions.initializeDatesheet')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void refreshDatesheetStatus()}>
            <RefreshCw className="w-4 h-4" />
            {t('actions.recheck')}
          </Button>
        </div>
      </div>
      {datesheetStatus ? (
        <div className="divide-y">
          {renderDatesheetSide(datesheetStatus.local)}
          {renderDatesheetSide(datesheetStatus.cloud)}
        </div>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">{t('datesheet.empty')}</div>
      )}
    </Card>
  )
  const renderTaskList = (): React.ReactNode => (
    <Card className="p-0 rounded-lg gap-0">
      <div className="flex items-center justify-between p-4 border-b bg-muted/[calc(var(--glass-opacity)/2)] rounded-t-lg">
        <div className="text-sm font-medium">{t('tasks.title')}</div>
        <Badge variant="outline">{t('tasks.running', { count: activeTasks.length })}</Badge>
      </div>
      <div className="divide-y">
        {sortedTasks.length > 0 ? (
          sortedTasks.map((task) => (
            <div key={task.taskId} className="p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{task.gameName}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {t(`phases.${task.phase}`)} - {task.message}
                  </div>
                </div>
                {task.phase !== 'completed' && task.phase !== 'error' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void ipcManager.invoke('cloud:cancel-task', { taskId: task.taskId })
                    }
                  >
                    <XCircle className="w-4 h-4" />
                    {t('actions.cancel')}
                  </Button>
                )}
              </div>
              <Progress value={task.percent} className="mb-2" />
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span>{Math.round(task.percent)}%</span>
                <span>
                  {formatStorageSize(task.processedBytes)} / {formatStorageSize(task.totalBytes)}
                </span>
                <span>{formatSpeed(task.speedBytesPerSecond)}</span>
                <span>{formatEta(task.etaSeconds)}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center p-10 text-muted-foreground">
            <Cloud className="w-14 h-14 mb-3 opacity-20" />
            <p className="text-sm">{t('tasks.empty')}</p>
          </div>
        )}
      </div>
    </Card>
  )

  const renderOrphanList = (): React.ReactNode => (
    <Card className="p-0 rounded-lg gap-0">
      <div className="flex items-center justify-between p-4 border-b bg-muted/[calc(var(--glass-opacity)/2)] rounded-t-lg">
        <div className="text-sm font-medium">{t('orphans.title')}</div>
        <div className="flex items-center gap-2">
          {isOrphansLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          <Badge variant={orphans.length > 0 ? 'secondary' : 'outline'}>
            {t('orphans.count', { count: orphans.length })}
          </Badge>
        </div>
      </div>
      <div className="divide-y">
        {orphanLoadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-muted-foreground">
            <div className="flex items-center min-w-0 gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <span className="truncate">{t('orphans.loadFailed', { message: orphanLoadError })}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadOrphans()}>
              <RefreshCw className="w-4 h-4" />
              {t('actions.recheck')}
            </Button>
          </div>
        ) : isOrphansLoading && orphans.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-10 text-muted-foreground">
            <Loader2 className="w-10 h-10 mb-3 animate-spin opacity-40" />
            <p className="text-sm">{t('orphans.loading')}</p>
          </div>
        ) : orphans.length > 0 ? (
          orphans.map((orphan) => (
            <div key={`${orphan.kind}-${orphan.gameId}`} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center min-w-0 gap-3">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-medium truncate">{orphan.gameName}</div>
                    <Badge variant={orphan.kind === 'dbMissingFiles' ? 'destructive' : 'secondary'}>
                      {t(`orphans.kind.${orphan.kind}`)}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{orphan.reason}</div>
                  <div className="text-xs text-muted-foreground truncate" title={getOrphanLocalPath(orphan)}>
                    {t('config.localRoot')}: {getOrphanLocalPath(orphan) || '--'}
                  </div>
                  <div className="text-xs text-muted-foreground truncate" title={getOrphanArchivePath(orphan)}>
                    {t('config.cloudRoot')}: {getOrphanArchivePath(orphan) || '--'}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {orphan.sizeBytes > 0 ? formatStorageSize(orphan.sizeBytes) : t('orphans.sizeUnknown')}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openPath(getOrphanLocalPath(orphan))}
                  disabled={!orphan.hasLocalDir}
                >
                  <FolderOpen className="w-4 h-4" />
                  {t('actions.openLocal')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openPath(getOrphanArchivePath(orphan))}
                  disabled={!orphan.hasCloudDir}
                >
                  <FolderOpen className="w-4 h-4" />
                  {t('actions.openArchive')}
                </Button>
                {orphan.canRestore && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void restoreOrphan(orphan)}
                    disabled={!datesheetReady}
                  >
                    <RefreshCw className="w-4 h-4" />
                    {t('actions.restoreOrphan')}
                  </Button>
                )}
                {orphan.canArchive && (
                  <Button
                    size="sm"
                    onClick={() => void archiveOrphan(orphan)}
                    disabled={!datesheetReady}
                  >
                    <CloudUpload className="w-4 h-4" />
                    {t('actions.archiveOrphan')}
                  </Button>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center p-10 text-muted-foreground">
            <ShieldCheck className="w-14 h-14 mb-3 opacity-20" />
            <p className="text-sm">{t('orphans.empty')}</p>
          </div>
        )}
      </div>
    </Card>
  )
  const renderGameList = (): React.ReactNode => (
    <Card className="flex flex-col flex-grow rounded-lg p-0 gap-0">
      <div className="flex items-center justify-between p-4 border-b bg-muted/[calc(var(--glass-opacity)/2)] rounded-t-lg">
        <div className="text-sm font-medium">{t('games.title')}</div>
        <Badge variant="outline">{t('metrics.total', { count: games.length })}</Badge>
      </div>
      <div className="divide-y">
        {games.length > 0 ? (
          games.map((game) => (
            <div
              key={game.gameId}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div className="flex items-center min-w-0 gap-3">
                {hasDownloadableArchive(game) ? (
                  <Cloud className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <HardDrive className="w-4 h-4 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{game.gameName}</div>
                  <div className="text-xs text-muted-foreground truncate">{game.gameId}</div>
                  <div
                    className="text-xs text-muted-foreground truncate"
                    title={game.localManagedPath}
                  >
                    {t('config.localRoot')}: {game.localManagedPath || '--'}
                  </div>
                  <div className="text-xs text-muted-foreground truncate" title={game.archiveDir}>
                    {t('config.cloudRoot')}: {game.archiveDir || '--'}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusVariant(game.status)}>{t(`gameStatus.${game.status}`)}</Badge>
                <span className="text-xs text-muted-foreground">
                  {formatStorageSize(game.sizeBytes || 0)}
                </span>
                {game.lastError && (
                  <Badge variant="destructive" title={game.lastError}>
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {t('gameStatus.error')}
                  </Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openArchive(game)}
                  disabled={!config.cloudRoot}
                >
                  <FolderOpen className="w-4 h-4" />
                  {t('actions.openArchive')}
                </Button>
                {hasDownloadableArchive(game) ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      void startTask(
                        t('actions.download'),
                        () => ipcManager.invoke('cloud:download-game-to-local', game.gameId)
                      )
                    }
                    disabled={!datesheetReady}
                  >
                    <CloudDownload className="w-4 h-4" />
                    {t('actions.download')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void startTask(
                        t('actions.migrate'),
                        () => ipcManager.invoke('cloud:migrate-game-to-cloud', game.gameId)
                      )
                    }
                    disabled={!datesheetReady || game.status === 'syncing'}
                  >
                    <CloudUpload className="w-4 h-4" />
                    {t('actions.migrate')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void startTask(
                      t('actions.rebuild'),
                      () => ipcManager.invoke('cloud:rebuild-archive', game.gameId)
                    )
                  }
                  disabled={!datesheetReady || hasDownloadableArchive(game) || game.status === 'syncing'}
                >
                  <RefreshCw className="w-4 h-4" />
                  {t('actions.rebuild')}
                </Button>
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
            <Cloud className="w-16 h-16 mb-4 opacity-20" />
            <p className="mb-2 text-lg">{t('games.empty.title')}</p>
            <p className="text-sm text-center text-muted-foreground">
              {t('games.empty.description')}
            </p>
          </div>
        )}
      </div>
    </Card>
  )

  const isSettings = mode === 'settings'
  const localUsageRatio = config.localLimitBytes > 0 ? stats.localBytes / config.localLimitBytes : 0
  const localUsageVariant =
    localUsageRatio >= 1 ? 'destructive' : localUsageRatio >= 0.9 ? 'secondary' : 'outline'

  return (
    <>
      <AlertDialog open={initializeDatesheetOpen} onOpenChange={setInitializeDatesheetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('datesheet.initializeConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {initializeDatesheetHasContent
                ? t('datesheet.initializeNonEmptyConfirmDescription')
                : t('datesheet.initializeConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void initializeDatesheets()}
              disabled={isInitializingDatesheet}
            >
              {isInitializingDatesheet && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(lockCleanupRole)}
        onOpenChange={(open) => !open && setLockCleanupRole(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('datesheet.cleanupConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('datesheet.cleanupConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => lockCleanupRole && void cleanupLock(lockCleanupRole)}>
              {t('actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="flex flex-col w-full h-full bg-transparent">
        <ScrollArea className="w-full h-full">
          <div className="pt-[34px] px-6 pb-6">
            <div className="flex items-center justify-between mb-4">
              <div className="min-w-0">
                <h2 className="text-2xl font-bold">
                  {isSettings ? t('settingsTitle') : t('title')}
                </h2>
                {isSettings && (
                  <div className="mt-1 text-sm text-muted-foreground">
                    {t('config.settingsDescription')}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                {isSettings ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void navigate({ to: '/cloud' })}
                    >
                      <ArrowLeft className="w-4 h-4" />
                      {t('actions.back')}
                    </Button>
                    <Button size="sm" onClick={() => void saveConfig()} disabled={isSaving}>
                      {isSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      {t('actions.save')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadData()}
                      disabled={isLoading}
                    >
                      <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
                      {t('actions.refresh')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void navigate({ to: '/cloud/settings' })}
                    >
                      <Settings className="w-4 h-4" />
                      {t('actions.settings')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        void startTask(
                          t('actions.importExisting'),
                          () => ipcManager.invoke('cloud:import-existing-games')
                        )
                      }
                      disabled={!datesheetReady}
                    >
                      <CloudUpload className="w-4 h-4" />
                      {t('actions.importExisting')}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <Card className="p-4 rounded-lg">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant={config.enabled ? 'default' : 'outline'} className="h-6">
                    <Cloud className="w-3.5 h-3.5" />
                    {config.enabled ? t('status.enabled') : t('status.disabled')}
                  </Badge>
                  <Badge variant="outline">{t('metrics.total', { count: stats.total })}</Badge>
                  <Badge variant="default">{t('metrics.local', { count: stats.local })}</Badge>
                  <Badge variant="outline">{t('metrics.cloud', { count: stats.cloud })}</Badge>
                  <Badge variant="secondary">
                    {t('metrics.syncing', { count: stats.syncing })}
                  </Badge>
                  <Badge variant="destructive">{t('metrics.error', { count: stats.error })}</Badge>
                  <Badge variant={orphans.length > 0 ? 'secondary' : 'outline'}>
                    {t('metrics.orphans', { count: orphans.length })}
                  </Badge>
                  <Badge variant={localUsageVariant}>
                    <HardDrive className="w-3.5 h-3.5" />
                    {t('metrics.localBytes', { size: formatStorageSize(stats.localBytes) })}
                  </Badge>
                </div>
              </Card>

              {isSettings ? (
                <>
                  {renderConfigEditor()}
                  {renderStorageLocation()}
                  {renderDatesheetStatus()}
                </>
              ) : (
                <>
                  {renderConfigSummary()}
                  {renderTaskList()}
                  {renderOrphanList()}
                  {renderGameList()}
                </>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    </>
  )
}
