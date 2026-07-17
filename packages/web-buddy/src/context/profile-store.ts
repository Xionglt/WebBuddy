import type { ResumeProfile, ResumeProfileV2 } from '../sdk/resume.js'
import type { ContextItem } from '../task/contracts.js'

/** Compatibility-only input aliases. Generic runtime code imports these from context, never from the recruiting SDK. */
export type LegacyProfileInput = ResumeProfile
export type StructuredProfileInput = ResumeProfileV2

export const PROFILE_SECTIONS = [
  'contact',
  'summary',
  'skills',
  'experience',
  'projects',
  'education',
  'targetRoles',
  'all',
] as const

export type ProfileSection = (typeof PROFILE_SECTIONS)[number]

export interface ProfileQueryResult {
  schemaVersion: 'profile-query-result/v1'
  section: ProfileSection
  query?: string
  data: unknown
  source: 'resume-profile/v2' | 'legacy-resume-profile'
}

export class ProfileStore {
  readonly source: 'resume-profile/v2' | 'legacy-resume-profile'
  private readonly profileV2?: ResumeProfileV2

  constructor(
    profile: ResumeProfile,
    profileV2?: ResumeProfileV2,
  ) {
    this.profileV2 = profileV2 ?? legacyResumeToProfileV2(profile)
    this.source = profileV2 ? 'resume-profile/v2' : 'legacy-resume-profile'
  }

  query(section: ProfileSection, query?: string): ProfileQueryResult {
    return {
      schemaVersion: 'profile-query-result/v1',
      section,
      ...(query ? { query } : {}),
      data: this.section(section),
      source: this.source,
    }
  }

  section(section: ProfileSection): unknown {
    const profile = this.profileV2
    if (!profile) return undefined

    if (section === 'contact') {
      return {
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        location: profile.location,
      }
    }
    if (section === 'summary') {
      return {
        summary: profile.summary,
        seniority: profile.seniority,
      }
    }
    if (section === 'skills') return profile.skills
    if (section === 'experience') return profile.experience
    if (section === 'projects') return profile.projects
    if (section === 'education') return profile.education
    if (section === 'targetRoles') return profile.targetRoles

    return {
      contact: this.section('contact'),
      summary: this.section('summary'),
      skills: profile.skills,
      experience: profile.experience,
      projects: profile.projects,
      education: profile.education,
      targetRoles: profile.targetRoles,
      keywords: profile.keywords,
      source: profile.source,
    }
  }
}

export function profileStoreContextItem(
  profileStore: ProfileStore,
  input: { id?: string; runId: string; sessionId?: string; revision: number; capturedAt?: string },
): ContextItem {
  const capturedAt = input.capturedAt ?? new Date().toISOString()
  return {
    schemaVersion: 'context-item/v1',
    id: input.id ?? 'recruiting-profile',
    kind: 'person_profile',
    content: profileStore.query('all').data as never,
    origin: 'user',
    trust: 'user_authorized',
    instructionAuthority: 'advisory',
    sensitivity: 'personal',
    provenance: {
      capturedAt,
      parentContentIds: [],
      runId: input.runId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
    allowedUses: ['prompt', 'artifact', 'sink'],
    freshness: { validity: 'current', revision: input.revision },
    retention: { scope: 'run', deleteWithSession: true },
    sanitization: {
      policyId: 'recruiting-profile-adapter/v1',
      status: 'unchanged',
      redactedFields: [],
      instructionNeutralized: false,
      transformedFrom: [],
    },
    integrity: { immutable: true, digestVerified: false },
  }
}

export function isProfileSection(value: unknown): value is ProfileSection {
  return typeof value === 'string' && (PROFILE_SECTIONS as readonly string[]).includes(value)
}

function legacyResumeToProfileV2(profile: ResumeProfile): ResumeProfileV2 {
  const targetRoles = [...new Set(profile.experience.map((item) => item.title).filter(Boolean))] as string[]
  return {
    schemaVersion: 'resume-profile/v2',
    name: profile.name ? { value: profile.name, confidence: 0.7, evidence: 'Legacy resume profile.' } : undefined,
    email: profile.email ? { value: profile.email, confidence: 0.9, evidence: 'Legacy resume profile.' } : undefined,
    phone: profile.phone ? { value: profile.phone, confidence: 0.9, evidence: 'Legacy resume profile.' } : undefined,
    location: profile.location ? { value: profile.location, confidence: 0.6, evidence: 'Legacy resume profile.' } : undefined,
    summary: profile.summary ? { value: profile.summary, confidence: 0.5, evidence: 'Legacy resume profile.' } : undefined,
    targetRoles: {
      value: targetRoles,
      confidence: targetRoles.length ? 0.5 : 0.1,
      evidence: 'Inferred from legacy experience titles.',
    },
    skills: {
      value: profile.skills,
      confidence: profile.skills.length ? 0.7 : 0.1,
      evidence: 'Legacy resume profile.',
    },
    projects: {
      value: [],
      confidence: 0.1,
      evidence: 'Legacy resume profile has no project section.',
    },
    experience: {
      value: profile.experience,
      confidence: profile.experience.length ? 0.6 : 0.1,
      evidence: 'Legacy resume profile.',
    },
    education: {
      value: profile.education,
      confidence: profile.education.length ? 0.6 : 0.1,
      evidence: 'Legacy resume profile.',
    },
    keywords: {
      value: profile.keywords,
      confidence: profile.keywords.length ? 0.5 : 0.1,
      evidence: 'Legacy resume profile.',
    },
    source: {
      type: profile.source === 'json' ? 'json' : profile.source === 'txt' ? 'txt' : 'pdf-text',
      extractionWarnings: ['Synthesized ResumeProfileV2 from legacy ResumeProfile for compatibility.'],
      parser: profile.source === 'json' ? 'json' : 'heuristic',
    },
  }
}
