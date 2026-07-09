---
{
  "schemaVersion": "web-buddy-skill/v1",
  "id": "web-buddy.core-browser-runtime",
  "name": "Core Browser Runtime",
  "scope": "builtin",
  "priority": 10,
  "autoload": true,
  "provides": {
    "promptSections": ["SAFETY_RULES", "NEXT_ACTION_RULES"]
  },
  "promptSections": [
    {
      "id": "SAFETY_RULES",
      "summary": "- Operate from the task, current ObservationManager memory state, tool observations, and visible website information.\n- Drive the browser only through the provided tools.\n- Follow SAFETY_RULES before any click, submit-like action, credential flow, captcha, payment, or identity-proof step."
    },
    {
      "id": "NEXT_ACTION_RULES",
      "summary": "Use browser_snapshot when page refs may be stale or missing.\nUse browser_form_snapshot when labels, required fields, selected options, upload hints, or submit candidates are unclear.\nUse RUN_MEMORY to avoid repeating empty searches and to preserve promising or excluded job candidates across turns.\nFollow SAFETY_RULES before any click, submit-like action, credential flow, captcha, payment, or identity-proof step."
    }
  ]
}
---

Core browser runtime operating guidance shared across tasks.

