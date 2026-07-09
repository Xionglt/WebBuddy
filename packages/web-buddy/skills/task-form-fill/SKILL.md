---
{
  "schemaVersion": "web-buddy-skill/v1",
  "id": "web-buddy.task-form-fill",
  "name": "Task Form Fill",
  "scope": "builtin",
  "priority": 100,
  "triggers": {
    "taskTypes": ["fill_form", "final_review"]
  },
  "provides": {
    "promptSections": ["SAFETY_RULES", "NEXT_ACTION_RULES"],
    "completionCriteria": true
  },
  "completionCriteria": [
    {
      "id": "required-fields-not-pending",
      "kind": "required_evidence",
      "description": "Required fields should be filled or have an explicit blocker before completion.",
      "evidenceKeys": ["fillLedgerSummary.pendingRequired", "form.missingRequired"],
      "severity": "block"
    }
  ],
  "promptSections": [
    {
      "id": "SAFETY_RULES",
      "summary": "- Fill fields from FILL_PLAN first. When a field cannot be mapped, call resume_query for the full resume section or ask_user for missing information before leaving it blank; only leave a field untouched when no resume, derived, or user-answer source exists."
    },
    {
      "id": "NEXT_ACTION_RULES",
      "summary": "If FILL_PLAN is missing or stale on a fillable form, call plan_form_fill before setting fields.\nWhen FILL_PLAN has a fillable intendedValue, write it into the matching field first; prefer browser_set_field when available, otherwise use browser_fill_by_label, browser_type, browser_select, or browser_select_by_text as appropriate.\nIf a field lacks resume details beyond RESUME_SUMMARY, call resume_query for the relevant full resume section before leaving it blank.\nIf a field needs information that is not in the resume and cannot be inferred from the page, call ask_user with the planned question before filling it.\nDo not call agent_done while FillLedger shows pendingRequired fields unless you are blocked and explain exactly which required fields remain."
    }
  ]
}
---

Form filling guidance and completion criteria.

