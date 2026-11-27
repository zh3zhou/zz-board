<!-- generated_by: agent-ready -->
<!-- adapter_target: docs:known-failures -->
<!-- source_checksum: 941532da205b6791 -->

# Known Failures

## Missing Project Contract
Symptom: `agent-ready lint` reports missing `agent.project.yaml`.
Fix: run `agent-ready init`.

## Adapter Drift
Symptom: generated files contain an old source checksum.
Fix: run `agent-ready generate`.

## Command Drift
Symptom: docs mention a command that is absent from `package.json`.
Fix: update `agent.project.yaml`, package scripts, or docs so they agree.

## Unsupported YAML Shape
Symptom: `agent-ready lint` reports that `agent.project.yaml` must be valid JSON or supported YAML.
Fix: use nested maps, lists, scalars, comments, and simple inline arrays; avoid anchors, aliases, merge keys, block scalars, custom tags, document markers, and advanced YAML features in the zero-dependency parser.
