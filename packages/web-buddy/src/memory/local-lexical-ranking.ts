export interface LocalLexicalCandidate {
  entryId: string
  content: unknown
  confidence: number
}

const DEFAULT_K1 = 1.2
const DEFAULT_B = 0.75
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const LATIN_OR_NUMBER = /[a-z0-9]+(?:[._-][a-z0-9]+)*/g

/**
 * Small-corpus, dependency-free BM25 ranking for local Memory stores.
 * CJK text uses overlapping character bigrams, so Chinese retrieval does not
 * depend on whitespace or an external tokenizer/model.
 */
export function rankLocalLexical(
  query: string,
  candidates: ReadonlyArray<Readonly<LocalLexicalCandidate>>,
): Map<string, number> {
  const queryTerms = [...new Set(tokenizeLocalLexicalText(query))]
  if (queryTerms.length === 0 || candidates.length === 0) return new Map()

  const documents = candidates.map((candidate) => ({
    candidate,
    terms: weightedContentTerms(candidate.content),
  }))
  const averageLength = documents.reduce((sum, document) => sum + document.terms.length, 0)
    / Math.max(1, documents.length)
  const documentFrequency = new Map<string, number>()
  for (const document of documents) {
    for (const term of new Set(document.terms)) {
      if (queryTerms.includes(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
    }
  }

  const scores = new Map<string, number>()
  for (const document of documents) {
    const frequencies = termFrequencies(document.terms)
    let score = 0
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) ?? 0
      if (frequency === 0) continue
      const containingDocuments = documentFrequency.get(term) ?? 0
      const inverseDocumentFrequency = Math.log(
        1 + (candidates.length - containingDocuments + 0.5) / (containingDocuments + 0.5),
      )
      const lengthNormalization = DEFAULT_K1 * (
        1 - DEFAULT_B + DEFAULT_B * document.terms.length / Math.max(1, averageLength)
      )
      score += inverseDocumentFrequency
        * (frequency * (DEFAULT_K1 + 1))
        / (frequency + lengthNormalization)
    }
    if (score > 0) {
      scores.set(document.candidate.entryId, score + boundedConfidence(document.candidate.confidence) * 0.01)
    }
  }
  return scores
}

export function tokenizeLocalLexicalText(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase()
  const output: string[] = []

  for (const match of normalized.matchAll(LATIN_OR_NUMBER)) {
    const token = match[0]
    output.push(`word:${token}`)
    for (const part of token.split(/[._-]+/).filter(Boolean)) {
      if (part !== token) output.push(`word:${part}`)
    }
  }

  for (const match of normalized.matchAll(CJK_RUN)) {
    const characters = Array.from(match[0])
    if (characters.length === 1) {
      output.push(`cjk:${characters[0]}`)
      continue
    }
    output.push(`cjk:${characters.join('')}`)
    for (let index = 0; index < characters.length - 1; index += 1) {
      output.push(`cjk:${characters[index]}${characters[index + 1]}`)
    }
  }
  return output
}

function weightedContentTerms(content: unknown): string[] {
  const values: string[] = []
  collectTextValues(content, values, new Set())
  const terms = values.flatMap(tokenizeLocalLexicalText)
  if (!isRecord(content)) return terms

  // Logical identity is the strongest local signal. Workflow is useful too;
  // site and path remain governance filters rather than fuzzy ranking fields.
  if (typeof content.memoryKey === 'string') {
    const identity = tokenizeLocalLexicalText(content.memoryKey)
    terms.push(...identity, ...identity)
  }
  const applicability = isRecord(content.applicability) ? content.applicability : undefined
  if (applicability && typeof applicability.workflow === 'string') {
    terms.push(...tokenizeLocalLexicalText(applicability.workflow))
  }
  return terms
}

function collectTextValues(value: unknown, output: string[], seen: Set<object>): void {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output, seen)
    return
  }
  for (const item of Object.values(value)) collectTextValues(item, output, seen)
}

function termFrequencies(terms: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
  return frequencies
}

function boundedConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
