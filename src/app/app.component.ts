/**
 * Root Application Component
 */

import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

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
}
