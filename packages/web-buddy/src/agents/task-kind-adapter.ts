import type { BackgroundAgentTaskKind } from './async-task-contracts.js'
import { validateAgentRole, type AgentRole } from '../task/contracts.js'

export interface LegacyTaskRoleMapping {
  legacyKind: BackgroundAgentTaskKind
  role: AgentRole
  outputArtifactKind: string
}

const MAPPINGS: Readonly<Record<BackgroundAgentTaskKind, LegacyTaskRoleMapping>> = {
  candidate_job_research: mapping('candidate_job_research', 'researcher', ['artifact.read', 'research.compare'], ['page_snapshot', 'job_listing'], 'research_report'),
  trace_summarization: mapping('trace_summarization', 'summarizer', ['artifact.read', 'trace.summarize'], ['trace'], 'trace_summary'),
  memory_retrieval: mapping('memory_retrieval', 'memory_retriever', ['artifact.read', 'memory.retrieve'], ['context_envelope'], 'memory_search_result'),
  workflow_evaluation: mapping('workflow_evaluation', 'verifier', ['artifact.read', 'workflow.verify'], ['workflow_snapshot', 'evidence'], 'verification_report'),
  delivery_probe: mapping('delivery_probe', 'safety_reviewer', ['artifact.read', 'delivery.review'], ['workflow_snapshot', 'evidence'], 'safety_review'),
}

export function legacyTaskRoleMapping(kind: BackgroundAgentTaskKind): LegacyTaskRoleMapping {
  const value = MAPPINGS[kind]
  validateAgentRole(value.role)
  return {
    legacyKind: value.legacyKind,
    role: { ...value.role, capabilities: [...value.role.capabilities], inputArtifactKinds: [...value.role.inputArtifactKinds] },
    outputArtifactKind: value.outputArtifactKind,
  }
}

export function listLegacyTaskRoleMappings(): LegacyTaskRoleMapping[] {
  return (Object.keys(MAPPINGS) as BackgroundAgentTaskKind[]).map(legacyTaskRoleMapping)
}

function mapping(
  legacyKind: BackgroundAgentTaskKind,
  id: string,
  capabilities: string[],
  inputArtifactKinds: string[],
  outputArtifactKind: string,
): LegacyTaskRoleMapping {
  return {
    legacyKind,
    role: {
      schemaVersion: 'agent-role/v1',
      id,
      version: '1',
      capabilities,
      authority: id === 'safety_reviewer' || id === 'verifier' ? 'recommend_only' : 'read_only',
      inputArtifactKinds,
      outputArtifactKind,
    },
    outputArtifactKind,
  }
}
