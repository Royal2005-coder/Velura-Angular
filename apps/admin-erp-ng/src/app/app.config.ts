import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { TitleStrategy, provideRouter, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { adminErpAuthInterceptor } from './core/admin-erp-auth.interceptor';
import { AdminErpTitleStrategy } from './core/admin-erp-title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideHttpClient(withInterceptors([adminErpAuthInterceptor])),
    { provide: TitleStrategy, useClass: AdminErpTitleStrategy },
  ],
};
