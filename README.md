# Azure SRE Agent demo environment

This repository is the foundation for a mock public-service demo that Azure SRE Agent can operate against. The environment is intentionally designed to show three common failure classes:

- API issue caused by an unhealthy dependency or misconfiguration
- Database issue caused by private networking or PostgreSQL availability problems
- Code issue caused by a bad GitHub commit reaching the live deployment

The repository contains a GOV.UK-style public service experience, a separate backend API, and an Azure PostgreSQL Flexible Server configured with public network access disabled and private endpoint connectivity.

The goal is to deploy the infrastructure and application stack, without deploying Azure SRE Agent itself. Azure SRE Agent is left to the later demo phase.

## Architecture

- Frontend: Azure Container App with public ingress and a GOV.UK Frontend search experience
- Backend API: Azure Container App that searches a humorous government biscuit register in PostgreSQL
- Database: Azure Database for PostgreSQL Flexible Server with public access disabled and a private endpoint in the VNet
- Network: one VNet with Container Apps, private endpoint, and reserved Azure SRE Agent integration subnets

## Repo layout

- `infra/` – Bicep definitions for Azure networking, Container Apps environment, and PostgreSQL
- `src/frontend/` – mock public service frontend application
- `src/backend/` – API service with PostgreSQL connectivity and health status endpoint
- `docs/implementation-plan.md` – phased implementation plan for the demo environment

## Local development

```bash
# Frontend
cd src/frontend
npm install
npm start

# Backend
cd ../backend
npm install
npm start
```

Set environment variables for either local development or Azure deployment:

```bash
export PORT=8080
export BACKEND_URL=http://localhost:8081
export DATABASE_URL="postgresql://pgadmin:ChangeMe123!@localhost:5432/appdb?sslmode=disable"
```

The home page performs a live biscuit search through the API. Two connection indicators make the failure boundary explicit:

- **API available** means the frontend can reach the backend Container App.
- **Database reachable** means the API successfully queried PostgreSQL over Private Link.

The database is seeded automatically with fictional biscuit holdings across government departments and offices.

## Azure deployment

This repo includes an `azd` project definition. To provision the environment:

```bash
azd up
```

Azure SRE Agent is deliberately not configured here; this repo is only the environment to be managed later in the demo pipeline.

## Traffic simulator

Use the PowerShell traffic simulator to continuously exercise the public page, API liveness endpoint and database-backed biscuit search:

```powershell
.\scripts\Invoke-TrafficSimulator.ps1
```

The script uses the selected `azd` environment's `FRONTEND_URL` and `BACKEND_URL` values by default. Each request prints a timestamp, response time and HTTP result in green for up or red for down. When an endpoint recovers, it prints the measured outage duration.

Useful options:

```powershell
# One pass for a quick health check
.\scripts\Invoke-TrafficSimulator.ps1 -Once

# Generate traffic every 2 seconds for 30 minutes and save evidence
.\scripts\Invoke-TrafficSimulator.ps1 `
  -IntervalSeconds 2 `
  -DurationMinutes 30 `
  -LogPath .\traffic-results.csv

# Monitor explicitly supplied URLs
.\scripts\Invoke-TrafficSimulator.ps1 `
  -FrontendUrl https://frontend.example.gov.uk `
  -BackendUrl https://api.example.gov.uk
```

The three checks intentionally isolate the failure boundary:

- **Frontend** confirms the GOV.UK page renders.
- **API** confirms the backend process responds independently of PostgreSQL.
- **Database search** confirms the API can query PostgreSQL through Private Link.

## Demo story

The public-facing site is deliberately styled like a very important government service, with humorous biscuit inventory content. Search filters exercise the complete frontend-to-API-to-private-database path, making API and database incidents immediately visible.

The demo environment is not a full production system; it is a safe simulated environment for observability and remediation exercises.
