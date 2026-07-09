---
{
  "schemaVersion": "web-buddy-skill/v1",
  "id": "web-buddy.site-alibaba-careers",
  "name": "Alibaba Careers Site",
  "scope": "builtin",
  "priority": 200,
  "triggers": {
    "domains": ["talent.alibaba.com", "jobs.alibaba.com", "campus.alibaba.com"],
    "urlPatterns": ["*alibaba.com/career*", "*alibaba.com/job*", "*alibaba.com/position*"]
  },
  "provides": {
    "promptSections": ["SAFETY_RULES"],
    "policyHints": true
  },
  "policyHints": [
    {
      "id": "alibaba-entry-checkbox",
      "action": "hint",
      "reason": "Alibaba detail pages may require an application notice checkbox before the entry button."
    }
  ],
  "promptSections": [
    {
      "id": "SAFETY_RULES",
      "summary": "- On Alibaba position-detail pages, if a small checkbox says 申请此职位表明您已阅读并同意 / 申请工作需知 next to 投递简历, check that box before clicking 投递简历. This is an application-entry precondition, not permission to click a true final submit button later.\n- Application-entry buttons such as 投递简历/立即投递/Apply may open the application flow; do not treat seeing that button as task completion. Stop only before true final submission controls such as 确认投递/提交申请/final submit."
    }
  ]
}
---

Alibaba Careers site overlay. It can explain entry preconditions but cannot relax final-submit gates.

