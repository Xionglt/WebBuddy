export {
  CONTENT_ORIGINS,
  CONTENT_SENSITIVITY_LEVELS,
  CONTENT_TRUST_LEVELS,
  classifyContentSecurity,
  deriveContentSecurity,
  toContextSecurityFields,
} from './content-trust.js'

export type {
  ContentSecurityInput,
  ContentSecurityMetadata,
  ContextSecurityFields,
  DerivedContentSecurityInput,
  ImmutableProvenance,
  SecurityClassificationReason,
  SecurityOrigin,
  SecuritySensitivity,
  SecurityTrust,
} from './types.js'

export {
  INSTRUCTION_BOUNDARY_RULES,
  analyzeInstructionRisk,
  frameContextItem,
  frameExternalText,
  frameInstructionData,
} from './instruction-firewall.js'

export type {
  FramedInstructionData,
  InstructionRiskKind,
  InstructionRiskSignal,
} from './instruction-firewall.js'
