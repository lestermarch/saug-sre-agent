# Manual Azure SRE Agent setup

This guide configures Azure SRE Agent manually for the biscuit service after the
demo workload has been deployed. It deliberately keeps agent onboarding outside
the workload's Bicep deployment so that the setup experience can form part of
the demonstration.

The portal and preview features described here were checked against Microsoft
Learn on 17 September 2026. Portal labels can change while Azure SRE Agent APIs
remain in preview.

## Recommended design

Use one Azure SRE Agent resource with two custom agents:

| Custom agent | Responsibility |
|---|---|
| `General Azure Operator` | Container Apps, deployments, application health, Azure Monitor, networking and GitHub-related incidents |
| `PostgreSQL Specialist` | PostgreSQL Flexible Server, Private Link, private DNS, database metrics, logs and safe read-only database checks |

The main SRE Agent remains available as the conversational orchestrator. The two
custom agents provide focused instructions and tool sets, while incident
response plans route each alert to the appropriate specialist.

This is preferable to deploying two separate SRE Agent resources for this demo:

- both specialists use the same code, logs, knowledge and incident connection
- investigations retain one conversation and audit history
- response plans can route incidents by severity and alert-title keywords
- the PostgreSQL specialist can be given a smaller, database-focused tool set
- the setup is easier for other people to reproduce

Custom agents in one SRE Agent resource share the resource's managed identity
and Azure RBAC assignments. Their selected tools and instructions reduce
operational scope, but they are not an identity or security boundary. Deploy
separate SRE Agent resources only when the specialists require genuinely
different Azure identities, RBAC scopes, networks, administrators or billing.

## Target environment

Use these values for the current demonstration, substituting your own deployed
environment when testing a fork:

| Setting | Value |
|---|---|
| Subscription | `ME-MngEnvMCAP580954-lestermarch-2` |
| Workload resource group | `rg-saug-sre-agent-se` |
| Region | `Sweden Central` |
| Repository | `lestermarch/saug-sre-agent` |
| SRE Agent subnet | `sre-agent-integration` |
| Subnet prefix | `10.20.3.0/27` |
| Subnet delegation | `Microsoft.App/environments` |

The Log Analytics workspace, virtual network and PostgreSQL server have generated
names. Select the resources in the workload resource group with the
`purpose=azure-sre-agent-demo-target` tag.

## 1. Prepare for onboarding

Before opening the setup wizard:

1. Deploy the workload and confirm the frontend biscuit search returns database
   results.
2. Confirm PostgreSQL public network access is disabled.
3. Confirm the `sre-agent-integration` subnet exists, is dedicated to SRE Agent,
   and is delegated to `Microsoft.App/environments`.
4. Confirm you have **Owner**, or **Contributor** plus **User Access
   Administrator**, where the agent and its role assignments will be created.
5. Decide which GitHub identity will authorize the public demo repository.
6. Keep the traffic simulator available for later incident tests:

   ```powershell
   .\scripts\Invoke-TrafficSimulator.ps1
   ```

The repository currently sends Container Apps platform and application console
logs to Log Analytics. It does not currently provision Application Insights or
Azure Monitor alert rules. Complete the read-only agent tests first, then add
the alert rules used for the live incident scenarios.

## 2. Create the SRE Agent resource

1. Open [Azure SRE Agent](https://sre.azure.com).
2. Select **Create agent**.
3. Use the demo subscription.
4. Create a separate agent resource group, for example
   `rg-saug-sre-agent-control`.
5. Enter an agent name, for example `saug-biscuit-sre`.
6. Select **Sweden Central** so the agent is in the same region as the prepared
   VNet subnet.
7. Select an available model provider appropriate for the tenant's data
   residency requirements.
8. Create new Application Insights and Log Analytics resources for the agent's
   own telemetry unless shared monitoring is an intentional requirement.
9. Review and create the agent.
10. Confirm deployment succeeds and your account has **SRE Agent
    Administrator** on the new resource.

Keeping the agent in a separate resource group allows the demo workload to be
redeployed or deleted without implicitly deleting its operator.

## 3. Connect the workload context

On the **Set up your agent** page, use **Quickstart**.

### Code

1. On the **Code** card, select **Connect repositories**.
2. Select **GitHub** and use account authorization for the initial manual demo.
3. Select `lestermarch/saug-sre-agent`, or the fork being tested.
4. Save and confirm the Code card shows a green check.

Code Access supplies source and infrastructure context. If the code-remediation
scenario must create issues, pull requests or trigger workflows, also configure
**Builder > Connectors > GitHub OAuth connector**. Keep write operations subject
to approval and do not permit the agent to merge directly to `main`.

### Logs

1. On the **Logs** card, add **Log Analytics Workspace**.
2. Select the workspace in `rg-saug-sre-agent-se` tagged
   `purpose=azure-sre-agent-demo-target`.
3. Save the connector.
4. Confirm the portal grants the agent identity **Log Analytics Reader** and
   **Monitoring Reader** on the required scope.

### Azure resources

1. On the **Azure resources** card, select **Add resources**.
2. Choose **Resource group**.
3. Add only `rg-saug-sre-agent-se`.
4. Choose **Privileged** for the remediation demo.
5. Review the generated roles before confirming.

Privileged access is required for unattended or approved remediation using the
agent's managed identity. Reader access is sufficient for diagnosis, but an
autonomous incident cannot complete an on-behalf-of authorization prompt. Keep
resource read and write roles at the workload resource group rather than the
subscription. The portal can separately assign **Monitoring Contributor** at
subscription scope so the agent can acknowledge and close Azure Monitor alerts;
review this expected exception during setup.

## 4. Enable private-network access

1. Open **Settings > Workspace configuration > Network**.
2. Select **Azure VNet**.
3. Browse to the demo subscription and `rg-saug-sre-agent-se`.
4. Select the workload VNet and its `sre-agent-integration` subnet.
5. Save the configuration.
6. Enable the GitHub code-repository infra-network option so the VNet-integrated
   agent can still reach `github.com`.
7. Enable other public bypass categories only when a configured tool requires
   them.

This integration controls outbound traffic from the agent. It allows diagnostic
tools running in the agent workspace to reach the PostgreSQL private endpoint
through the VNet and private DNS. It does not create a private inbound endpoint
for SRE Agent, and connector traffic itself is not routed through the VNet.

Use **Settings > Workspace configuration > Inspect > Network audit** when a
tool reports that it cannot reach a host.

## 5. Apply global guardrails

Open **Settings > Permissions** and configure tool access policies before
creating autonomous workflows.

Recommended initial policy:

| Policy | Suggested scope |
|---|---|
| Allow | Azure read commands, log queries, metrics and resource-health tools |
| Ask | Azure write commands, GitHub write operations and deployment actions |
| Deny | Resource deletion, PostgreSQL public-access enablement and destructive database commands |

Keep both incident plans in **Review** mode during setup. A global deny is the
strongest ordinary tool-policy boundary; custom-agent and thread policies
cannot weaken it. Review any user-defined hooks carefully because an explicit
hook allow can override a tool-policy deny and is audit logged.

At minimum, preserve these demo invariants:

- never enable PostgreSQL public network access
- never delete the known-good Container Apps revision
- never delete the PostgreSQL server, private endpoint, private DNS zone or VNet
- never expose or print database credentials
- never merge directly to `main`
- prefer reversible configuration changes and revision rollback

## 6. Create the General Azure Operator

Go to **Builder > Agent Canvas**, select **Create > Custom Agent**, and use:

**Name**

```text
General Azure Operator
```

**Handoff description**

```text
Handles Azure Monitor incidents involving Container Apps, API availability,
deployments, application configuration, platform health, networking and source
code changes. Use the PostgreSQL Specialist for PostgreSQL, database
connectivity, Private Link or private DNS incidents.
```

**Instructions**

```text
You operate the Azure biscuit-service demo in its designated workload resource
group. Diagnose before changing anything. Correlate Azure Monitor alerts,
Container Apps revisions and probes, Log Analytics records, resource health and
the connected GitHub repository.

Distinguish these failure boundaries:
1. Frontend unavailable or unable to render.
2. Backend process unavailable while PostgreSQL may remain healthy.
3. Backend healthy but its PostgreSQL query path unavailable.
4. A bad code or configuration change introduced by a recent deployment.

Use read-only tools first and state the evidence, likely root cause, proposed
remediation, risk and rollback. In Review mode, wait for approval before write
actions. Preserve the known-good Container Apps revision. Never enable
PostgreSQL public access, delete workload resources, reveal secrets or merge
directly to main. Prefer restoring a known-good revision or configuration over
making broad infrastructure changes. Hand PostgreSQL, Private Link and private
DNS investigations to the PostgreSQL Specialist.
```

Select built-in tools for:

- Azure resource inventory and Resource Graph
- Azure Monitor alerts, metrics and resource health
- Log Analytics queries
- Container Apps diagnostics, revisions, replicas and configuration
- Azure CLI read commands
- Azure CLI write commands, subject to Review approval
- connected GitHub code search and file access

After the `PostgreSQL Specialist` has been created, edit this agent and select
it under **Handoff Agents**.

Do not add broad database write or arbitrary destructive shell tools.

## 7. Create the PostgreSQL Specialist

Create a second custom agent with:

**Name**

```text
PostgreSQL Specialist
```

**Handoff description**

```text
Handles Azure Database for PostgreSQL Flexible Server incidents, including
availability, metrics, connection failures, Private Link, private DNS, TLS,
authentication and safe read-only SQL diagnosis.
```

**Instructions**

```text
You are the PostgreSQL specialist for the Azure biscuit-service demo. The
PostgreSQL Flexible Server intentionally has public network access disabled.
The backend must reach it through its approved private endpoint and the
privatelink.postgres.database.azure.com private DNS zone.

Investigate in this order:
1. Confirm the backend liveness endpoint separately from database readiness and
   the /api/biscuits query path.
2. Check PostgreSQL resource health, server state, maintenance, CPU, memory,
   storage, connections and failed-connection metrics.
3. Check private endpoint provisioning and connection approval.
4. Check the private DNS zone, VNet link, DNS zone group and expected private
   address resolution.
5. Inspect backend logs for DNS, timeout, TLS, authentication and query errors.
6. Use read-only PostgreSQL queries only when a dedicated diagnostic credential
   and the approved psql read tool are available.
7. Identify the smallest reversible remediation and its rollback.

Never enable public network access, add a public firewall exception, disclose
credentials, modify application data, run destructive SQL, delete networking
resources or rotate credentials without explicit approval. In Review mode,
present evidence and wait for approval before any write action. Return control
to the General Azure Operator after database health and application
connectivity have been verified.
```

Select built-in tools for:

- PostgreSQL Flexible Server resource health, configuration and metrics
- Azure Monitor and Log Analytics queries
- Private Endpoint, private DNS and VNet inspection
- Azure CLI read commands
- narrowly required Azure CLI write commands, subject to Review approval
- `RunPsqlReadCommand` and `ValidatePsqlCommand`, if offered in the tenant's tool
  picker and configured with a dedicated read-only diagnostic login

Under **Handoff Agents**, select `General Azure Operator`.

Do not give this specialist an unrestricted SQL write tool. Do not place the
existing PostgreSQL administrator password in the instructions, knowledge base
or chat. The initial demo can diagnose the database failure through Azure
control-plane state, network configuration, metrics and backend logs without
direct SQL access. Add direct psql access only after creating a separate,
least-privilege database login and an approved secret-handling path.

## 8. Add a PostgreSQL troubleshooting skill

Go to **Builder > Skills** and create:

**Name**

```text
biscuit-postgres-private-link-troubleshooting
```

**Description**

```text
Use when the biscuit API reports that PostgreSQL is unreachable, readiness
returns HTTP 503, or an Azure Monitor alert mentions PostgreSQL, database,
Private Link, private endpoint or private DNS.
```

Use the PostgreSQL investigation sequence and safety invariants from the
specialist instructions as the skill procedure. Attach the read-only Azure,
monitoring, network and PostgreSQL tools selected for the specialist. Allow the
`PostgreSQL Specialist` to use this skill.

Keep the general instructions on the custom agent and the repeatable diagnostic
procedure in the skill. This demonstrates the distinction between a domain
specialist and an automatically loaded operational runbook.

## 9. Upload the system knowledge

Open **Settings > Knowledge Base > Files** and upload all three documents from
`docs/knowledge-base`:

1. `01-system-architecture.md`
2. `02-signals-and-failure-model.md`
3. `03-operations-and-recovery.md`

Allow both custom agents to use the knowledge source. Confirm the files finish
indexing before running the playground tests. The documents deliberately
contain no credentials and clearly distinguish the reusable logical design from
the generated names in the original deployment.

## 10. Test the custom agents before connecting alerts

Use **Builder > Agent Canvas > Test playground**.

Test the general agent:

```text
Inspect the biscuit-service workload resource group. Confirm both Container
Apps are healthy, identify the current active revisions, summarize recent
errors from Log Analytics, and make no changes.
```

Expected result:

- identifies the frontend and backend Container Apps
- reports liveness or revision state
- queries the connected Log Analytics workspace
- does not confuse database readiness with backend process liveness
- proposes no write action for a healthy environment

Test the PostgreSQL specialist:

```text
Verify the biscuit service's PostgreSQL connectivity design. Confirm public
network access is disabled, inspect the private endpoint and DNS configuration,
check recent database health signals and backend database errors, and make no
changes.
```

Expected result:

- confirms public access is disabled and treats that as correct
- finds the approved private endpoint
- finds the private DNS zone, VNet link and DNS zone group
- checks PostgreSQL and backend telemetry
- does not recommend a public firewall rule

Test handoff from the general agent:

```text
The backend is live but /health/ready and /api/biscuits return HTTP 503 with a
database error. Route this to the correct specialist and investigate without
making changes.
```

## 11. Connect Azure Monitor incidents

In the setup page, connect **Azure Monitor** as the incident platform. Connecting
an incident platform creates a quickstart response plan. Delete that quickstart
plan before enabling the custom plans, otherwise one alert can be processed
twice or routed to the wrong specialist.

Azure Monitor response plans can filter by severity and text in the alert title.
Use a naming contract for alert rules so routing is deterministic:

| Alert-title prefix | Handler |
|---|---|
| `[DEMO][FRONTEND]` | General Azure Operator |
| `[DEMO][API]` | General Azure Operator |
| `[DEMO][CODE]` | General Azure Operator |
| `[DEMO][POSTGRES]` | PostgreSQL Specialist |

Avoid a general catch-all plan because it would also match database incidents.
Create one response plan per title prefix where necessary.

In **Builder > Incident response plans**, create:

| Plan | Title contains | Custom agent | Initial mode |
|---|---|---|---|
| `demo-frontend-response` | `[DEMO][FRONTEND]` | General Azure Operator | Review |
| `demo-api-response` | `[DEMO][API]` | General Azure Operator | Review |
| `demo-code-response` | `[DEMO][CODE]` | General Azure Operator | Review |
| `demo-postgres-response` | `[DEMO][POSTGRES]` | PostgreSQL Specialist | Review |

Select the alert severities used by the demo and leave Azure Monitor's
reinvestigation cooldown enabled initially. Preview matching incidents before
creating each plan. Keep each plan turned off until its custom agent passes the
playground tests.

## 12. Run the end-to-end test

1. Start the traffic simulator and optionally save a CSV timeline.
2. Turn on only the response plan for the scenario being tested.
3. Introduce one documented, reversible failure.
4. Confirm the Azure Monitor alert title contains the expected routing prefix.
5. Confirm exactly one SRE Agent investigation thread is created.
6. Confirm the expected custom agent is selected.
7. Review its evidence, proposed remediation and rollback.
8. Approve the remediation only after checking it preserves the demo
   invariants.
9. Confirm the traffic simulator records recovery and outage duration.
10. Confirm the Azure Monitor alert resolves and the investigation records the
    successful verification.
11. Restore the known-good baseline manually if any step differs from the
    expected path.

Run API, PostgreSQL and code-change scenarios separately. Do not move a response
plan to **Autonomous** until the same failure and remediation have succeeded
repeatedly in Review mode and the tool audit shows only the intended actions.

## Acceptance checklist

- [ ] One SRE Agent resource exists in Sweden Central.
- [ ] The agent has code access to the selected repository.
- [ ] The workload Log Analytics workspace is connected.
- [ ] Azure scope is limited to the workload resource group.
- [ ] Azure VNet mode uses the dedicated `/27` subnet.
- [ ] GitHub remains reachable with VNet integration enabled.
- [ ] All three system knowledge documents are uploaded and indexed.
- [ ] Global policies deny destructive and public-database workarounds.
- [ ] General Azure Operator passes its read-only playground test.
- [ ] PostgreSQL Specialist passes its private-network playground test.
- [ ] The PostgreSQL skill loads for a database-connectivity prompt.
- [ ] The incident-platform quickstart plan has been removed.
- [ ] Alert titles follow the documented routing prefixes.
- [ ] Each test incident creates exactly one investigation.
- [ ] All response plans remain in Review mode for initial demonstrations.

## Microsoft documentation

- [Create and set up Azure SRE Agent](https://learn.microsoft.com/azure/sre-agent/create-and-set-up)
- [Custom agents](https://learn.microsoft.com/azure/sre-agent/sub-agents)
- [Skills](https://learn.microsoft.com/azure/sre-agent/skills)
- [Tools](https://learn.microsoft.com/azure/sre-agent/tools)
- [Agent permissions](https://learn.microsoft.com/azure/sre-agent/permissions)
- [Network integration](https://learn.microsoft.com/azure/sre-agent/network-integration)
- [Tool access policies](https://learn.microsoft.com/azure/sre-agent/tool-access-policies)
- [Incident response plans](https://learn.microsoft.com/azure/sre-agent/incident-response-plans)
- [Create an incident response plan](https://learn.microsoft.com/azure/sre-agent/response-plan)
- [GitHub connector](https://learn.microsoft.com/azure/sre-agent/github-connector)
