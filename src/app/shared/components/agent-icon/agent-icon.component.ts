/**
 * AgentIconComponent — Shared component that renders either a Material Icon
 * (for "mat:icon_name" values) or an emoji span, with a smart_toy fallback.
 */

import { Component, input, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { isMatIcon, getMatIconName } from '../../../../shared/utils/icon.utils';

@Component({
  selector: 'app-agent-icon',
  standalone: true,
  imports: [MatIconModule],
  template: `
    @if (icon() && isMat()) {
      <mat-icon>{{ matName() }}</mat-icon>
    } @else if (icon()) {
      <span class="emoji-icon">{{ icon() }}</span>
    } @else {
      <mat-icon>smart_toy</mat-icon>
    }
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; justify-content: center; color: inherit; }
    mat-icon { color: inherit; }
    .emoji-icon { line-height: 1; }
  `]
})
export class AgentIconComponent {
  icon = input<string | undefined>();

  isMat = computed(() => {
    const v = this.icon();
    return !!v && isMatIcon(v);
  });

  matName = computed(() => {
    const v = this.icon();
    return v ? getMatIconName(v) : '';
  });
}
