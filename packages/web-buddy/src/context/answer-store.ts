import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface UserAnswer {
  field: string
  question: string
  answer: string
  at: string
  source: 'ask_user'
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
    return answer ? cloneAnswer(answer) : undefined
  }

  put(answer: UserAnswer): void {
    this.answers.set(answerKey(answer.field), cloneAnswer(answer))
  }

  all(): UserAnswer[] {
    return [...this.answers.values()].map(cloneAnswer)
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
  }
}

function isUserAnswer(value: unknown): value is UserAnswer {
  if (!isRecord(value)) return false
  return typeof value.field === 'string' &&
    typeof value.question === 'string' &&
    typeof value.answer === 'string' &&
    typeof value.at === 'string' &&
    value.source === 'ask_user' &&
    (value.options === undefined || (Array.isArray(value.options) && value.options.every((option) => typeof option === 'string')))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
