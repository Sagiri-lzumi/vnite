import { Paths } from 'type-fest'

export type GameMediaType = 'cover' | 'background' | 'icon' | 'logo' | 'wideCover'

export type CloudGameStatus = 'local' | 'cloud' | 'syncing' | 'error'

export type CloudTaskPhase =
  | 'queued'
  | 'scanning'
  | 'copying'
  | 'verifying'
  | 'writingDatesheet'
  | 'compressing'
  | 'deleting'
  | 'downloading'
  | 'extracting'
  | 'completed'
  | 'error'

export type CloudStorageRole = 'localCache' | 'cloudArchive'

export interface CloudTaskProgress {
  taskId: string
  gameId: string
  gameName: string
  phase: CloudTaskPhase
  percent: number
  processedBytes: number
  totalBytes: number
  speedBytesPerSecond: number
  etaSeconds: number | null
  message: string
  errorCode?: string
  startedAt: string
  updatedAt: string
}

export interface CloudDatesheetGameEntry {
  gameId: string
  gameName: string
  status: CloudGameStatus
  localManagedPath: string
  archiveDir: string
  archiveParts: string[]
  sizeBytes: number
  fileCount: number
  fileNames: string[]
  fileListHash: string
  archiveRevision: string
  localRevision: string
  lastVerifiedAt: string
  lastError: string
}

export interface CloudDatesheet {
  schemaVersion: 1
  pairId: string
  role: CloudStorageRole
  createdAt: string
  updatedAt: string
  lastOperationId: string
  games: Record<string, CloudDatesheetGameEntry>
}


export type CloudDatesheetReadStatus =
  | 'ok'
  | 'missing'
  | 'corrupted'
  | 'unrecoverable'
  | 'recoveredFromBackup'
  | 'schemaUnsupported'
  | 'roleMismatch'
  | 'pairMismatch'
  | 'pathEmpty'
  | 'operationTimeout'
  | 'lockBusy'
  | 'lockTimeout'

export interface CloudDatesheetLockInfo {
  exists: boolean
  expired: boolean
  operationId: string
  pid: number
  createdAt: string
  ageMs: number
  error: string
}

export interface CloudDatesheetSideStatus {
  role: CloudStorageRole
  root: string
  filePath: string
  status: CloudDatesheetReadStatus
  exists: boolean
  recoveredFromBackup: boolean
  pairId: string
  pairIdShort: string
  schemaVersion: number
  gameCount: number
  updatedAt: string
  hasRootContent: boolean
  canRestoreFromBackup: boolean
  lock: CloudDatesheetLockInfo
  error: string
}

export interface CloudDatesheetStatusReport {
  enabled: boolean
  pairMatched: boolean
  canInitialize: boolean
  local: CloudDatesheetSideStatus
  cloud: CloudDatesheetSideStatus
}
export interface CloudGameSummary {
  gameId: string
  gameName: string
  status: CloudGameStatus
  localManagedPath: string
  archiveDir: string
  archiveParts: string[]
  sizeBytes: number
  updatedAt: string
  lastError: string
}

export type CloudOrphanKind = 'localOnly' | 'cloudOnly' | 'datesheetOnly' | 'dbMissingFiles'

export interface CloudOrphanSummary {
  gameId: string
  gameName: string
  kind: CloudOrphanKind
  localPath: string
  archiveDir: string
  sizeBytes: number
  hasDbGame: boolean
  hasLocalDir: boolean
  hasCloudDir: boolean
  hasLocalDatesheetEntry: boolean
  hasCloudDatesheetEntry: boolean
  canRestore: boolean
  canArchive: boolean
  reason: string
}

export interface CloudStorageLocationInfo {
  configPath: string
  databaseRoot: string
  appRootPath: string
  isPortableMode: boolean
}

export type gameDocs = {
  [gameId: string]: gameDoc
}

export interface gameDoc {
  _id: string
  metadata: {
    name: string
    originalName: string
    sortName: string
    releaseDate: string
    description: string
    developers: string[]
    publishers: string[]
    platforms: string[]
    genres: string[]
    tags: string[]
    relatedSites: {
      label: string
      url: string
    }[]
    steamId: string
    vndbId: string
    igdbId: string
    ymgalId: string
    extra: {
      key: string
      value: string[]
    }[]
  }
  record: {
    addDate: string
    lastRunDate: string
    score: number
    playTime: number
    playStatus: 'unplayed' | 'playing' | 'partial' | 'finished' | 'multiple' | 'shelved'
    hideFromRecentGames: boolean
    timers: {
      start: string
      end: string
    }[]
    dailyPlayTimes: {
      date: string
      playTime: number
    }[]
    storageSize: number
  }
  save: {
    saveList: {
      [saveId: string]: {
        _id: string
        date: string
        note: string
        locked: boolean
      }
    }
    maxBackups: number
    autoRestoreSave: boolean
  }
  memory: {
    memoryList: {
      [memoryId: string]: {
        _id: string
        date: string
        note: string
      }
    }
  }
  apperance: {
    logo: {
      position: {
        x: number
        y: number
      }
      size: number
      visible: boolean
    }
    nsfw: boolean
  }
}

export interface gameCollectionDocs {
  [gameCollectionId: string]: gameCollectionDoc
}

export interface gameCollectionDoc {
  _id: string
  name: string
  sort: number
  sortBy:
    | 'metadata.name'
    | 'metadata.sortName'
    | 'metadata.releaseDate'
    | 'record.lastRunDate'
    | 'record.addDate'
    | 'record.playTime'
    | 'record.storageSize'
    | 'custom'
  sortOrder: 'asc' | 'desc'
  games: string[]
}

export interface gameLocalDocs {
  [gameId: string]: gameLocalDoc
}

export interface gameLocalDoc {
  _id: string
  path: {
    gamePath: string
    savePaths: string[]
    screenshotPath?: string
  }
  launcher: {
    mode: 'file' | 'url' | 'script'
    fileConfig: {
      path: string
      args: string[]
      monitorMode: 'file' | 'folder' | 'process'
      monitorPath: string
    }
    urlConfig: {
      url: string
      browserPath: string
      monitorMode: 'file' | 'folder' | 'process'
      monitorPath: string
    }
    scriptConfig: {
      workingDirectory: string
      command: string[]
      monitorMode: 'file' | 'folder' | 'process'
      monitorPath: string
    }
    useMagpie: boolean
  }
  utils: {
    markPath: string
    rootPath: string
  }
  cloud: {
    status: CloudGameStatus
    archiveDir: string
    archiveParts: string[]
    localManagedPath: string
    originalImportedPath: string
    sizeBytes: number
    updatedAt: string
    lastError: string
  }
}

export const DEFAULT_GAME_LOCAL_VALUES: Readonly<gameLocalDoc> = {
  _id: '',
  path: {
    gamePath: '',
    savePaths: [],
    screenshotPath: ''
  },
  launcher: {
    mode: 'file',
    fileConfig: {
      path: '',
      args: [],
      monitorMode: 'folder',
      monitorPath: ''
    },
    urlConfig: {
      url: '',
      browserPath: '',
      monitorMode: 'folder',
      monitorPath: ''
    },
    scriptConfig: {
      workingDirectory: '',
      command: [],
      monitorMode: 'folder',
      monitorPath: ''
    },
    useMagpie: false
  },
  utils: {
    markPath: '',
    rootPath: ''
  },
  cloud: {
    status: 'local',
    archiveDir: '',
    archiveParts: [],
    localManagedPath: '',
    originalImportedPath: '',
    sizeBytes: 0,
    updatedAt: '',
    lastError: ''
  }
} as const

export const DEFAULT_GAME_COLLECTION_VALUES: Readonly<gameCollectionDoc> = {
  _id: '',
  name: '',
  sort: 0,
  sortBy: 'custom',
  sortOrder: 'asc',
  games: []
} as const

/**
 * Storage size value indicating the size has not been calculated yet
 */
export const STORAGE_SIZE_NOT_CALCULATED = -1

export const DEFAULT_GAME_VALUES: Readonly<gameDoc> = {
  _id: '',
  metadata: {
    name: '',
    originalName: '',
    sortName: '',
    releaseDate: '',
    description: '',
    developers: [] as string[],
    publishers: [] as string[],
    platforms: [] as string[],
    genres: [] as string[],
    tags: [] as string[],
    relatedSites: [] as { label: string; url: string }[],
    steamId: '',
    vndbId: '',
    igdbId: '',
    ymgalId: '',
    extra: [] as { key: string; value: string[] }[]
  },
  record: {
    addDate: '',
    lastRunDate: '',
    score: -1,
    playTime: 0,
    playStatus: 'unplayed',
    hideFromRecentGames: false,
    timers: [],
    dailyPlayTimes: [],
    storageSize: STORAGE_SIZE_NOT_CALCULATED
  },
  save: {
    saveList: {},
    maxBackups: 7,
    autoRestoreSave: false
  },
  memory: {
    memoryList: {}
  },
  apperance: {
    logo: {
      position: {
        x: 1.5,
        y: 35
      },
      size: 100,
      visible: true
    },
    nsfw: false
  }
} as const

export interface SortConfig {
  by: Paths<gameDoc, { bracketNotation: true }>
  order?: 'asc' | 'desc'
}

export interface Timer {
  start: string
  end: string
}

export interface DailyPlayTime {
  date: string
  playTime: number
}

export interface MaxPlayTimeDay {
  date: string
  playTime: number
}

export const DEFAULT_PLAY_STATUS_ORDER: gameDoc['record']['playStatus'][] = [
  'unplayed',
  'playing',
  'partial',
  'finished',
  'multiple',
  'shelved'
]

export const METADATA_EXTRA_PREDEFINED_KEYS = [
  'director',
  'scenario',
  'illustration',
  'music',
  'voice',
  'engine'
]

export interface BatchGameInfo {
  dataId: string
  dataSource: string
  name: string
  id: string
  status: 'idle' | 'loading' | 'success' | 'error' | 'existed'
  dirPath: string
}

export enum TimerStatus {
  Resumed,
  Paused
}

export interface GameTimerStatus {
  name: string
  status: TimerStatus
}
