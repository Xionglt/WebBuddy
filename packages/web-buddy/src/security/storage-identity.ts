const MAX_STORAGE_ID_LENGTH = 200

/**
 * Logical run/session ids are also used as filesystem path components by local
 * stores. Keep the logical value unchanged, but reject values that could escape
 * or ambiguously address the configured storage root.
 */
export function isSafeStorageIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_STORAGE_ID_LENGTH
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && !/[\u0000-\u001f\u007f/\\]/.test(value)
}

export function assertSafeStorageIdentity(value: unknown, label: string): asserts value is string {
  if (!isSafeStorageIdentity(value)) {
    throw new Error(
      `UNSAFE_STORAGE_IDENTITY: ${label} must be a canonical single path component of at most ${MAX_STORAGE_ID_LENGTH} characters.`,
    )
  }
}
