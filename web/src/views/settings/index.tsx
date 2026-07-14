/**
 * Settings feature barrel. The router (`src/index.tsx`) lazy-loads each panel by
 * name and nests them under `SettingsLayout` (the eager admin sub-nav in
 * `./layout.tsx`). Panels live in sibling modules so this file stays a thin,
 * stable export surface:
 *
 *   /:owner/:repo/settings               → GeneralSettingsView
 *   /:owner/:repo/settings/collaborators → CollaboratorsSettingsView
 *   /:owner/:repo/settings/branches      → BranchesSettingsView
 *   /:owner/:repo/settings/webhooks      → WebhooksSettingsView
 *
 * Each panel gates itself behind an authenticated owner/maintainer session
 * (`AdminGate`) and calls the frozen admin api clients (collaboratorsApi /
 * branchProtectionApi / webhooksApi) plus reposApi for general settings.
 */
export { SettingsLayout } from "./layout.tsx";
export { GeneralSettingsView } from "./general.tsx";
export { CollaboratorsSettingsView } from "./collaborators.tsx";
export { BranchesSettingsView } from "./branches.tsx";
export { WebhooksSettingsView } from "./webhooks.tsx";
