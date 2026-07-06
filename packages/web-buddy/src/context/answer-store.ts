export interface UserAnswer {
  field: string
  question: string
  answer: string
  at: string
  source: 'ask_user'
  options?: string[]
}

export class AnswerStore {
  private readonly answers = new Map<string, UserAnswer>()

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
