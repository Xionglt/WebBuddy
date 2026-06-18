import type { ResumeProfile } from './resume.js'

/**
 * A scraped job posting. `requirements`/`tags` are derived from the detail or
 * list page text so the matcher has something to score against.
 */
export interface JobPosting {
  id: string
  title: string
  /** Raw category line from the list card, e.g. "技术-前端". */
  category?: string
  location?: string
  updated?: string
  /** Detail-page URL (position-detail), if known. */
  detailUrl?: string
  /** Direct application form URL, if the site exposes one separately. */
  applicationUrl?: string
  /** Concatenated text used for keyword matching. */
  searchText: string
  /** Tokenized requirement/tag keywords (lower-case). */
  tags: string[]
}

export interface MatchScore {
  job: JobPosting
  /** 0..1 normalized score. */
  score: number
  /** Human-readable reason for the score. */
  reason: string
  /** Skills from the resume that appear in the job text. */
  matchedSkills: string[]
  /** Skills the job asks for but the resume lacks. */
  missingSkills: string[]
}

const STOPWORDS = new Set([
  '的', '与', '和', '及', '或', '并', '在', '为', '是', '等', '岗位', '职位', '要求',
  '描述', '职责', '任职', '资格', '优先', '具备', '熟悉', '了解', '掌握', '使用',
  '相关', '工作', '经验', '年以上', '负责', '参与', '完成', '能够', '可以',
  'the', 'and', 'for', 'with', 'you', 'are', 'will', 'our', 'our', 'this', 'that',
  'a', 'an', 'to', 'of', 'in', 'on', 'is', 'be', 'as', 'at', 'by', 'we',
])

function tokenize(text: string): string[] {
  // Lower-case, split on non-alphanumeric/CJK boundaries, keep CJK runs (>=2 chars)
  // and ascii tokens (>=2 chars), drop stopwords.
  const lower = text.toLowerCase()
  const tokens: string[] = []
  // ASCII words
  const ascii = lower.match(/[a-z][a-z0-9.+#-]{1,}/g) || []
  for (const t of ascii) {
    if (!STOPWORDS.has(t) && t.length >= 2) tokens.push(t.replace(/[.-]+$/, ''))
  }
  // CJK runs (2+ consecutive CJK chars treated as one token)
  const cjk = lower.match(/[一-鿿]{2,}/g) || []
  for (const t of cjk) {
    if (!STOPWORDS.has(t)) tokens.push(t)
  }
  return tokens
}

function normalizeSkill(skill: string): string {
  // Collapse a few aliases so "node"/"nodejs"/"node.js" match as one.
  const s = skill.toLowerCase()
  if (['node', 'nodejs', 'node.js'].includes(s)) return 'node'
  if (s === 'golang') return 'go'
  if (s === 'k8s') return 'kubernetes'
  return s
}

/**
 * Score how well a resume fits a set of jobs. Pure function, deterministic —
 * the baseline matcher that always works. An LLM scorer (optional) can refine
 * ordering later.
 */
export function matchJobs(profile: ResumeProfile, jobs: JobPosting[]): MatchScore[] {
  const resumeSkills = new Set(profile.skills.map(normalizeSkill))
  const resumeKeywords = new Set(
    [...profile.keywords, ...profile.skills].map((k) => normalizeSkill(k.toLowerCase())),
  )

  const results: MatchScore[] = jobs.map((job) => {
    const jobTags = new Set(job.tags.map(normalizeSkill))
    const jobText = ` ${normalizeText(job.searchText)} `

    const matchedSkills = [...resumeSkills].filter((skill) => {
      if (jobTags.has(skill)) return true
      return jobText.includes(` ${skill} `) || jobText.includes(skill)
    })

    const missingSkills = [...jobTags]
      .filter((t) => resumeSkills.has(t) === false)
      // Only surface "missing" for tags that look like concrete skills.
      .filter((t) => /[a-z]/.test(t) || /[一-鿿]/.test(t))
      .slice(0, 8)

    const overlap = matchedSkills.length
    const demand = Math.max(jobTags.size, 1)
    // Coverage = fraction of job demands the resume satisfies; weighted by
    // absolute overlap so a job asking for 2 of 2 skills we have beats one
    // asking for 10 of 10.
    const coverage = overlap / demand
    const score = Math.min(1, coverage * 0.7 + Math.min(overlap, 6) / 6 * 0.3)

    const reason =
      overlap === 0
        ? 'No direct skill overlap detected.'
        : `Matches ${overlap} skill(s): ${matchedSkills.slice(0, 6).join(', ')}` +
          (missingSkills.length ? `; missing ${missingSkills.slice(0, 4).join(', ')}` : '')

    return { job, score, reason, matchedSkills, missingSkills }
  })

  results.sort((a, b) => b.score - a.score || b.matchedSkills.length - a.matchedSkills.length)
  return results
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（(]/g, ' ( ')
    .replace(/[）)]/g, ' ) ')
    .replace(/[，,、；;。:：]/g, ' ')
}

export { tokenize }

// ---------------------------------------------------------------------------
// Optional LLM refinement — only used when a model API key is configured.
// The heuristic `matchJobs` is always the source of truth; the LLM only
// re-ranks the shortlist and contributes a natural-language rationale.
// ---------------------------------------------------------------------------

import type { LlmGateway } from './llm.js'

interface LlmRanking {
  orderedIds?: string[]
  rationale?: Record<string, string>
  bestId?: string
}

/**
 * Re-rank the top shortlisted matches using an LLM and attach rationales.
 * Falls back to the heuristic order on ANY failure — never throws.
 */
export async function refineMatchesWithLlm(
  heuristic: MatchScore[],
  profile: ResumeProfile,
  gateway: LlmGateway,
  shortlistSize = 6,
): Promise<MatchScore[]> {
  if (!gateway.hasKey || heuristic.length === 0) return heuristic
  const shortlist = heuristic.slice(0, shortlistSize)

  const system =
    'You are a technical recruiter. Given a candidate profile and a shortlist of job postings, ' +
    'rank them by fit and write a one-sentence rationale for each. Respond as JSON: ' +
    '{"bestId": string, "orderedIds": string[], "rationale": {id: reason}}.'
  const user = JSON.stringify({
    candidate: {
      skills: profile.skills,
      experience: profile.experience.map((e) => `${e.title || ''} @ ${e.company || ''}`),
      education: profile.education.map((e) => `${e.degree || ''} @ ${e.school || ''}`),
    },
    jobs: shortlist.map((m) => ({
      id: m.job.id,
      title: m.job.title,
      category: m.job.category,
      tags: m.job.tags.slice(0, 12),
      heuristicScore: Number(m.score.toFixed(2)),
    })),
  })

  const ranking = await gateway.generateJson<LlmRanking>(system, user, { timeoutMs: 25000 })
  if (!ranking) return heuristic

  const rationale = ranking.rationale || {}
  const enriched = heuristic.map((m) =>
    rationale[m.job.id]
      ? { ...m, reason: `${m.reason}\nLLM: ${rationale[m.job.id]}` }
      : m,
  )

  const order = ranking.orderedIds
  if (order && order.length > 0) {
    const index = new Map(order.map((id, i) => [id, i]))
    return enriched.sort((a, b) => {
      const ai = index.has(a.job.id) ? index.get(a.job.id)! : Number.MAX_SAFE_INTEGER
      const bi = index.has(b.job.id) ? index.get(b.job.id)! : Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai - bi
      return b.score - a.score
    })
  }
  return enriched
}
