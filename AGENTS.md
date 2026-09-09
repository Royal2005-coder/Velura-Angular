<Context>
  <Philosophy>
    This project is a production Angular workspace extracted from Velura.
    It rejects shortcuts in favor of explicit MVVM, OOP, and Clean Architecture.
    Maintainability, typed contracts, and reviewable merge requests come before speed.
  </Philosophy>
  <Scope>
    Two Angular 21 standalone SPAs and one Node HTTP API, split across two teams:
    Storefront (`apps/user-ng`) and Admin (`apps/admin-ng` + `apps/api`).
  </Scope>
</Context>

<Architecture>
  <Frontend_Pattern>
    MVVM + Signals. Templates are Views. Components are ViewModels.
    Services/repositories are the Model. Components never call HTTP directly
    from templates and never use `any`.
  </Frontend_Pattern>
  <Backend_Pattern>
    Router parses HTTP into commands. Services own business rules.
    Repositories own Supabase/SQL. Domain errors are mapped before the router.
  </Backend_Pattern>
</Architecture>

<Constraints>
  <DO>
    - Standalone Angular components and Signals for derived state
    - JSDoc on every public TypeScript method; Python-style docstrings in JS services
    - Smart containers vs presentational components
    - Design tokens / shared CSS only — no hardcoded hex in new component SCSS
    - Feature branch `feature/KAN-n-*` → Merge Request with Jira key → CI tests → merge `main` → production
    - See `docs/TEAM-PROCESS.md` and `docs/ANGULAR-STANDARDS.md`
  </DO>
  <DO_NOT>
    - NgModules
    - Logic in templates (`{{ data.filter(...) }}`)
    - ORM entities or service-role keys in the browser
    - Commit `.env`, `*.pem`, or deploy keys
    - Deploy from a feature branch
  </DO_NOT>
</Constraints>
