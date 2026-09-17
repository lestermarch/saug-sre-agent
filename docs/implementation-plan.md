# Implementation plan

## 1. Objective

Build a small, observable Azure workload that can later be connected to Azure SRE Agent for a live remediation demo. The workload is a humorous but accessible mock GOV.UK service backed by an API and PostgreSQL.

This plan covers the target environment only. It explicitly excludes deploying, onboarding or granting permissions to Azure SRE Agent.

## 2. Target architecture

```text
Internet
   |
   v
Frontend Container App (public HTTPS)
   |
   | HTTPS /api/status
   v
Backend Container App (public HTTPS for demo visibility)
   |
   | PostgreSQL/TLS, private DNS resolution
   v
PostgreSQL private endpoint ---- Azure PostgreSQL Flexible Server
             |
             +---- Private DNS zone: privatelink.postgres.database.azure.com

Both apps -> Azure Container Registry (managed-identity pull)
Both apps -> Log Analytics through the Container Apps environment
```

The Container Apps environment is injected into a dedicated `/23` subnet. PostgreSQL uses its public-access networking mode with `publicNetworkAccess` set to `Disabled`; a private endpoint in a separate subnet is its only application data path. The VNet link to the PostgreSQL private DNS zone lets the backend resolve the normal server FQDN to the endpoint's private address.

## 3. Repository structure

| Path | Purpose |
|---|---|
| `azure.yaml` | Defines the two deployable `azd` services |
| `infra/main.bicep` | Provisions networking, registry, monitoring, Container Apps and PostgreSQL |
| `infra/main.parameters.json` | Maps `azd` environment values into Bicep parameters |
| `src/frontend/` | Express/Nunjucks frontend using the versioned `govuk-frontend` package |
| `src/backend/` | Express API, PostgreSQL access, seed data and health endpoints |
| `docs/implementation-plan.md` | Delivery and validation plan |

## 4. Delivery phases

### Phase A - Bootstrap and local baseline

1. Establish the repository layout and `azd` service definitions.
2. Implement the frontend and backend as independently runnable Node services.
3. Add deterministic tests for page rendering, fallback behaviour, API responses and health endpoints.
4. Build both Docker images locally and run smoke tests against their published ports.

Exit criteria:

- Both test suites pass.
- Both images build and run as non-root users.
- The frontend renders with JavaScript disabled and uses local GOV.UK assets.
- The backend operates in explicit mock mode when `DATABASE_URL` is absent.

### Phase B - Azure infrastructure

1. Provision a Log Analytics workspace.
2. Provision an Azure Container Registry with anonymous and admin access disabled.
3. Create one user-assigned managed identity and grant it `AcrPull` on the registry.
4. Create the VNet with:
   - `10.20.0.0/23` delegated to the Container Apps environment.
   - `10.20.2.0/24` for private endpoints, with private endpoint policies disabled.
   - `10.20.3.0/27` reserved exclusively for future Azure SRE Agent VNet integration and delegated to `Microsoft.App/environments`.
5. Create the VNet-integrated Container Apps environment.
6. Create PostgreSQL Flexible Server 16, its application database and a seven-day backup policy.
7. Disable PostgreSQL public network access.
8. Create the PostgreSQL private endpoint, private DNS zone, VNet link and DNS zone group.
9. Create the backend and frontend Container Apps with single-revision mode, HTTPS-only ingress, probes, bounded scaling and Log Analytics integration.

Exit criteria:

- Bicep compiles without errors.
- An Azure deployment what-if contains no unintended public PostgreSQL access or unrelated resources.
- The backend receives its database connection string through a Container Apps secret.
- Container images are pulled from ACR using managed identity rather than registry credentials.

### Phase C - Deployment and known-good validation

1. Select an Azure subscription and region supported by Container Apps and PostgreSQL Flexible Server.
2. Store a strong PostgreSQL administrator password in the local `azd` environment.
3. Run `azd provision --preview`, review the changes, then run `azd up`.
4. Confirm `azd` builds, pushes and deploys both images to their tagged Container Apps.
5. Verify:
   - Frontend `/health/live` and `/health/ready`.
   - Backend `/health/live`, `/health/ready` and `/api/status`.
   - The frontend searches biscuit records sourced from PostgreSQL and separately displays API and database connectivity.
   - PostgreSQL has no public network path.
   - The PostgreSQL FQDN resolves privately from the Container Apps environment.
   - Application and platform logs arrive in Log Analytics.
6. Record the resource group, frontend URL, backend URL and known-good Container App revisions.

Exit criteria:

- The public site loads over HTTPS.
- The API returns `source: database`.
- Readiness probes are healthy.
- Direct public access to PostgreSQL fails as expected.

### Phase D - GitHub delivery path

Add a GitHub Actions workflow after the base environment is proven. It should authenticate to Azure through GitHub OIDC, run tests and Bicep validation, then use `azd deploy` for merges to the protected demo branch. Do not store Azure credentials or the database password in the repository.

This path exists so a later deliberately bad application change can reach a new Container Apps revision. Azure SRE Agent configuration remains outside this repository and outside this plan.

## 5. Demo failure seams

Failure injection is a separate, reversible demo-preparation activity. The healthy baseline must be captured first.

| Scenario | Controlled fault | Expected evidence | Recovery target |
|---|---|---|---|
| API/container | Set an invalid backend setting, deploy a crashing image or break the readiness route | Failed revision, probe failures, console logs and frontend degraded state | Restore configuration or healthy revision |
| Database/private network | Break the private DNS link/zone group or otherwise deny the backend's private path | Backend readiness `503`, PostgreSQL connection errors and private DNS/network evidence | Restore private endpoint name resolution/connectivity |
| GitHub code change | Merge a small defect that changes the frontend/API response or causes a runtime failure | Commit and workflow history, new revision and application error telemetry | Revert/fix the commit and redeploy |

Guardrails for all three scenarios:

- Use scripted or documented reversible changes.
- Never delete the known-good revision during the demo.
- Do not weaken PostgreSQL public access as a workaround.
- Avoid faults that alter subscription-wide policy, shared networking or unrelated resources.
- Define a manual recovery command before introducing each fault.

## 6. Observability contract

The workload exposes intentionally simple signals for diagnosis:

- Liveness endpoints show whether each process is running.
- Readiness endpoints show whether required downstream dependencies are usable.
- API responses identify whether biscuit data came from PostgreSQL, local mock mode or a database error.
- The frontend distinguishes an unreachable API from a reachable API whose PostgreSQL dependency has failed.
- Structured JSON request and dependency errors are written to stdout for Container Apps log collection.
- Container Apps revision and probe state provides platform-level evidence.
- PostgreSQL and Private Link resource health provides the data-layer evidence.

Application Insights and richer dashboards can be added later if the demo needs distributed tracing; they are not required for the first inexpensive baseline.

## 7. Security and cost decisions

- PostgreSQL public network access is disabled and no firewall allow-list is created.
- Database traffic requires TLS and uses the private endpoint.
- ACR admin and anonymous access are disabled.
- Container image pulls use managed identity and least-privilege `AcrPull`.
- Secrets are supplied through `azd`/Container Apps configuration, not committed files.
- HTTPS-only ingress is enforced.
- Burstable PostgreSQL, Basic ACR and Consumption Container Apps keep the demo inexpensive.
- Minimum replicas are one to keep the live demonstration predictable; set them to zero between events if cold starts are acceptable.

## 8. Out of scope

- Azure SRE Agent deployment, onboarding, RBAC, network access or GitHub connection.
- Production-grade identity for application users.
- Multi-region failover, zone redundancy, WAF, custom domains and formal disaster recovery.
- Permanent chaos tooling or autonomous failure injection.

## 9. Definition of done

The environment is ready for later Azure SRE Agent onboarding when:

- Infrastructure and application tests pass in CI.
- `azd up` creates both Container Apps, ACR, monitoring, VNet and private PostgreSQL resources.
- The frontend shows the mock public service and database-backed status.
- The API-to-database path works only through Private Link.
- Logs, health probes and revision history make each planned fault diagnosable.
- The baseline can be redeployed or restored without Azure SRE Agent.
