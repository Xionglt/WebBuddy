---
{
  "schemaVersion": "web-buddy-skill/v1",
  "id": "web-buddy.core-safety",
  "name": "Core Safety",
  "scope": "builtin",
  "priority": 0,
  "autoload": true,
  "provides": {
    "promptSections": ["SAFETY_RULES"],
    "policyHints": true
  },
  "hardRules": [
    {
      "invariant": "no_final_submit",
      "gateKind": "final_submit",
      "action": "gate",
      "cannotBeOverridden": true,
      "reason": "Final application submission remains a runtime-gated human boundary."
    },
    {
      "invariant": "no_auto_login",
      "gateKind": "login",
      "action": "gate",
      "cannotBeOverridden": true,
      "reason": "Human-only credentials and login handoffs must not be bypassed by skills."
    },
    {
      "invariant": "no_auto_captcha",
      "gateKind": "captcha",
      "action": "gate",
      "cannotBeOverridden": true,
      "reason": "Captcha and human-verification flows require handoff."
    }
  ],
  "policyHints": [
    {
      "id": "core-final-submit-boundary",
      "action": "gate",
      "gateKind": "final_submit",
      "invariant": "no_final_submit",
      "reason": "Stop before true final submission controls."
    }
  ],
  "promptSections": [
    {
      "id": "SAFETY_RULES",
      "summary": "- NEVER submit a final application. If you reach the final submit/确认投递/提交申请 button on an application form, do NOT click it; call agent_done with blocked=true.\n- For any element marked risk=L3 or risk=L4, the human must approve before the action runs; you may still request it because the system gates it.\n- If you hit a login wall or captcha you cannot pass, call agent_done with blocked=true and explain."
    }
  ]
}
---

Core safety prompt and policy hints for browser automation. Runtime policy remains authoritative.

