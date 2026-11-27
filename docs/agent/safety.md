<!-- generated_by: agent-ready -->
<!-- adapter_target: docs:safety -->
<!-- source_checksum: 941532da205b6791 -->

# Safety

## Default Posture
- Agent-first does not mean unrestricted execution.
- Prefer dry-run verification before executing project commands.
- Do not print secrets, edit generated files, or change CI/deploy paths without explicit approval.

## Sensitive Paths
- .env*
- .local-data/**
- .tmp/**
- .harness-backups/**
- .github/workflows/**

## Readonly Paths
- node_modules/**
