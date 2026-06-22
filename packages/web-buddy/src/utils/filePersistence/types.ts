export type TurnStartTime = number

export type PersistedFile = {
  filename: string
  file_id: string
}

export type FailedPersistence = {
  filename: string
  error: string
}

export type FilesPersistedEventData = {
  files: PersistedFile[]
  failed: FailedPersistence[]
}

export const OUTPUTS_SUBDIR = 'outputs'
export const FILE_COUNT_LIMIT = 100
export const DEFAULT_UPLOAD_CONCURRENCY = 4
