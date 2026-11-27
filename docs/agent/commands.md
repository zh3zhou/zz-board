<!-- generated_by: agent-ready -->
<!-- adapter_target: docs:commands -->
<!-- source_checksum: 941532da205b6791 -->

# Commands

## Command Prefix
- Installed package: `agent-ready`; project-local install: `npx --no-install agent-ready`.

## Project Commands
- install: `pnpm install --frozen-lockfile`
- dev: `pnpm dev`
- start: `pnpm start`
- build: `pnpm build`
- desktopDev: `pnpm desktop:dev`
- desktopBuild: `pnpm desktop:build`
- desktopSmoke: `pnpm desktop:smoke`
- typecheck: `pnpm typecheck`
- test: `pnpm test`
- testIntegration: `pnpm test:e2e`
- validateSkill: `pnpm validate:skill`
- validateInstalledSkill: `pnpm validate:skill:installed`
- previewSkillSync: `pnpm sync:skill`
- smoke: `pnpm smoke:windows`
- boardCli: `pnpm board -- status`
- syncJobs: `pnpm board -- sync jobs`
- skinCli: `pnpm skin -- validate <source>`
- check: `pnpm check`
- setupWindows: `pnpm setup:windows`
- buildWindows: `pnpm setup:windows -- -Build`
- desktopStatus: `pnpm setup:windows -- -Status`
- deployFromSource: `pnpm setup:windows -- -Build -Deploy -Start`
- skinInit: `pnpm skin -- init <new-source> --id <id> --name <name>`
- cloudbasePackage: `pnpm cloudbase:package`
- cloudbasePlan: `pnpm cloudbase:plan`
- cloudbaseSmoke: `pnpm cloudbase:smoke -- --help`

## Agent-Ready
- Scan: `agent-ready scan --json`
- Diagnose: `agent-ready doctor`
- Plan: `agent-ready optimize --plan`
- Check: `agent-ready check`
- Strict local check: `agent-ready check --ci`
- Optional lab: `agent-ready lab init`
