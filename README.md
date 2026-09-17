# Azure SRE Agent demo environment

This repository is the foundation for a mock public-service demo that Azure SRE Agent can operate against. The environment is intentionally designed to show three common failure classes:

- API issue caused by an unhealthy dependency or misconfiguration
- Database issue caused by private networking or PostgreSQL availability problems
- Code issue caused by a bad GitHub commit reaching the live deployment

The repository contains a Vue- or simple HTML-style public service experience, a separate backend API, and an Azure PostgreSQL Flexible Server configured with public network access disabled and private endpoint connectivity.

The goal is to deploy the infrastructure and application stack, without deploying Azure SRE Agent itself. Azure SRE Agent is left to the later demo phase.

## Architecture

- Frontend: Azure Container App with public ingress, simple GOV.UK-inspired web experience
- Backend API: Azure Container App that exposes application data and calls PostgreSQL over the private network
- Database: Azure Database for PostgreSQL Flexible Server with public access disabled and a private endpoint in the VNet
- Network: one VNet with a Container Apps infrastructure subnet and a private endpoint subnet

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

## Azure deployment

This repo includes an `azd` project definition. To provision the environment:

```bash
azd up
```

Azure SRE Agent is deliberately not configured here; this repo is only the environment to be managed later in the demo pipeline.

## Demo story

The public-facing site is deliberately styled like a very important government service, with humorous content that makes the importance feel absurdly overblown. The API and database are intentionally simple but realistic enough for Azure SRE Agent to inspect, diagnose, and fix.

The demo environment is not a full production system; it is a safe simulated environment for observability and remediation exercises.
