<!-- generated_by: agent-ready -->
<!-- adapter_target: docs:validation -->
<!-- source_checksum: 941532da205b6791 -->

# Validation

## Product Checks
- Contract: `agent-ready lint`
- Command plan: `agent-ready verify --dry-run`
- Diagnosis: `agent-ready doctor`
- Optimization plan: `agent-ready optimize --plan`
- Project gate: `agent-ready check`
- Strict local gate: `agent-ready check --ci`

## Required Project Commands
- check: `pnpm check`
- windows-smoke: `pnpm smoke:windows`

## Optional Lab
- Enable: `agent-ready lab init`
