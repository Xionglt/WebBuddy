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

export const DEFAULT_MATCH_THRESHOLD = 0.45

export interface MatchThresholdDecision {
  threshold: number
  shouldApply: boolean
  best?: MatchScore
  reason: string
}

interface ResumeProfileWithTargets extends ResumeProfile {
  targetRoles?: string[] | { value?: string[] }
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeSkill(value.trim().toLowerCase())).filter(Boolean))]
}

const ROLE_TERMS = [
  'frontend', 'front-end', '前端', 'backend', 'back-end', '后端', 'fullstack', 'full-stack', '全栈',
  'engineer', '工程师', 'developer', '研发', '开发', '算法', 'algorithm', 'ai', 'ml',
  'machine', 'learning', 'data', '数据', 'infra', 'infrastructure', '平台', '测试', 'qa',
  'product', '产品', 'design', '设计', 'security', '安全',
]

function extractTargetRoles(profile: ResumeProfile): string[] {
  const withTargets = profile as ResumeProfileWithTargets
  const explicit = Array.isArray(withTargets.targetRoles)
    ? withTargets.targetRoles
    : Array.isArray(withTargets.targetRoles?.value)
      ? withTargets.targetRoles.value
      : []
  const inferredSource = [
    ...explicit,
    ...profile.keywords,
    profile.summary || '',
    ...profile.experience.map((experience) => experience.title || ''),
  ].join(' ')
  const tokens = tokenize(inferredSource)
  const roleTokens = tokens.filter((token) =>
    ROLE_TERMS.some((role) => token.includes(role) || role.includes(token)),
  )
  return uniqueNormalized([...explicit, ...roleTokens])
}

function textContainsToken(text: string, token: string): boolean {
  if (!token) return false
  const normalized = normalizeText(text)
  const needle = normalizeText(token)
  return normalized.includes(` ${needle} `) || normalized.includes(needle)
}

function matchTokens(tokens: string[], text: string, tagSet: Set<string>): string[] {
  return tokens.filter((token) => tagSet.has(token) || textContainsToken(text, token))
}

function locationFit(profile: ResumeProfile, job: JobPosting): number {
  if (!profile.location || !job.location) return 0
  const candidate = normalizeText(profile.location)
  const location = normalizeText(job.location)
  if (!candidate || !location) return 0
  if (location.includes(candidate) || candidate.includes(location)) return 1
  const candidateTokens = tokenize(candidate)
  const locationTokens = tokenize(location)
  return candidateTokens.some((token) => locationTokens.includes(token)) ? 0.8 : 0
}

/**
 * Fast list-stage ranking. It intentionally uses only title/category/location/
 * tags plus resume skills and target-role signals, so it can rank many jobs
 * before any detail page is opened or any LLM is called.
 */
export function matchJobsCoarse(profile: ResumeProfile, jobs: JobPosting[]): MatchScore[] {
  const resumeSkills = uniqueNormalized(profile.skills)
  const targetRoles = extractTargetRoles(profile)

  const results = jobs.map((job) => {
    const listText = [job.title, job.category, job.location, job.updated, job.searchText, job.tags.join(' ')]
      .filter(Boolean)
      .join(' ')
    const titleText = job.title || ''
    const categoryText = job.category || ''
    const jobTags = new Set(job.tags.map(normalizeSkill))

    const matchedSkills = matchTokens(resumeSkills, listText, jobTags)
    const titleMatches = matchTokens([...targetRoles, ...resumeSkills], titleText, jobTags)
    const roleMatches = matchTokens(targetRoles, listText, jobTags)
    const categoryMatches = matchTokens(targetRoles, categoryText, jobTags)

    const skillScore = resumeSkills.length === 0
      ? 0
      : Math.min(1, matchedSkills.length / Math.min(5, resumeSkills.length))
    const roleScore = targetRoles.length === 0
      ? 0
      : Math.min(1, roleMatches.length / Math.min(3, Math.max(1, targetRoles.length)))
    const titleScore = titleMatches.length > 0 ? Math.min(1, titleMatches.length / 2) : 0
    const categoryScore = categoryMatches.length > 0 ? 1 : 0
    const locScore = locationFit(profile, job)

    const negative =
      /实习|intern/i.test(job.title) && !/(实习|intern|campus|校招)/i.test([...profile.keywords, profile.summary || ''].join(' '))
        ? 0.12
        : 0

    const score = clamp01(
      skillScore * 0.48 +
        roleScore * 0.25 +
        titleScore * 0.12 +
        categoryScore * 0.08 +
        locScore * 0.07 -
        negative,
    )

    const missingSkills = [...jobTags]
      .filter((tag) => !resumeSkills.includes(tag))
      .filter((tag) => /[a-z]/.test(tag) || /[一-鿿]/.test(tag))
      .slice(0, 8)
    const reasons = [
      matchedSkills.length ? `skills ${matchedSkills.slice(0, 5).join(', ')}` : 'no skill overlap',
      roleMatches.length ? `role ${roleMatches.slice(0, 4).join(', ')}` : '',
      locScore > 0 ? `location ${job.location}` : '',
      negative > 0 ? 'internship signal penalized' : '',
    ].filter(Boolean)

    return {
      job,
      score,
      reason: `Coarse: ${reasons.join('; ')}.`,
      matchedSkills,
      missingSkills,
    }
  })

  results.sort((a, b) => b.score - a.score || b.matchedSkills.length - a.matchedSkills.length)
  return results
}

export function decideMatchThreshold(
  matches: MatchScore[],
  threshold = DEFAULT_MATCH_THRESHOLD,
): MatchThresholdDecision {
  const safeThreshold = clamp01(threshold)
  const best = matches[0]
  if (!best) {
    return {
      threshold: safeThreshold,
      shouldApply: false,
      reason: `No candidates available; threshold is ${safeThreshold.toFixed(2)}.`,
    }
  }
  if (best.score < safeThreshold) {
    return {
      threshold: safeThreshold,
      shouldApply: false,
      best,
      reason: `Best score ${best.score.toFixed(2)} is below threshold ${safeThreshold.toFixed(2)}.`,
    }
  }
  return {
    threshold: safeThreshold,
    shouldApply: true,
    best,
    reason: `Best score ${best.score.toFixed(2)} meets threshold ${safeThreshold.toFixed(2)}.`,
  }
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
