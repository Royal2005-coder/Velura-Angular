# UserNg

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.23.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.

## Storefront image and member workflows

- Header camera and catalog camera use `VisualSearchWorkbench`. Confirm one garment after upload, drop, paste, capture or local crop. Only server similarity matches restrict the catalog; zero matches remain an empty result set. Featured suggestions are separately labelled and never added to match IDs. Attribute/keyword refinement uses a source-free token, not a second image upload.
- Save the Style Quiz to reach optional Personal Color, or open `/account/profile?tab=style-profile`. Four seasons are Spring, Summer, Autumn and Winter. Analysis is a preview until explicit server confirmation; a failed reanalysis keeps the last confirmed profile. Missing approved model, calibration, palette or retention policy disables analysis visibly.
- `/account/profile?tab=offers` shows the authenticated points wallet, expiry lots, ledger pagination and referral/reward history. Referral links prefill `/auth/signup`; attribution is registration-only. Spent reward reversals require manual review.
- Active checkout routes are `/checkout/user` and `/checkout/guest`. Member redemption uses the server quote's available points and cap; guests cannot redeem. Changed balance or disabled spending clears the request, reloads pricing and requires another order confirmation. No browser event awards points.
- Product detail passes the current product and exact color/size variant to try-on. Unsupported variants cannot upload or queue inference. Personal mode needs consent, server quality validation and a separate generation confirmation; studio mode needs a loaded server preview. Only successful server jobs supply result images.
- Chat uses the normal message API to request CSKH. Requested/assigned/closed handoff states suppress AI typing and new AI responses; the widget resumes the human session. HUMAN, AI and SYSTEM messages are labelled distinctly.

Staging prerequisites: authenticated API routes, migrations 050–054, licensed inference weights and a ready worker, approved Personal Color policy, and an approved points spending policy. A visible unavailable state is not production acceptance.

Visual smoke: keyboard-open the header camera, cancel camera permission, crop/upload and refine; verify zero matches versus featured suggestions; confirm color then fail reanalysis; view wallet and referral signup; redeem within the quoted cap then change the cart; switch try-on variants; request human chat and check no AI typing after takeover. Run these against staging with real services, not generated images or fabricated balances.
