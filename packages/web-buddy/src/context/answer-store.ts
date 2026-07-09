import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface UserAnswer {
  field: string
  question: string
  answer: string
  at: string
  source: 'ask_user'
  scope?: 'run' | 'session' | 'project' | 'user'
  expiresAt?: string
  sensitivity?: 'public' | 'internal' | 'personal' | 'secret'
  sensitiveFields?: string[]
  reusable?: boolean
  options?: string[]
}

export interface AnswerStoreSnapshot {
  schemaVersion: 'answer-store/v1'
  updatedAt: string
  answers: UserAnswer[]
}

export class AnswerStore {
  private readonly answers = new Map<string, UserAnswer>()

  constructor(initialAnswers: UserAnswer[] = []) {
    for (const answer of initialAnswers) this.put(answer)
  }

  get(field: string): UserAnswer | undefined {
    const answer = this.answers.get(answerKey(field))
    return answer && isReusableAnswer(answer) ? cloneAnswer(answer) : undefined
  }

  put(answer: UserAnswer): void {
    const classified = classifyUserAnswer(answer)
    if (!classified.reusable || classified.sensitivity === 'secret') {
      this.answers.delete(answerKey(answer.field))
      return
    }
    this.answers.set(answerKey(classified.field), cloneAnswer(classified))
  }

  all(): UserAnswer[] {
    return [...this.answers.values()].filter(isReusableAnswer).map(cloneAnswer)
  }

  snapshot(now = new Date().toISOString()): AnswerStoreSnapshot {
    return {
      schemaVersion: 'answer-store/v1',
      updatedAt: now,
      answers: this.all(),
    }
  }

  async save(filePath: string, now?: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify(this.snapshot(now), null, 2)}\n`, 'utf8')
  }

  static async load(filePath: string): Promise<AnswerStore> {
    try {
      const raw = await readFile(filePath, 'utf8')
      return AnswerStore.fromSnapshot(JSON.parse(raw))
    } catch (error) {
      if (isFileNotFound(error)) return new AnswerStore()
      throw error
    }
  }

  static fromSnapshot(value: unknown): AnswerStore {
    if (!isRecord(value) || value.schemaVersion !== 'answer-store/v1' || !Array.isArray(value.answers)) {
      return new AnswerStore()
    }
    return new AnswerStore(value.answers.filter(isUserAnswer))
  }
}

function answerKey(field: string): string {
  return field.trim().toLowerCase()
}

function cloneAnswer(answer: UserAnswer): UserAnswer {
  return {
    ...answer,
    ...(answer.options ? { options: [...answer.options] } : {}),
    ...(answer.sensitiveFields ? { sensitiveFields: [...answer.sensitiveFields] } : {}),
  }
}

function isUserAnswer(value: unknown): value is UserAnswer {
  if (!isRecord(value)) return false
  return typeof value.field === 'string' &&
    typeof value.question === 'string' &&
    typeof value.answer === 'string' &&
    typeof value.at === 'string' &&
    value.source === 'ask_user' &&
    (value.scope === undefined || value.scope === 'run' || value.scope === 'session' || value.scope === 'project' || value.scope === 'user') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'string') &&
    (value.sensitivity === undefined || value.sensitivity === 'public' || value.sensitivity === 'internal' || value.sensitivity === 'personal' || value.sensitivity === 'secret') &&
    (value.reusable === undefined || typeof value.reusable === 'boolean') &&
    (value.sensitiveFields === undefined || (Array.isArray(value.sensitiveFields) && value.sensitiveFields.every((field) => typeof field === 'string'))) &&
    (value.options === undefined || (Array.isArray(value.options) && value.options.every((option) => typeof option === 'string')))
}

export function classifyUserAnswer(answer: UserAnswer): UserAnswer {
  const sensitiveFields = sensitiveFieldTags(answer)
  const secret = sensitiveFields.length > 0
  return {
    ...answer,
    scope: answer.scope ?? 'session',
    sensitivity: answer.sensitivity ?? (secret ? 'secret' : 'personal'),
    sensitiveFields,
    reusable: answer.reusable ?? !secret,
  }
}

export function isReusableAnswer(answer: UserAnswer): boolean {
  if (answer.reusable === false) return false
  if (answer.sensitivity === 'secret') return false
  if (answer.expiresAt && Date.parse(answer.expiresAt) <= Date.now()) return false
  return sensitiveFieldTags(answer).length === 0
}

function sensitiveFieldTags(answer: Pick<UserAnswer, 'field' | 'question' | 'answer'>): string[] {
  const text = `${answer.field} ${answer.question}`.toLowerCase()
  const value = answer.answer.trim()
  const tags: string[] = []
  if (/captcha|verification\s*code|sms\s*code|otp|验证码|校验码|动态码/.test(text)) tags.push('verification_code')
  if (/password|passcode|pwd|密码/.test(text)) tags.push('password')
  if (/cookie|token|secret|api[-_\s]?key|authorization|auth/.test(text)) tags.push('token')
  if (/身份证|id\s*card|national\s*id|ssn|social security/.test(text) || looksLikeFullIdNumber(value)) tags.push('full_identity_number')
  if (/session|csrf|jwt|bearer/.test(value)) tags.push('token')
  return [...new Set(tags)]
}

function looksLikeFullIdNumber(value: string): boolean {
  const compact = value.replace(/[\s-]/g, '')
  return /^\d{15}$/.test(compact) || /^\d{17}[\dXx]$/.test(compact) || /^\d{3}-?\d{2}-?\d{4}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
