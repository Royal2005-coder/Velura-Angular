# Workspace entry point for Atlas users and agents

Read [AGENTS.md](AGENTS.md), [TEAM-WORKFLOW](docs/TEAM-WORKFLOW.md),
[ATLAS-CLI](docs/ATLAS-CLI.md) and [HOW-IT-WORKS](docs/HOW-IT-WORKS.md) before work.

Atlas is discovery/OIDC, not Jira and not a replacement for Flux. Do not invent
commands or assume another advertised cluster is Velura. Feature work branches
from develop; production changes reach main through green PRs and signed pins.
Role boundaries, UI redesign contracts, integration and rollback are defined in
the shared team workflow; do not create a separate agent-specific release process.
