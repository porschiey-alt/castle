/**
 * Root Application Component
 */

import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  styles: [`
    :host {
      display: block;
      height: 100dvh;
      width: 100vw;
      overflow: hidden;
    }
  `]
})
export class AppComponent {
  title = 'Castle';
  private themeService = inject(ThemeService);
}
