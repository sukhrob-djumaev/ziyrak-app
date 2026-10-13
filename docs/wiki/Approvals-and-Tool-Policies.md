# Approvals and Tool Policies

Owly's AI can take actions during a conversation — creating tickets, sending internal emails, triggering webhooks (see [AI Tool System](AI-Tool-System)). **Tool policies** let you decide what the AI may do on its own, and **approvals** let a person check the actions you want reviewed before they run.

Both live on one page: **Approvals** in the sidebar (under *Team*).

---

## Approvals

When the AI asks to run a tool that needs human approval, nothing happens yet. The request appears under **Waiting**, and the sidebar shows a count badge.

For each request you see the action, who asked (usually the AI assistant), how long ago, a link to the conversation, and **Show details** with the information the AI wants to use. Anything that looks like a credential (a field named `password`, `token`, `apiKey`, …) is always masked.

- **Approve** runs the action now. You are asked to confirm first, because it may send messages or change data. The result is shown, and the request moves to **History** as *Done* or *Failed* (with the reason).
- **Reject** means the action never runs. It moves to **History** as *Rejected*.

If a colleague decides first, you are told it was already handled. The page and the badge update on their own as requests arrive.

**Who can review:** supervisors, admins and owners.

---

## Policies

The **Policies** tab lists every AI tool with four controls. Changes save immediately and apply from the AI's next tool call.

| Control | What it does |
|---------|--------------|
| **Available** | Turns the tool off for everyone (the AI and your team). |
| **AI may use it** | Lets the AI call the tool during a conversation. |
| **Needs human approval** | Each time the AI wants to use the tool, a person must approve it first (it appears under **Waiting**). Approval applies to the AI's requests; a team member running a tool by hand is not asked. |
| **Team roles that may run it by hand** | Which roles (agent, supervisor, admin, owner) may run the tool themselves. |

A tool you have changed is marked **Customised**, with **Reset to default**. A tool still on its default settings is not marked, even if it has been saved before.

**Who can change policies:** admins and owners. Supervisors can view them but not change them. Every change is recorded in the **Activity Log** with who made it, what changed and the previous values, and changes that give the AI or more people extra power are flagged.

### A sensible starting point

- Leave low-risk tools (`create_ticket`, `get_customer_history`) as they are.
- Turn on **Needs human approval** for anything that contacts someone or reaches outside Owly, such as `send_internal_email` or `trigger_webhook`, until you trust how the AI uses it.

---

## Related pages

- [AI Tool System](AI-Tool-System) — what each tool does
- [Team and Departments](Team-and-Departments) — roles and permissions
