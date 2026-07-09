---
{
  "schemaVersion": "web-buddy-skill/v1",
  "id": "web-buddy.task-job-apply",
  "name": "Task Job Apply",
  "scope": "builtin",
  "priority": 110,
  "triggers": {
    "taskTypes": ["apply_entry", "fill_form", "final_review"]
  },
  "provides": {
    "promptSections": ["SAFETY_RULES", "NEXT_ACTION_RULES"],
    "policyHints": true,
    "completionCriteria": true
  },
  "policyHints": [
    {
      "id": "job-apply-entry-is-not-final-submit",
      "action": "hint",
      "reason": "Application-entry buttons may open a flow, but true final submit remains gated."
    }
  ],
  "completionCriteria": [
    {
      "id": "stop-at-final-submit-boundary",
      "kind": "site_boundary",
      "description": "For job applications, completion may be blocked at a true final-submit boundary.",
      "evidenceKeys": ["page.submitCandidates", "workflowState.phase"],
      "severity": "warn"
    }
  ],
  "promptSections": [
    {
      "id": "SAFETY_RULES",
      "summary": "- It is OK to click a job-detail entry button such as 投递简历/Apply only when it merely opens the login/application flow and does not send the completed application.\n- If the task context provides a current resume file path, an existing on-site resume is NOT sufficient by itself. Prefer uploading the current resume file first, through browser_upload_file, before continuing the application flow unless the human explicitly says to reuse the existing on-site resume."
    },
    {
      "id": "NEXT_ACTION_RULES",
      "summary": "If TASK_STATE/WORKFLOW_STATE says currentResumeUploaded=false or current resume has not been uploaded, prioritize profile/resume/application upload controls (个人中心, 我的简历, 简历管理, 上传, 重新上传, 附件简历, resume, CV, upload), inspect with browser_form_snapshot, then use browser_upload_file with the current task resume path; after upload, save required changes and continue past application-entry buttons such as 投递简历/立即投递/Apply until a true final-submit boundary."
    }
  ]
}
---

Job application task overlay. This skill does not authorize final submission.

