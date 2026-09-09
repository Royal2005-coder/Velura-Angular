## Jira
- Key: KAN-___
- Team: Storefront (`user-ng`) / Admin (`admin-ng` + `api`)
- Link: https://webadvance.atlassian.net/browse/KAN-___

## Summary
- What changed and why

## Architecture
- [ ] View/ViewModel stays HTTP-free (Signals in the component, HTTP in services)
- [ ] No `any`; public methods have JSDoc
- [ ] Domain/API contracts unchanged or documented

## Test plan
- [ ] Local: `npm run start:api` + `npm run start:admin` (4001) + `npm run start:user` (4002)
- [ ] Compared against vanilla source of truth where this feature exists
- [ ] Empty / error / pagination states checked

## Production
This MR **must not** deploy. Production runs only after merge to `main`.
Mention the Jira key (`KAN-12`) in the title so GitLab comments and the Jira development panel stay in sync.
